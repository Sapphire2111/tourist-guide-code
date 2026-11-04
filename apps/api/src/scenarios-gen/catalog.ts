// Каталог региона для генератора сценариев (scenarios:generate): только опубликованные места с точкой в активной
// категории — как видит турист. Места — из Google Maps (импорт), генератор ничего не выдумывает: модель получает
// список кандидатов и выбирает из него, программа проверяет каждый пункт по этому списку.
import { sql } from "kysely";
import { lonLatOf, regionContext, withTenant, type Db, type LonLat } from "../db/index.js";
import type { ScheduleRows } from "../modules/guide/index.js";

type WeeklyRow = ScheduleRows["weekly"][number];
import { adultsOnly, placeKind, visitEstimate, type VisitEstimate } from "../modules/planner/index.js";

export type GenPlace = {
  id: string;
  name: string;
  /** Все языковые варианты названия (признаки по названию). */
  names: string[];
  category: string;
  extraCategories: string[];
  locality: string | null;
  location: LonLat;
  tags: string[];
  recommended: boolean;
  rating: number | null;
  ratingCount: number | null;
  /** Тип по Google («Водоспад», «Піцерія»). */
  typeLabel: string | null;
  /** Ціни Google: 0 — безкоштовно … 4 — дуже дорого. */
  priceLevel: number | null;
  /** Короткий опис місця (ІІ-текст картки з фактів Google/Вікіпедії, places:enrich) або опис Google. */
  summary: string | null;
  weekly: WeeklyRow[];
  estimate: VisitEstimate;
  kind: string;
  adultsOnly: boolean;
};

export type GenLocality = { code: string; name: string; location: LonLat };

export type GenCatalog = {
  regionId: string;
  timezone: string;
  places: GenPlace[];
  localities: GenLocality[];
  /** Коды сценариев региона (любой статус) — без дублей. */
  existingCodes: Set<string>;
};

/** Обогащение места для генератора (вне пакета db — простая форма). */
export function genPlace(row: Omit<GenPlace, "estimate" | "kind" | "adultsOnly">): GenPlace {
  const p = { category: row.category, extraCategories: row.extraCategories, names: row.names };
  return { ...row, estimate: visitEstimate(p), kind: placeKind(p), adultsOnly: adultsOnly(p) };
}

export async function loadCatalog(db: Db, regionCode: string): Promise<GenCatalog> {
  const region = await db
    .selectFrom("regions")
    .select(["id", "timezone"])
    .where("code", "=", regionCode)
    .executeTakeFirst();
  if (!region) throw new Error(`Регион ${regionCode} не найден`);
  return loadRegionCatalog(db, region);
}

/** Каталог известного региона (живой план «Мій план» в api — регион уже найден по id). */
export function loadRegionCatalog(db: Db, region: { id: string; timezone: string }): Promise<GenCatalog> {
  return withTenant(db, regionContext(region.id), async (trx) => {
    const rows = (await trx
      .selectFrom("places")
      .innerJoin("categories", "categories.id", "places.category_id")
      .leftJoin("localities", "localities.id", "places.locality_id")
      .leftJoin("place_enrichments", "place_enrichments.place_id", "places.id")
      .select([
        "places.id",
        "places.name_i18n",
        "places.recommended",
        "categories.code as category",
        "localities.code as locality",
        "place_enrichments.google",
        "place_enrichments.ai_summary_uk",
      ])
      .select((eb) => lonLatOf(eb.ref("places.location")).as("location"))
      // Коды активных тегов и доп. категорий — подзапросами (как planner.repository.catalogPlaces).
      .select((eb) =>
        sql<string[]>`ARRAY(${eb
          .selectFrom("place_tags as pt")
          .innerJoin("tags as t", "t.id", "pt.tag_id")
          .select("t.code")
          .whereRef("pt.place_id", "=", "places.id")
          .where("t.active", "=", true)
          .orderBy("t.code")})`.as("tags"),
      )
      .select((eb) =>
        sql<string[]>`ARRAY(${eb
          .selectFrom("place_extra_categories as x")
          .innerJoin("categories as xc", "xc.id", "x.category_id")
          .select("xc.code")
          .whereRef("x.place_id", "=", "places.id")
          .where("xc.active", "=", true)
          .orderBy("xc.code")})`.as("extra"),
      )
      .where("places.status", "=", "published")
      .where("places.location", "is not", null)
      .where("categories.active", "=", true)
      .orderBy("places.id")
      .execute()) as unknown as {
      id: string;
      name_i18n: Record<string, string | undefined>;
      recommended: boolean;
      category: string;
      locality: string | null;
      google: {
        rating?: number | null;
        ratingCount?: number | null;
        typeLabel?: string | null;
        priceLevel?: number | null;
        summary?: string | null;
      } | null;
      ai_summary_uk: string | null;
      location: LonLat;
      tags: string[];
      extra: string[];
    }[];
    const schedules = await trx
      .selectFrom("place_schedules")
      .select(["place_id", "day_of_week", "opens_at", "closes_at"])
      .execute();
    const weekly = new Map<string, WeeklyRow[]>();
    for (const s of schedules) {
      const list = weekly.get(s.place_id) ?? [];
      list.push({
        dayOfWeek: s.day_of_week,
        opensAt: s.opens_at.slice(0, 5),
        closesAt: s.closes_at.slice(0, 5),
      });
      weekly.set(s.place_id, list);
    }
    const localities = (await trx
      .selectFrom("localities")
      .select(["code", "name_i18n"])
      .select((eb) => lonLatOf(eb.ref("localities.location")).as("location"))
      .where("active", "=", true)
      .execute()) as unknown as {
      code: string;
      name_i18n: Record<string, string>;
      location: LonLat | null;
    }[];
    const codes = await trx.selectFrom("scenarios").select("code").execute();
    return {
      regionId: region.id,
      timezone: region.timezone,
      places: rows.map((r) => {
        const names = Object.values(r.name_i18n).filter(
          (v): v is string => typeof v === "string" && v !== "",
        );
        return genPlace({
          id: r.id,
          name: r.name_i18n.uk ?? names[0] ?? r.id,
          names,
          category: r.category,
          extraCategories: r.extra,
          locality: r.locality,
          location: r.location,
          tags: r.tags,
          recommended: r.recommended,
          rating: r.google?.rating ?? null,
          ratingCount: r.google?.ratingCount ?? null,
          typeLabel: r.google?.typeLabel ?? null,
          priceLevel: r.google?.priceLevel ?? null,
          summary: r.ai_summary_uk ?? r.google?.summary ?? null,
          weekly: weekly.get(r.id) ?? [],
        });
      }),
      localities: localities.flatMap((l) =>
        l.location ? [{ code: l.code, name: l.name_i18n.uk ?? l.code, location: l.location }] : [],
      ),
      existingCodes: new Set(codes.map((c) => c.code)),
    };
  });
}
