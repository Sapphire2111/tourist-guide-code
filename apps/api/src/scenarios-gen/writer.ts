// Запись сценариев в tenant-контексте региона (TenantGuardPlugin + RLS), как пишет api: по умолчанию — черновики
// (их смотрят и публикуют в админке), --publish — сразу опубликованные. Уже существующий код — пропуск (повторный
// прогон дописывает только новые). Перед записью места ещё раз сверяются с каталогом: опубликовано, категория активна.
import { regionContext, withTenant, type Db } from "../db/index.js";
import type { ScenarioDraft } from "./validate.js";

export class ScenariosWriteError extends Error {}

/** Есть ли колонка scenarios.seasons (миграция 0025): 42703 undefined_column — нет. */
export async function hasSeasonsColumn(db: Db, regionId: string): Promise<boolean> {
  try {
    await withTenant(db, regionContext(regionId), (trx) =>
      trx.selectFrom("scenarios").select("seasons").limit(1).execute(),
    );
    return true;
  } catch (e) {
    if ((e as { code?: unknown }).code === "42703") return false;
    throw e;
  }
}

export type WriteStats = { written: number; existing: number; placeUnavailable: string[] };

export async function writeDrafts(
  db: Db,
  regionId: string,
  drafts: readonly ScenarioDraft[],
  opts: { publish: boolean },
): Promise<WriteStats> {
  if (!(await hasSeasonsColumn(db, regionId)))
    throw new ScenariosWriteError(
      "В БД нет scenarios.seasons — сначала миграция 0025 (db:migrate). Сценарии не записаны.",
    );
  return withTenant(db, regionContext(regionId), async (trx) => {
    const stats: WriteStats = { written: 0, existing: 0, placeUnavailable: [] };
    const ids = [...new Set(drafts.flatMap((d) => d.items.flatMap((i) => [i.placeId, ...i.alternatives])))];
    const ok = new Set(
      ids.length
        ? (
            await trx
              .selectFrom("places")
              .innerJoin("categories", "categories.id", "places.category_id")
              .select("places.id")
              .where("places.id", "in", ids)
              .where("places.status", "=", "published")
              .where("places.location", "is not", null)
              .where("categories.active", "=", true)
              .execute()
          ).map((r) => r.id)
        : [],
    );
    const existing = new Set((await trx.selectFrom("scenarios").select("code").execute()).map((r) => r.code));
    for (const d of drafts) {
      if (existing.has(d.code)) {
        stats.existing++;
        continue;
      }
      if (d.items.some((i) => !ok.has(i.placeId))) {
        stats.placeUnavailable.push(d.code);
        continue;
      }
      const s = await trx
        .insertInto("scenarios")
        .values({
          code: d.code,
          title_i18n: d.title,
          description_i18n: d.description,
          days: d.days,
          tags: d.tags,
          seasons: d.seasons,
          status: opts.publish ? "published" : "draft",
          is_sponsored: false,
          ad_label: null,
          sort_order: 100,
          created_by: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const pos = new Map<number, number>();
      await trx
        .insertInto("scenario_items")
        .values(
          d.items.map((i) => {
            const position = pos.get(i.dayNo) ?? 0;
            pos.set(i.dayNo, position + 1);
            return {
              scenario_id: s.id,
              day_no: i.dayNo,
              position,
              place_id: i.placeId,
              time_hint: i.timeHint,
              duration_min: i.durationMin,
              note_i18n: i.note,
              alternatives: i.alternatives.filter((a) => ok.has(a)),
            };
          }),
        )
        .execute();
      existing.add(d.code);
      stats.written++;
    }
    return stats;
  });
}
