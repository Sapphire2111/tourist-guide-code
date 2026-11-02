// Состояние файлов для ресайза (T1-20): только вызовы функций media_asset_* из миграции api 0009. Функции сами
// выставляют app.actor = 'system' (RLS) на время запроса, как analytics_record_event.
import type { StoredVariants } from "@tg/media";
import type { ClaimedMediaAsset, MediaAssetStore } from "../queue/handlers.js";

/** Исполнитель запроса (pg.Pool подходит); тесты подставляют свой. */
export interface MediaQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function mediaAssetStore(db: MediaQueryable): MediaAssetStore {
  return {
    async claim(id) {
      const { rows } = await db.query(
        "SELECT status, kind, region_id, original_key, mime FROM media_asset_claim_processing($1::uuid)",
        [id],
      );
      const r = rows[0];
      if (!r) return null;
      return {
        status: String(r.status),
        kind: String(r.kind),
        regionId: String(r.region_id),
        originalKey: String(r.original_key),
        mime: String(r.mime),
      } satisfies ClaimedMediaAsset;
    },
    async complete(id, width, height, variants: StoredVariants) {
      const { rows } = await db.query(
        "SELECT media_asset_complete_processing($1::uuid, $2::integer, $3::integer, $4::jsonb) AS done",
        [id, width, height, JSON.stringify(variants)],
      );
      return rows[0]?.done === true;
    },
    async reject(id, reason) {
      const { rows } = await db.query("SELECT media_asset_reject($1::uuid, $2::text) AS done", [id, reason]);
      return rows[0]?.done === true;
    },
  };
}
