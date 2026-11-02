// Запись обогащения в place_enrichments: в tenant-контексте региона (TenantGuardPlugin + RLS), как пишет api.
// Upsert по (region_id, place_id); место ищется по google_place_id. Пустые данные не затирают собранные ранее:
// google/wiki пишутся, только если в этом прогоне получены (undefined/null из-за лимита — колонка не трогается).
// google из кэша импорта (--from-import-cache) беднее Details: сливается с сохранённым поле за полем (пустое не
// заменяет непустое), текст ИИ им не снимается и не заменяет сохранённый.
import { regionContext, withTenant, type Db, type PlaceEnrichmentGoogle } from "../db/index.js";
import type { PlaceEnrichmentsTable } from "../db/schema.js";
import type { Insertable } from "kysely";
import type { AiResult } from "./ai.js";
import type { EnrichedPlace } from "./enrich.js";

export type EnrichWriteItem = EnrichedPlace & {
  /**
   * Текст ИИ и хэш его входа. result null — текста для этих фактов ещё нет: сохранённый текст для других фактов
   * (иной ai_input_hash) снимается. hash null — фактов мало, текст снимается. undefined — ИИ не участвовал.
   */
  ai?: { hash: string | null; result: AiResult | null } | undefined;
};

export type EnrichWriteStats = {
  written: number;
  /** Мест нет в БД региона (импорт ещё не записал) — пропущены. */
  notInDb: number;
  aiWritten: number;
  /** Сняты устаревшие тексты ИИ (факты изменились, нового текста ещё нет). */
  aiCleared: number;
};

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);

/** Слияние данных Google: поле нового — если непустое, иначе сохранённое. */
export function mergeGoogle(
  saved: PlaceEnrichmentGoogle | null | undefined,
  fresh: PlaceEnrichmentGoogle,
): PlaceEnrichmentGoogle {
  if (!saved) return fresh;
  const out = { ...saved } as Record<string, unknown>;
  for (const [k, v] of Object.entries(fresh)) if (!isEmpty(v)) out[k] = v;
  return out as PlaceEnrichmentGoogle;
}

/**
 * Места из кэша импорта (googleFromImport) — со слитыми сохранёнными данными Google (факты и хэш ИИ по полным
 * данным); withAi — google_place_id таких мест, у которых текст ИИ уже есть (в очередь ИИ не ставятся).
 */
export async function withSavedGoogle<T extends EnrichedPlace>(
  db: Db,
  regionId: string,
  places: readonly T[],
): Promise<{ places: T[]; withAi: Set<string> }> {
  const ids = places.filter((p) => p.googleFromImport && p.google).map((p) => p.googlePlaceId);
  const withAi = new Set<string>();
  if (!ids.length) return { places: [...places], withAi };
  const rows = await withTenant(db, regionContext(regionId), (trx) =>
    trx
      .selectFrom("place_enrichments")
      .innerJoin("places", "places.id", "place_enrichments.place_id")
      .select(["places.google_place_id", "place_enrichments.google", "place_enrichments.ai_summary_uk"])
      .where("places.google_place_id", "in", ids)
      .execute(),
  );
  const saved = new Map(rows.map((r) => [r.google_place_id!, r]));
  for (const r of rows) if (r.ai_summary_uk) withAi.add(r.google_place_id!);
  return {
    places: places.map((p) => {
      const s = p.googleFromImport && p.google ? saved.get(p.googlePlaceId) : undefined;
      return s ? { ...p, google: mergeGoogle(s.google, p.google!) } : p;
    }),
    withAi,
  };
}

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
    const importIds = items.flatMap((it) =>
      it.googleFromImport && idOf.has(it.googlePlaceId) ? [idOf.get(it.googlePlaceId)!] : [],
    );
    const saved = new Map<string, PlaceEnrichmentGoogle | null>();
    if (importIds.length) {
      const prev = await trx
        .selectFrom("place_enrichments")
        .select(["place_id", "google"])
        .where("place_id", "in", importIds)
        .execute();
      for (const r of prev) saved.set(r.place_id, r.google);
    }
    const stats: EnrichWriteStats = { written: 0, notInDb: 0, aiWritten: 0, aiCleared: 0 };
    for (const it of items) {
      const placeId = idOf.get(it.googlePlaceId);
      if (!placeId) {
        stats.notInDb++;
        continue;
      }
      const values: Insertable<PlaceEnrichmentsTable> = { region_id: regionId, place_id: placeId };
      const update: Record<string, unknown> = {};
      if (it.google) {
        const google = it.googleFromImport ? mergeGoogle(saved.get(placeId), it.google) : it.google;
        values.google = google;
        values.google_fetched_at = now;
        update.google = google;
        update.google_fetched_at = now;
      }
      // Из кэша импорта: текст ИИ — только туда, где его нет; снимать сохранённый нельзя (факты беднее).
      const aiOnlyIfEmpty = Boolean(it.googleFromImport);
      if (it.wiki !== undefined) {
        values.wiki = it.wiki;
        values.wiki_fetched_at = now;
        update.wiki = it.wiki;
        update.wiki_fetched_at = now;
      }
      if (it.ai?.result && it.ai.hash && !aiOnlyIfEmpty) {
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
      if (Object.keys(update).length) {
        await trx
          .insertInto("place_enrichments")
          .values(values)
          .onConflict((oc) => oc.columns(["region_id", "place_id"]).doUpdateSet(update))
          .execute();
        stats.written++;
      }
      if (aiOnlyIfEmpty) {
        const text = it.ai?.result?.text;
        if (it.ai?.result && it.ai.hash && text) {
          const set = await trx
            .updateTable("place_enrichments")
            .set({
              ai_summary_uk: text,
              ai_model: it.ai.result.model,
              ai_generated_at: it.ai.result.generatedAt,
              ai_input_hash: it.ai.hash,
            })
            .where("place_id", "=", placeId)
            .where("ai_summary_uk", "is", null)
            .executeTakeFirst();
          if (Number(set.numUpdatedRows)) stats.aiWritten++;
        }
      } else if (it.ai && !(it.ai.result && it.ai.hash)) {
        // Текст для прежних фактов не выдаётся за актуальный.
        const hash = it.ai.hash;
        const cleared = await trx
          .updateTable("place_enrichments")
          .set({ ai_summary_uk: null, ai_model: null, ai_generated_at: null, ai_input_hash: null })
          .where("place_id", "=", placeId)
          .where("ai_summary_uk", "is not", null)
          .where((eb) =>
            hash ? eb.or([eb("ai_input_hash", "is", null), eb("ai_input_hash", "!=", hash)]) : eb.val(true),
          )
          .executeTakeFirst();
        stats.aiCleared += Number(cleared.numUpdatedRows);
      }
    }
    return stats;
  });
}
