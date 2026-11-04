// Запись импорта в каталог региона: в tenant-контексте региона (regionContext: TenantGuardPlugin + RLS), как пишет
// api. Идемпотентно: населённые пункты и дополнительные категории — ON CONFLICT DO NOTHING по коду (правки админки не
// трогаются), места — upsert по (region_id, google_place_id). Демо-места seed (source = manual) не меняются.
import type { ExpressionBuilder, SqlBool } from "kysely";
import {
  point,
  regionContext,
  withTenant,
  type Database,
  type Db,
  type LocalizedText,
  type UserPlanItemRecord,
} from "../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../modules/audit/index.js";
import { scheduleProblems } from "../modules/catalog/index.js";
import { SEED_CATEGORIES } from "../seed/seed-catalog.js";
import { IMPORT_EXTRA_CATEGORIES, IMPORT_LOCALITIES, type ImportLocality } from "./config.js";
import { tagsForPlace, type MappedPlace } from "./mapping.js";

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
  /** Дополнительных категорий от импорта записано (place_extra_categories, source = import). */
  extraCategoriesWritten: number;
  /** Связей место — тег добавлено (tagsForPlace: категория и удобства Google). */
  tagsWritten: number;
  /** Места импорта, переразмеченные новыми правилами (категорию ставил импорт, админка не меняла). */
  recategorized: number;
  /** Места импорта, которые по новым правилам не наши (collect.rejectedIds), — в архив, если админка не трогала. */
  archivedRejected: number;
  /** google_place_id заархивированных «не наших» (в аудит прогона). */
  archivedIds: string[];
  /** Места импорта в БД, которых не было в этой выгрузке (только отчёт; null — выгрузка неполная, не считалось). */
  missingFromGoogle: number | null;
  missingExamples: string[];
  /** Места этого прогона, которые после записи не опубликованы (архив, скрыто, черновик) — реальный статус. */
  notPublished: { googlePlaceId: string; name: string; status: string }[];
  /** google place id вставленных (новых) мест — этап фото при --insert-only берёт только их. */
  insertedIds: string[];
};

export type WriteOptions = {
  /** id закрытых навсегда (collect.closedIds). */
  closedIds?: readonly string[];
  /** id мест, которые по текущим правилам не импортируются (collect.rejectedIds). */
  rejectedIds?: readonly string[];
  /** Все id выгрузки (collect.seenIds); вместе с complete — для отчёта «пропали из выдачи». */
  seenIds?: readonly string[];
  /** Выгрузка полная (без лимита запросов). */
  complete?: boolean;
  /**
   * Только новые места (дозагрузка зон, --zones-only/--insert-only): место с тем же google place id не обновляется
   * (ON CONFLICT DO NOTHING), закрытые/отклонённые не скрываются и не архивируются.
   */
  insertOnly?: boolean;
  /** Населённые пункты, которые завести (по умолчанию IMPORT_LOCALITIES; точечный импорт — и TARGETED_LOCALITIES). */
  localities?: readonly ImportLocality[];
  /**
   * Точечный импорт (targeted.ts): категория закреплена запросом — import_category_id = NULL у места source = google.
   * Широкий прогон такие места не переразмечает, не пересобирает им доп. категории и не архивирует (все три правила
   * требуют import_category_id = category_id). Существующее место закрепляется, только если категорию ставил импорт
   * (админка не меняла); уже закреплённое или правленное админкой — категория не меняется.
   */
  pinCategory?: boolean;
};

type PlacesEb = ExpressionBuilder<Database, "places">;
/**
 * Место «трогали»: в журнале есть любое действие над ним, кроме самого импорта (правка и курирование в админке,
 * ручная чистка place.curate от system, доп. категории, партнёр). У таких мест импорт не меняет категорию, пункт и
 * статус, не пересобирает доп. категории и теги.
 */
const touched = (eb: PlacesEb) =>
  eb.exists(
    eb
      .selectFrom("audit_logs as a")
      .select(eb.lit(1).as("one"))
      .where("a.entity_type", "=", "place")
      .where("a.action", "<>", "place.import")
      .where("a.entity_id", "=", eb.cast<string>(eb.ref("places.id"), "text")),
  );
/**
 * Люди меняли статус места: публикация/скрытие/архив в админке или ручная чистка (place.curate) со status в новых
 * значениях. Только такие действия мешают снять с публикации закрытое навсегда.
 */
const statusTouched = (eb: PlacesEb) =>
  eb.exists(
    eb
      .selectFrom("audit_logs as a")
      .select(eb.lit(1).as("one"))
      .where("a.entity_type", "=", "place")
      .where("a.entity_id", "=", eb.cast<string>(eb.ref("places.id"), "text"))
      .where((w) =>
        w.or([
          w("a.action", "in", ["place.publish", "place.suspend", "place.archive"]),
          w.and([
            w("a.action", "=", "place.curate"),
            // new_values ? 'status' (jsonb_exists — та же операция функцией).
            w.fn<SqlBool>("jsonb_exists", [w.ref("a.new_values"), w.cast(w.val("status"), "text")]),
          ]),
        ]),
      ),
  );
/**
 * Теги места правили люди: действия пользователя или правка места/доп. категорий (снятый тег импорт не возвращает).
 * Ручная чистка от system (place.curate) теги не трогала — такие места теги получают.
 */
const tagsTouched = (eb: PlacesEb) =>
  eb.exists(
    eb
      .selectFrom("audit_logs as a")
      .select(eb.lit(1).as("one"))
      .where("a.entity_type", "=", "place")
      .where("a.entity_id", "=", eb.cast<string>(eb.ref("places.id"), "text"))
      .where((w) =>
        w.or([
          w("a.actor_type", "=", "user"),
          w("a.action", "in", ["place.edit", "place.extra_categories.edit"]),
        ]),
      ),
  );
/** Местом пользуются: избранное, отзывы, сценарии, брони, планы — такое место импорт не архивирует. */
const inUse = (eb: PlacesEb) =>
  eb.or([
    eb.exists(
      eb.selectFrom("favorites as f").select(eb.lit(1).as("one")).whereRef("f.place_id", "=", "places.id"),
    ),
    eb.exists(
      eb.selectFrom("reviews as rv").select(eb.lit(1).as("one")).whereRef("rv.place_id", "=", "places.id"),
    ),
    eb.exists(
      eb
        .selectFrom("scenario_items as si")
        .select(eb.lit(1).as("one"))
        .whereRef("si.place_id", "=", "places.id"),
    ),
    eb.exists(
      eb.selectFrom("bookings as b").select(eb.lit(1).as("one")).whereRef("b.place_id", "=", "places.id"),
    ),
    eb.exists(
      eb
        .selectFrom("user_plans as up")
        .select(eb.lit(1).as("one"))
        .where((w) =>
          w.or([
            w("up.base_place_id", "=", w.ref("places.id")),
            w(
              "up.items",
              "@>",
              w.fn<UserPlanItemRecord[]>("jsonb_build_array", [
                w.fn("jsonb_build_object", [
                  w.cast(w.val("placeId"), "text"),
                  w.cast(w.ref("places.id"), "text"),
                ]),
              ]),
            ),
          ]),
        ),
    ),
  ]);

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
 * verified_at и last_synced_at; название, описание, статус и бейдж остаются как есть (их могла поправить админка).
 * Категория — переразмечается по новым правилам, только если её поставил импорт и админка не меняла
 * (import_category_id = category_id, 0020). Неразобранный график (week = null) не трогает существующий.
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
      recategorized: 0,
      archivedRejected: 0,
      archivedIds: [],
      extraCategoriesWritten: 0,
      tagsWritten: 0,
      missingFromGoogle: null,
      missingExamples: [],
      notPublished: [],
      insertedIds: [],
    };

    const newLocalities = await trx
      .insertInto("localities")
      .values(
        (options.localities ?? IMPORT_LOCALITIES).map((l, i) => ({
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
    // Корневой раздел, которого ещё нет в регионе (seed старее кода — напр. «Сервіси», 0020), — по описанию seed.
    for (const parent of new Set(IMPORT_EXTRA_CATEGORIES.map((c) => c.parent))) {
      if (rootIds.has(parent)) continue;
      const i = SEED_CATEGORIES.findIndex((r) => r.code === parent);
      const root = SEED_CATEGORIES[i];
      if (!root) continue;
      const created = await trx
        .insertInto("categories")
        .values({
          region_id: regionId,
          code: root.code,
          name_i18n: root.name,
          icon: root.icon,
          home_section: root.home,
          sort_order: root.sortOrder ?? i * 10,
        })
        .onConflict((oc) => oc.columns(["region_id", "code"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (created) {
        rootIds.set(parent, created.id);
        stats.categoriesCreated++;
      }
    }
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
    // Теги региона (seed): нет тега с кодом — связь не пишется (новых тегов импорт не заводит).
    const tagId = new Map(
      (await trx.selectFrom("tags").select(["id", "code"]).where("active", "=", true).execute()).map((r) => [
        r.code,
        r.id,
      ]),
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
      const slice = places.slice(from, from + BATCH);
      const before = new Map(
        (
          await trx
            .selectFrom("places")
            .select([
              "google_place_id",
              "category_id",
              "import_category_id",
              (eb) => touched(eb).as("touched"),
            ])
            .where(
              "google_place_id",
              "in",
              slice.map((p) => p.googlePlaceId),
            )
            .execute()
        ).map((r) => [r.google_place_id, r]),
      );
      // Только новые: уже известные места батча не трогаются вовсе (ни данные, ни категории, ни график).
      const batch = options.insertOnly ? slice.filter((p) => !before.has(p.googlePlaceId)) : slice;
      if (!batch.length) continue;
      const googleIds = batch.map((p) => p.googlePlaceId);
      const existing = new Set(before.keys());
      for (const p of batch) {
        const b = before.get(p.googlePlaceId);
        const next = categoryId.get(p.categoryCode);
        if (b && !b.touched && b.import_category_id === b.category_id && b.category_id !== next)
          stats.recategorized++;
      }
      const rows = await trx
        .insertInto("places")
        .values(
          batch.map((p) => ({
            region_id: regionId,
            category_id: categoryId.get(p.categoryCode)!,
            import_category_id: options.pinCategory ? null : categoryId.get(p.categoryCode)!,
            locality_id: (p.localityCode && localityId.get(p.localityCode)) || null,
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
          // Только новые: место, появившееся между проверкой и вставкой, не трогается.
          options.insertOnly
            ? oc.columns(["region_id", "google_place_id"]).doNothing()
            : // Пустое у Google (нет телефона, http-сайт) не затирает заполненное админкой; адрес — слияние языков:
              // uk обновляет Google, переводы админки (en…) остаются.
              oc.columns(["region_id", "google_place_id"]).doUpdateSet((eb) => {
                // Категорию ставил импорт, админка её не меняла и место не трогали (touched) — переразметка.
                const untouched = eb.and([
                  eb("places.import_category_id", "=", eb.ref("places.category_id")),
                  eb.not(touched(eb as unknown as PlacesEb)),
                ]);
                return {
                  category_id: eb
                    .case()
                    .when(untouched)
                    .then(eb.ref("excluded.category_id"))
                    .else(eb.ref("places.category_id"))
                    .end(),
                  import_category_id: eb
                    .case()
                    .when(untouched)
                    // Точечный: excluded.import_category_id = NULL — место закрепляется.
                    .then(eb.ref("excluded.import_category_id"))
                    .else(eb.ref("places.import_category_id"))
                    .end(),
                  address_i18n: eb(
                    eb.fn.coalesce(eb.ref("places.address_i18n"), eb.val({} as LocalizedText)),
                    "||",
                    eb.ref("excluded.address_i18n"),
                  ),
                  location: eb.ref("excluded.location"),
                  // Пункт, поправленный людьми (touched: курирование, правка), импорт не перезаписывает.
                  locality_id: eb
                    .case()
                    .when(touched(eb as unknown as PlacesEb))
                    .then(eb.ref("places.locality_id"))
                    .else(eb.fn.coalesce(eb.ref("excluded.locality_id"), eb.ref("places.locality_id")))
                    .end(),
                  phone: eb.fn.coalesce(eb.ref("excluded.phone"), eb.ref("places.phone")),
                  website: eb.fn.coalesce(eb.ref("excluded.website"), eb.ref("places.website")),
                  verified_at: eb.ref("excluded.verified_at"),
                  last_synced_at: eb.ref("excluded.last_synced_at"),
                };
              }),
        )
        .returning(["id", "google_place_id", "status"])
        .execute();
      if (options.insertOnly && rows.length !== batch.length)
        throw new ImportWriteError(
          "Места появились в БД во время записи (параллельный импорт?) — запись отменена, повторите",
        );
      const placeId = new Map(rows.map((r) => [r.google_place_id!, r.id]));
      for (const r of rows)
        if (r.status !== "published")
          stats.notPublished.push({
            googlePlaceId: r.google_place_id!,
            name: batch.find((p) => p.googlePlaceId === r.google_place_id)?.name ?? "",
            status: r.status,
          });
      stats.updated += googleIds.filter((id) => existing.has(id)).length;
      const insertedIds = googleIds.filter((id) => !existing.has(id));
      stats.inserted += insertedIds.length;
      stats.insertedIds.push(...insertedIds);

      // Дополнительные категории импорта пересобираются (новые правила) только у мест, где основную категорию
      // ставил импорт: админка сменила категорию — набор места её, импорт его не трогает. Поставленные админкой
      // (manual) не трогаются — совпадение с ними ON CONFLICT DO NOTHING. Если админка правила доп. категории места
      // (аудит place.extra_categories.edit, даже когда список очищен) или место вообще трогали (touched) — импорт его
      // набор не пересобирает вовсе.
      const ownRows = await trx
        .selectFrom("places")
        .select("google_place_id")
        .where(
          "id",
          "in",
          batch.map((p) => placeId.get(p.googlePlaceId)!),
        )
        .whereRef("import_category_id", "=", "category_id")
        .where((eb) => eb.not(touched(eb)))
        .execute();
      const own = new Set(ownRows.map((r) => r.google_place_id!));
      const ownBatch = batch.filter((p) => own.has(p.googlePlaceId));
      const batchIds = ownBatch.map((p) => placeId.get(p.googlePlaceId)!);
      if (batchIds.length)
        await trx
          .deleteFrom("place_extra_categories")
          .where("place_id", "in", batchIds)
          .where("source", "=", "import")
          .execute();
      const extras = ownBatch.flatMap((p) =>
        p.extraCategoryCodes
          .filter((code) => code !== p.categoryCode && categoryId.has(code))
          .map((code) => ({
            region_id: regionId,
            place_id: placeId.get(p.googlePlaceId)!,
            category_id: categoryId.get(code)!,
            source: "import" as const,
          })),
      );
      if (extras.length) {
        const written = await trx
          .insertInto("place_extra_categories")
          .values(extras)
          .onConflict((oc) => oc.columns(["place_id", "category_id"]).doNothing())
          .returning("place_id")
          .execute();
        stats.extraCategoriesWritten += written.length;
      }

      // Теги (tagsForPlace): по категории и удобствам Google (place_enrichments.google.amenities — их пишет
      // places:enrich). Только добавляются (ON CONFLICT DO NOTHING) и только местам, где люди не правили теги
      // (tagsTouched — админка могла снять тег): теги админки импорт не меняет.
      if (tagId.size) {
        const taggable = await trx
          .selectFrom("places")
          .leftJoin("place_enrichments as e", "e.place_id", "places.id")
          .select(["places.id", "places.google_place_id", "e.google"])
          .where(
            "places.id",
            "in",
            batch.map((p) => placeId.get(p.googlePlaceId)!),
          )
          .whereRef("places.import_category_id", "=", "places.category_id")
          .where((eb) => eb.not(tagsTouched(eb)))
          .execute();
        const byGoogleId = new Map(batch.map((p) => [p.googlePlaceId, p]));
        const tagRows = taggable.flatMap((r) => {
          const p = byGoogleId.get(r.google_place_id!)!;
          return tagsForPlace(p.categoryCode, r.google?.amenities ?? [], p.name)
            .filter((code) => tagId.has(code))
            .map((code) => ({ region_id: regionId, place_id: r.id, tag_id: tagId.get(code)! }));
        });
        if (tagRows.length) {
          const written = await trx
            .insertInto("place_tags")
            .values(tagRows)
            .onConflict((oc) => oc.columns(["place_id", "tag_id"]).doNothing())
            .returning("place_id")
            .execute();
          stats.tagsWritten += written.length;
        }
      }

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

    // Закрылись навсегда — снять с публикации (как «Приховати» в админке: suspended); архив и черновики не трогаем,
    // место, чей статус меняли люди (statusTouched: публикация/скрытие/архив, чистка со status), — тоже.
    const closed = options.insertOnly ? [] : [...new Set(options.closedIds ?? [])];
    for (let from = 0; from < closed.length; from += BATCH) {
      const rows = await trx
        .updateTable("places")
        .set({ status: "suspended" })
        .where("source", "=", "google")
        .where("status", "=", "published")
        .where((eb) => eb.not(statusTouched(eb)))
        .where("google_place_id", "in", closed.slice(from, from + BATCH))
        .returning("google_place_id")
        .execute();
      stats.suspendedIds.push(...rows.map((r) => r.google_place_id!));
      stats.suspendedClosed += rows.length;
    }

    // Уже импортированные места, которые по новым правилам не наши (метки «только пункт/бренд», поштомати, табори),
    // — в архив; только опубликованные, только если категорию ставил импорт (админка не меняла), у места нет
    // организации-партнёра, его не трогали (touched: любое действие в журнале, кроме импорта, — в т. ч. чистка
    // place.curate от system) и им не пользуются (inUse: избранное, отзывы, сценарии, брони, планы).
    const rejected = options.insertOnly ? [] : [...new Set(options.rejectedIds ?? [])];
    for (let from = 0; from < rejected.length; from += BATCH) {
      const rows = await trx
        .updateTable("places")
        .set({ status: "archived" })
        .where("source", "=", "google")
        .where("status", "=", "published")
        .whereRef("import_category_id", "=", "category_id")
        .where("organization_id", "is", null)
        .where((eb) => eb.and([eb.not(touched(eb)), eb.not(inUse(eb))]))
        .where("google_place_id", "in", rejected.slice(from, from + BATCH))
        .returning("google_place_id")
        .execute();
      stats.archivedIds.push(...rows.map((r) => r.google_place_id!));
      stats.archivedRejected += rows.length;
    }

    // Пропавшие из выдачи — только отчёт: место могло не попасть в запросы, это не повод его скрывать.
    if (options.complete && options.seenIds && !options.insertOnly) {
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
        ...(options.insertOnly ? { insertOnly: true } : {}),
        inserted: stats.inserted,
        updated: stats.updated,
        suspendedClosed: stats.suspendedClosed,
        suspendedIds: stats.suspendedIds,
        recategorized: stats.recategorized,
        extraCategoriesWritten: stats.extraCategoriesWritten,
        tagsWritten: stats.tagsWritten,
        archivedRejected: stats.archivedRejected,
        archivedIds: stats.archivedIds,
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

/**
 * google id мест региона: опубликованные и все (вкл. архив, скрытые). При свёртке дублей (dedupePlaces) остаётся
 * опубликованная запись, затем любая уже известная — архивированный админом дубль не «воскреснет» новым местом.
 */
export async function regionGoogleIds(
  db: Db,
  regionCode: string,
): Promise<{ published: Set<string>; existing: Set<string> }> {
  const regionId = await findRegionId(db, regionCode);
  return withTenant(db, regionContext(regionId), async (trx) => {
    const rows = await trx
      .selectFrom("places")
      .select(["google_place_id", "status"])
      .where("source", "=", "google")
      .execute();
    return {
      published: new Set(rows.filter((r) => r.status === "published").map((r) => r.google_place_id!)),
      existing: new Set(rows.map((r) => r.google_place_id!)),
    };
  });
}
