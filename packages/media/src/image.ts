// Ресайз изображения в варианты (T1-20): webp по ширинам IMAGE_VARIANT_WIDTHS, без увеличения, с поворотом по
// EXIF Orientation и без метаданных (EXIF/GPS, XMP, IPTC, ICC — sharp не переносит их без keepMetadata()).
import sharp, { type OutputInfo } from "sharp";
import { IMAGE_VARIANT_WIDTHS, MAX_INPUT_PIXELS, mediaKeys, type MediaRejectReason } from "./constants.js";
import type { StorageDriver } from "./storage/types.js";

export interface ImageVariant {
  /** Ширина по каталогу (320/800/1600) — имя варианта; фактическая ширина может быть меньше (без увеличения). */
  name: `w${number}`;
  width: number;
  height: number;
  bytes: number;
}

export interface RenderedVariant extends ImageVariant {
  data: Buffer;
}

/** Файл нельзя обработать: причина — в media_assets.reject_reason. Повтор даст то же — без ретраев. */
export class ImageRejectError extends Error {
  override readonly name = "ImageRejectError";
  constructor(
    readonly reason: Extract<
      MediaRejectReason,
      "decode_failed" | "type_mismatch" | "dimensions_too_large" | "original_missing"
    >,
    message: string,
  ) {
    super(message);
  }
}

/** Формат sharp для допустимых типов фото: другой формат (SVG, GIF, TIFF, HEIF…) отклоняется, даже если декодируется. */
const SHARP_FORMAT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

const WEBP_QUALITY = 80;

/**
 * Режим sharp для процесса с малой памятью (api на Render free, ресайз inline): один поток libvips, без кеша
 * операций. Глобальная настройка процесса.
 */
export function configureSharpForLowMemory(): void {
  sharp.concurrency(1);
  sharp.cache(false);
}

export interface RenderOptions {
  /** Заявленный и проверенный по сигнатуре тип: формат по декодеру обязан совпасть. */
  expectedMime: string;
  /** Предел пикселей исходника (по умолчанию MAX_INPUT_PIXELS; inline — INLINE_MAX_INPUT_PIXELS). */
  maxPixels?: number;
  widths?: readonly number[];
}

/**
 * Варианты изображения в памяти. Исходник декодируется один раз — в самый большой вариант (raw), меньшие строятся из
 * него: в памяти не больше одного полного кадра. Ошибка — ImageRejectError с причиной.
 */
export async function renderVariants(
  source: Buffer,
  options: RenderOptions,
): Promise<{ width: number; height: number; variants: RenderedVariant[] }> {
  const maxPixels = options.maxPixels ?? MAX_INPUT_PIXELS;
  const widths = [...(options.widths ?? IMAGE_VARIANT_WIDTHS)].sort((a, b) => b - a);
  let meta;
  try {
    meta = await sharp(source).metadata();
  } catch (e) {
    throw new ImageRejectError("decode_failed", `Не изображение: ${(e as Error).message}`);
  }
  if (!SHARP_FORMAT[options.expectedMime] || meta.format !== SHARP_FORMAT[options.expectedMime])
    throw new ImageRejectError(
      "type_mismatch",
      `Формат ${meta.format} не совпадает с ${options.expectedMime}`,
    );
  if (!meta.width || !meta.height)
    throw new ImageRejectError("decode_failed", "Не удалось определить размер");
  if (meta.width * meta.height > maxPixels)
    throw new ImageRejectError("dimensions_too_large", `Больше ${maxPixels} пикселей`);
  // Ориентация 5–8 — поворот на 90°: ширина и высота меняются местами.
  const swap = (meta.orientation ?? 1) >= 5;
  const width = swap ? meta.height : meta.width;
  const height = swap ? meta.width : meta.height;

  let base: { data: Buffer; info: OutputInfo };
  try {
    base = await sharp(source, { limitInputPixels: maxPixels, failOn: "error" })
      .rotate()
      .resize({ width: widths[0], withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw new ImageRejectError("decode_failed", `Ошибка обработки изображения: ${(e as Error).message}`);
  }
  const raw = { width: base.info.width, height: base.info.height, channels: base.info.channels };
  const variants: RenderedVariant[] = [];
  for (const w of widths) {
    const { data, info } = await sharp(base.data, { raw })
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    variants.push({ name: `w${w}`, width: info.width, height: info.height, bytes: info.size, data });
  }
  // Порядок — от меньшего к большему (как IMAGE_VARIANT_WIDTHS).
  return { width, height, variants: variants.reverse() };
}

/** Описание вариантов для БД (media_assets.variants): имя → ключ и размеры. */
export type StoredVariants = Record<string, ImageVariant & { key: string }>;

/**
 * Полный цикл для проверенного оригинала: прочитать, отрендерить варианты, записать в public/…. Повтор безопасен:
 * ключи вариантов детерминированы (перезапись тем же содержимым). Оригинал не удаляет: вызывающий удаляет его только
 * после того, как отметка ready зафиксирована в БД (после COMMIT), иначе откат оставил бы строку без исходника.
 */
export async function processImage(
  storage: StorageDriver,
  asset: { id: string; regionId: string; originalKey: string; mime: string },
  options: { maxPixels?: number } = {},
): Promise<{ width: number; height: number; variants: StoredVariants }> {
  const source = await storage.read(asset.originalKey);
  if (!source) throw new ImageRejectError("original_missing", "Оригинал не найден в хранилище");
  const rendered = await renderVariants(source, { expectedMime: asset.mime, maxPixels: options.maxPixels });
  const variants: StoredVariants = {};
  for (const v of rendered.variants) {
    const key = mediaKeys.variant(asset.regionId, asset.id, Number(v.name.slice(1)));
    await storage.write(key, v.data, "image/webp");
    variants[v.name] = { name: v.name, width: v.width, height: v.height, bytes: v.bytes, key };
  }
  return { width: rendered.width, height: rendered.height, variants };
}
