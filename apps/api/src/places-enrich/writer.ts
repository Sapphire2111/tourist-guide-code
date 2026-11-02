// Запись обогащения в place_enrichments: в tenant-контексте региона (TenantGuardPlugin + RLS), как пишет api.
// Upsert по (region_id, place_id); место ищется по google_place_id. Пустые данные не затирают собранные ранее:
// google/wiki пишутся, только если в этом прогоне получены (undefined/null из-за лимита — колонка не трогается).
import { regionContext, withTenant, type Db } from "../db/index.js";
import type { PlaceEnrichmentsTable } from "../db/schema.js";
import type { Insertable } from "kysely";
import type { AiResult } from "./ai.js";
import type { EnrichedPlace } from "./enrich.js";

export type EnrichWriteItem = EnrichedPlace & {
  /** Текст ИИ и хэш его входа; undefined — ИИ в прогоне не участвовал. */
  ai?: { hash: string; result: AiResult | null } | undefined;
};

export type EnrichWriteStats = {
  written: number;
  /** Мест нет в БД региона (импорт ещё не записал) — пропущены. */
  notInDb: number;
  aiWritten: number;
};

export async function writeEnrichment(
  db: Db,
  regionId: string,
  items: readonly EnrichWriteItem[],
  now: Date,
): Promise<EnrichWriteStats> {
  return withTenant(db, regionContext(regionId), async (trx) => {
    const rows = await trx
      .selectFrom("places")
      .select(["id", "google_place_id"])
      .where("source", "=", "google")
      .execute();
    const idOf = new Map(rows.map((r) => [r.google_place_id!, r.id]));
    const stats: EnrichWriteStats = { written: 0, notInDb: 0, aiWritten: 0 };
    for (const it of items) {
      const placeId = idOf.get(it.googlePlaceId);
      if (!placeId) {
        stats.notInDb++;
        continue;
      }
      const values: Insertable<PlaceEnrichmentsTable> = { region_id: regionId, place_id: placeId };
      const update: Record<string, unknown> = {};
      if (it.google) {
        values.google = it.google;
        values.google_fetched_at = now;
        update.google = it.google;
        update.google_fetched_at = now;
      }
      if (it.wiki !== undefined) {
        values.wiki = it.wiki;
        values.wiki_fetched_at = now;
        update.wiki = it.wiki;
        update.wiki_fetched_at = now;
      }
      if (it.ai?.result) {
        const text = it.ai.result.text;
        values.ai_summary_uk = text;
        values.ai_model = text ? it.ai.result.model : null;
        values.ai_generated_at = text ? it.ai.result.generatedAt : null;
        values.ai_input_hash = it.ai.hash;
        Object.assign(update, {
          ai_summary_uk: values.ai_summary_uk,
          ai_model: values.ai_model,
          ai_generated_at: values.ai_generated_at,
          ai_input_hash: values.ai_input_hash,
        });
        if (text) stats.aiWritten++;
      }
      if (!Object.keys(update).length) continue;
      await trx
        .insertInto("place_enrichments")
        .values(values)
        .onConflict((oc) => oc.columns(["region_id", "place_id"]).doUpdateSet(update))
        .execute();
      stats.written++;
    }
    return stats;
  });
}
