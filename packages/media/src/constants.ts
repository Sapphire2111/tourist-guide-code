// Правила медиа (T1-20, ADR-0013): типы, лимиты, варианты изображений, раскладка ключей в хранилище.
// Общие для api (создание загрузки, подтверждение) и worker (ресайз); значения продублированы CHECK в миграции api 0009.

/** image — фото карточек (публичные варианты); private_document — документы (D-47), только по короткой подписи. */
export const MEDIA_KINDS = ["image", "private_document"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * pending — загрузка выдана, файл ещё не подтверждён; uploaded — файл проверен (размер, сигнатура);
 * processing — идёт ресайз; ready — готово к выдаче; rejected — отклонено (объект удалён).
 */
export const MEDIA_STATUSES = ["pending", "uploaded", "processing", "ready", "rejected"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** Владелец файла: тип сущности (таблицы places/organizations — блок 3, поэтому owner_id без FK). */
export const MEDIA_OWNER_TYPES = ["place", "organization", "region"] as const;
export type MediaOwnerType = (typeof MEDIA_OWNER_TYPES)[number];

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MEDIA_MIME_TYPES = [...IMAGE_MIME_TYPES, "application/pdf"] as const;
export type MediaMime = (typeof MEDIA_MIME_TYPES)[number];

/** Допустимые типы по виду: фото — только jpeg/png/webp; документ — ещё pdf (скан или выписка). */
export const ALLOWED_MIME: Readonly<Record<MediaKind, readonly MediaMime[]>> = {
  image: IMAGE_MIME_TYPES,
  private_document: MEDIA_MIME_TYPES,
};

/** Лимит размера файла, байт (10 МиБ). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Ширины вариантов изображения, px: превью в списке, карточка, полноэкранный просмотр. Без увеличения. */
export const IMAGE_VARIANT_WIDTHS = [320, 800, 1600] as const;
export type ImageVariantWidth = (typeof IMAGE_VARIANT_WIDTHS)[number];

/** Предел пикселей исходника (защита памяти от «пиксельной бомбы»): 50 Мпикс ≈ 8660×5770 — worker. */
export const MAX_INPUT_PIXELS = 50_000_000;
/** Предел для ресайза в процессе api (inline; Render free — 512 МБ): 24 Мпикс ≈ 6000×4000. */
export const INLINE_MAX_INPUT_PIXELS = 24_000_000;

/** Причины отклонения файла (CHECK media_assets_reject_reason_check, миграция 0009). */
export const MEDIA_REJECT_REASONS = [
  "size_mismatch",
  "type_mismatch",
  "decode_failed",
  "dimensions_too_large",
  "original_missing",
] as const;
export type MediaRejectReason = (typeof MEDIA_REJECT_REASONS)[number];

/** Обработка дольше этого (статус uploaded/processing не меняется) — зависла: повторное подтверждение ставит её заново. */
export const STALE_PROCESSING_MS = 10 * 60_000;

/** Срок подписанной ссылки на загрузку (PUT), с. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** Срок подписанной ссылки на публичный вариант изображения, с (если нет публичного префикса). */
export const PUBLIC_URL_TTL_SECONDS = 60 * 60;
/** Срок подписанной ссылки на приватный документ, с: короткий. */
export const PRIVATE_URL_TTL_SECONDS = 5 * 60;

/**
 * Раскладка ключей. Префикс `private/` никогда не публикуется (загрузки, оригиналы фото до ресайза, документы);
 * `public/` — только варианты изображений: его можно открыть через публичный домен/CDN (STORAGE_PUBLIC_BASE_URL).
 * upload — куда клиент кладёт файл по подписанному PUT; original — проверенная копия, которую делает подтверждение
 * (повторный PUT по ещё не истёкшей ссылке её не заменит: проверка и обработка идут по копии).
 */
export const mediaKeys = {
  upload: (regionId: string, assetId: string) => `private/${regionId}/${assetId}/upload`,
  original: (regionId: string, assetId: string) => `private/${regionId}/${assetId}/original`,
  variant: (regionId: string, assetId: string, width: number) =>
    `public/${regionId}/${assetId}/w${width}.webp`,
} as const;

/** Ключ объекта публичного префикса (варианты изображений). */
export function isPublicKey(key: string): boolean {
  return key.startsWith("public/");
}
