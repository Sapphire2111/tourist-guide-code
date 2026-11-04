// Этап фото импорта (--photos): до двух фото Google на место через тот же конвейер медиа, что и загрузка из админки
// (ADR-0013): проверка сигнатуры и размера, ресайз в webp-варианты (processImage), запись media_assets (owner place,
// alt — название места) и place_media (первое фото — обложка). Отдельный этап: перезапуск догружает недостающие фото
// (у места меньше фото, чем нужно), уже загруженные не трогает; ответы Google — из кэша.
import {
  detectMime,
  ImageRejectError,
  IMAGE_MIME_TYPES,
  IMAGE_VARIANT_WIDTHS,
  MAX_UPLOAD_BYTES,
  mediaKeys,
  processImage,
  uuidv7,
  type Storage,
} from "@tg/media";
import { regionContext, withTenant, type Db } from "../db/index.js";
import { RequestLimitError, type GooglePlacesClient } from "./google-client.js";
import type { MappedPlace } from "./mapping.js";

/** Фото на место. */
export const PHOTOS_PER_PLACE = 2;
/** Ширина, которую просим у Google: равна самому большому варианту (1600). */
export const PHOTO_MAX_WIDTH_PX = 1600;

export type PhotoStats = {
  placesConsidered: number;
  added: number;
  rejected: number;
  failed: number;
  limitReached: boolean;
};

/** Места этапа фото: при --insert-only — только вставленные этим прогоном (существующие не трогаются вовсе). */
export function photoCandidates(
  places: readonly MappedPlace[],
  insertedIds: readonly string[],
  insertOnly: boolean,
): MappedPlace[] {
  if (!insertOnly) return [...places];
  const inserted = new Set(insertedIds);
  return places.filter((p) => inserted.has(p.googlePlaceId));
}

/** Сколько фото места ещё догрузить: нужно min(2, у Google), уже есть `have`. */
export function photosToAdd(available: number, have: number, perPlace = PHOTOS_PER_PLACE): number {
  return Math.max(0, Math.min(perPlace, available) - have);
}

export async function importPhotos(
  db: Db,
  client: GooglePlacesClient,
  storage: Storage,
  regionId: string,
  places: readonly MappedPlace[],
  placeIds: ReadonlyMap<string, string>,
  log: (line: string) => void = () => {},
): Promise<PhotoStats> {
  const stats: PhotoStats = { placesConsidered: 0, added: 0, rejected: 0, failed: 0, limitReached: false };
  const inRegion = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(db, regionContext(regionId), fn);
  const counts = await inRegion(async (trx) => {
    const rows = await trx
      .selectFrom("place_media")
      .select([
        "place_id",
        (eb) => eb.fn.countAll<string>().as("n"),
        (eb) => eb.fn.max("sort_order").as("maxSort"),
      ])
      .groupBy("place_id")
      .execute();
    return new Map(rows.map((r) => [r.place_id, { n: Number(r.n), maxSort: Number(r.maxSort) }]));
  });

  for (const p of places) {
    const placeId = placeIds.get(p.googlePlaceId);
    if (!placeId) continue;
    const have = counts.get(placeId) ?? { n: 0, maxSort: -10 };
    const need = photosToAdd(p.photos.length, have.n);
    if (!need) continue;
    stats.placesConsidered++;
    // Фото Google по порядку, начиная с уже загруженного количества.
    for (const [k, photoName] of p.photos.slice(have.n, have.n + need).entries()) {
      try {
        const uri = await client.photoUri(photoName, PHOTO_MAX_WIDTH_PX);
        if (!uri) {
          stats.failed++;
          continue;
        }
        const bytes = await client.photoBytes(photoName, uri);
        const mime = detectMime(bytes.subarray(0, 16));
        if (
          !mime ||
          !(IMAGE_MIME_TYPES as readonly string[]).includes(mime) ||
          bytes.length > MAX_UPLOAD_BYTES
        ) {
          stats.rejected++;
          continue;
        }
        const id = uuidv7();
        const originalKey = mediaKeys.original(regionId, id);
        await storage.driver.write(originalKey, bytes, mime);
        // Уборка файлов этого фото (best-effort): оригинал и все возможные варианты.
        const cleanup = () =>
          Promise.all(
            [originalKey, ...IMAGE_VARIANT_WIDTHS.map((w) => mediaKeys.variant(regionId, id, w))].map((key) =>
              storage.driver.delete(key).catch(() => undefined),
            ),
          );
        let result;
        try {
          result = await processImage(storage.driver, { id, regionId, originalKey, mime });
        } catch (err) {
          await cleanup();
          if (err instanceof ImageRejectError) {
            stats.rejected++;
            continue;
          }
          throw err;
        }
        const sortOrder = have.maxSort + 10 * (k + 1);
        const isCover = have.n === 0 && k === 0;
        try {
          await inRegion(async (trx) => {
            await trx
              .insertInto("media_assets")
              .values({
                id,
                region_id: regionId,
                owner_type: "place",
                owner_id: placeId,
                kind: "image",
                status: "processing",
                mime,
                size_bytes: bytes.length,
                original_key: originalKey,
                alt_i18n: { uk: p.name },
              })
              .execute();
            await trx
              .updateTable("media_assets")
              .set({
                status: "ready",
                uploaded_at: new Date(),
                width: result.width,
                height: result.height,
                variants: result.variants,
              })
              .where("id", "=", id)
              .execute();
            await trx
              .insertInto("place_media")
              .values({
                region_id: regionId,
                place_id: placeId,
                media_asset_id: id,
                sort_order: sortOrder,
                is_cover: isCover,
              })
              .execute();
          });
        } catch (err) {
          // Запись в БД откатилась — файлы без строки никому не нужны.
          await cleanup();
          throw err;
        }
        // Оригинал не нужен после COMMIT (как в конвейере api: туристу отдаются только варианты).
        await storage.driver.delete(originalKey);
        stats.added++;
      } catch (err) {
        if (err instanceof RequestLimitError) {
          log(err.message);
          stats.limitReached = true;
          return stats;
        }
        stats.failed++;
        log(`Фото места ${p.googlePlaceId}: ${(err as Error).message}`);
      }
    }
  }
  return stats;
}
