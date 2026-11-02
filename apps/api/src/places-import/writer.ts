// Запись импорта в каталог региона: в tenant-контексте региона (regionContext: TenantGuardPlugin + RLS), как пишет
// api. Идемпотентно: населённые пункты и дополнительные категории — ON CONFLICT DO NOTHING по коду (правки админки не
// трогаются), места — upsert по (region_id, google_place_id). Демо-места seed (source = manual) не меняются.
import { point, regionContext, withTenant, type Db, type LocalizedText } from "../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../modules/audit/index.js";
import { scheduleProblems } from "../modules/catalog/index.js";
import { SEED_CATEGORIES } from "../seed/seed-catalog.js";
import { IMPORT_EXTRA_CATEGORIES, IMPORT_LOCALITIES } from "./config.js";
import type { MappedPlace } from "./mapping.js";

export class ImportWriteError extends Error {
  override readonly name = "ImportWriteError";
}

/** Названия подкатегорий (uk) по коду: seed и дополнительные — для автоописания места. */
export const CATEGORY_NAMES: Readonly<Record<string, string>> = Object.fromEntries([
  ...SEED_CATEGORIES.flatMap((c) => c.children.map((s) => [s.code, s.name.uk] as const)),
  ...IMPORT_EXTRA_CATEGORIES.map((c) => [c.code, c.name.uk] as const),
]);

export type WriteStats = {
  regionId: string;
  inserted: number;
  updated: number;
  schedulesWritten: number;
  localitiesCreated: number;
  categoriesCreated: number;
  /** Мест не из Google в регионе (демо-seed и созданные в админке) — не тронуты. */
  manualPlaces: number;
  /** Графики, не прошедшие правила каталога (не записаны, существующий оставлен). */
  schedulesRejected: number;
  /** Опубликованные места импорта, которые Google теперь отдаёт как закрытые навсегда, — сняты с публикации. */
  suspendedClosed: number;
  /** google_place_id снятых с публикации (в аудит прогона). */
  suspendedIds: string[];
  /** Места импорта в БД, которых не было в этой выгрузке (только отчёт; null — выгрузка неполная, не считалось). */
  missingFromGoogle: number | null;
  missingExamples: string[];
};

export type WriteOptions = {
  /** id закрытых навсегда (collect.closedIds). */
  closedIds?: readonly string[];
  /** Все id выгрузки (collect.seenIds); вместе с complete — для отчёта «пропали из выдачи». */
  seenIds?: readonly string[];
  /** Выгрузка полная (без лимита запросов). */
  complete?: boolean;
};

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Мест в одном INSERT … ON CONFLICT. */
const BATCH = 100;

export async function findRegionId(db: Db, regionCode: string): Promise<string> {
  const region = await db
    .selectFrom("regions")
    .select("id")
    .where("code", "=", regionCode)
    .executeTakeFirst();
  if (!region)
    throw new ImportWriteError(`Регион ${regionCode} не найден (сначала db:seed или создать в админке)`);
  return region.id;
}

/**
 * Upsert мест. Новое место — опубликовано, «дата перевірки» и первая публикация — `now`. Существующее (тот же
 * google_place_id) — обновляются данные, которые ведёт Google: адрес, точка, населённый пункт, телефон, сайт, график,
 * verified_at и last_synced_at; название, описание, категория, статус и бейдж остаются как есть (их могла поправить
 * админка). Неразобранный график (week = null) не трогает существующий.
 */
export async function writePlaces(
  db: Db,
  regionCode: string,
  places: readonly MappedPlace[],
  now: Date,
  options: WriteOptions = {},
): Promise<WriteStats> {
  const regionId = await findRegionId(db, regionCode);
  return withTenant(db, regionContext(regionId), async (trx) => {
    const stats: WriteStats = {
      regionId,
      inserted: 0,
      updated: 0,
      schedulesWritten: 0,
      localitiesCreated: 0,
      categoriesCreated: 0,
      manualPlaces: 0,
      schedulesRejected: 0,
      suspendedClosed: 0,
      suspendedIds: [],
      missingFromGoogle: null,
      missingExamples: [],
    };

    const newLocalities = await trx
      .insertInto("localities")
      .values(
        IMPORT_LOCALITIES.map((l, i) => ({
          region_id: regionId,
          code: l.code,
          kind: "settlement" as const,
          name_i18n: l.name,
          location: point(l.at),
          sort_order: 100 + i * 10,
        })),
      )
      .onConflict((oc) => oc.columns(["region_id", "code"]).doNothing())
      .returning("id")
      .execute();
    stats.localitiesCreated = newLocalities.length;
    const localityId = new Map(
      (await trx.selectFrom("localities").select(["id", "code"]).execute()).map((r) => [r.code, r.id]),
    );

    const rootIds = new Map(
      (
        await trx.selectFrom("categories").select(["id", "code"]).where("parent_id", "is", null).execute()
      ).map((r) => [r.code, r.id]),
    );
    for (const [i, c] of IMPORT_EXTRA_CATEGORIES.entries()) {
      const parentId = rootIds.get(c.parent);
      if (!parentId)
        throw new ImportWriteError(
          `Нет корневой категории ${c.parent} в регионе ${regionCode} (нужен каталог seed)`,
        );
      const created = await trx
        .insertInto("categories")
        .values({
          region_id: regionId,
          parent_id: parentId,
          code: c.code,
          name_i18n: c.name,
          icon: c.icon,
          sort_order: 500 + i * 10,
        })
        .onConflict((oc) => oc.columns(["region_id", "code"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (created) stats.categoriesCreated++;
    }
    const categoryId = new Map(
      (await trx.selectFrom("categories").select(["id", "code"]).execute()).map((r) => [r.code, r.id]),
    );
    for (const p of places)
      if (!categoryId.has(p.categoryCode))
        throw new ImportWriteError(
          `Нет категории ${p.categoryCode} в регионе ${regionCode} (нужен каталог seed)`,
        );

    const manual = await trx
      .selectFrom("places")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("source", "=", "manual")
      .executeTakeFirstOrThrow();
    stats.manualPlaces = Number(manual.n);

    for (let from = 0; from < places.length; from += BATCH) {
      const batch = places.slice(from, from + BATCH);
      const googleIds = batch.map((p) => p.googlePlaceId);
      const existing = new Set(
        (
          await trx
            .selectFrom("places")
            .select("google_place_id")
            .where("google_place_id", "in", googleIds)
            .execute()
        ).map((r) => r.google_place_id),
      );
      const rows = await trx
        .insertInto("places")
        .values(
          batch.map((p) => ({
            region_id: regionId,
            category_id: categoryId.get(p.categoryCode)!,
            locality_id: localityId.get(p.localityCode) ?? null,
            name_i18n: { uk: p.name },
            description_i18n: { uk: p.description },
            address_i18n: { uk: p.address },
            location: point(p.at),
            phone: p.phone,
            website: p.website,
            status: "published" as const,
            verified_at: now,
            first_published_at: now,
            source: "google" as const,
            google_place_id: p.googlePlaceId,
            last_synced_at: now,
          })),
        )
        .onConflict((oc) =>
          // Пустое у Google (нет телефона, http-сайт) не затирает заполненное админкой; адрес — слияние языков:
          // uk обновляет Google, переводы админки (en…) остаются.
          oc.columns(["region_id", "google_place_id"]).doUpdateSet((eb) => ({
            address_i18n: eb(
              eb.fn.coalesce(eb.ref("places.address_i18n"), eb.val({} as LocalizedText)),
              "||",
              eb.ref("excluded.address_i18n"),
            ),
            location: eb.ref("excluded.location"),
            locality_id: eb.fn.coalesce(eb.ref("excluded.locality_id"), eb.ref("places.locality_id")),
            phone: eb.fn.coalesce(eb.ref("excluded.phone"), eb.ref("places.phone")),
            website: eb.fn.coalesce(eb.ref("excluded.website"), eb.ref("places.website")),
            verified_at: eb.ref("excluded.verified_at"),
            last_synced_at: eb.ref("excluded.last_synced_at"),
          })),
        )
        .returning(["id", "google_place_id"])
        .execute();
      const placeId = new Map(rows.map((r) => [r.google_place_id!, r.id]));
      stats.updated += googleIds.filter((id) => existing.has(id)).length;
      stats.inserted += googleIds.filter((id) => !existing.has(id)).length;

      // График: заменяется целиком только у мест, где Google отдал непустой график, прошедший правила каталога
      // (scheduleProblems — те же, что у админки). Нет графика или он плохой — существующий не трогается; плохая
      // строка не доходит до INSERT и не откатывает всю транзакцию.
      const withWeek = batch.filter((p) => {
        if (!p.week?.length) return false;
        const ok =
          p.week.every(
            (w) => HHMM.test(w.opensAt) && HHMM.test(w.closesAt) && w.dayOfWeek >= 1 && w.dayOfWeek <= 7,
          ) && scheduleProblems(p.week, []).length === 0;
        if (!ok) stats.schedulesRejected++;
        return ok;
      });
      const ids = withWeek.map((p) => placeId.get(p.googlePlaceId)!);
      if (ids.length) await trx.deleteFrom("place_schedules").where("place_id", "in", ids).execute();
      const schedule = withWeek.flatMap((p) =>
        p.week!.map((w) => ({
          region_id: regionId,
          place_id: placeId.get(p.googlePlaceId)!,
          day_of_week: w.dayOfWeek,
          opens_at: w.opensAt,
          closes_at: w.closesAt,
        })),
      );
      if (schedule.length) await trx.insertInto("place_schedules").values(schedule).execute();
      stats.schedulesWritten += schedule.length;
    }

    // Закрылись навсегда — снять с публикации (как «Приховати» в админке: suspended); архив и черновики не трогаем.
    const closed = [...new Set(options.closedIds ?? [])];
    for (let from = 0; from < closed.length; from += BATCH) {
      const rows = await trx
        .updateTable("places")
        .set({ status: "suspended" })
        .where("source", "=", "google")
        .where("status", "=", "published")
        .where("google_place_id", "in", closed.slice(from, from + BATCH))
        .returning("google_place_id")
        .execute();
      stats.suspendedIds.push(...rows.map((r) => r.google_place_id!));
      stats.suspendedClosed += rows.length;
    }

    // Пропавшие из выдачи — только отчёт: место могло не попасть в запросы, это не повод его скрывать.
    if (options.complete && options.seenIds) {
      const seen = new Set(options.seenIds);
      const imported = await trx
        .selectFrom("places")
        .select(["google_place_id", "name_i18n"])
        .where("source", "=", "google")
        .execute();
      const missing = imported.filter((r) => !seen.has(r.google_place_id!));
      stats.missingFromGoogle = missing.length;
      stats.missingExamples = missing.slice(0, 30).map((r) => `${r.name_i18n.uk} (${r.google_place_id})`);
    }

    // Одна запись аудита на прогон (актор SYSTEM, регион — из контекста).
    await new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS).record(trx, {
      actor: { type: "system" },
      action: "place.import",
      entityType: "region",
      entityId: regionId,
      newValues: {
        source: "google",
        inserted: stats.inserted,
        updated: stats.updated,
        suspendedClosed: stats.suspendedClosed,
        suspendedIds: stats.suspendedIds,
        schedulesRejected: stats.schedulesRejected,
        missingFromGoogle: stats.missingFromGoogle,
        schedulesWritten: stats.schedulesWritten,
        categoriesCreated: stats.categoriesCreated,
        localitiesCreated: stats.localitiesCreated,
      },
      reason: "places:import-google",
    });
    return stats;
  });
}

/** id мест импорта в регионе по google_place_id (для этапа фото). */
export async function googlePlaceIds(db: Db, regionId: string): Promise<Map<string, string>> {
  return withTenant(db, regionContext(regionId), async (trx) => {
    const rows = await trx
      .selectFrom("places")
      .select(["id", "google_place_id"])
      .where("source", "=", "google")
      .execute();
    return new Map(rows.map((r) => [r.google_place_id!, r.id]));
  });
}
