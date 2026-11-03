import { Injectable } from "@nestjs/common";
import { sql, type Expression } from "kysely";
import {
  currentDb,
  distanceMeters,
  InjectDb,
  lonLatOf,
  point,
  regionContext,
  withinMeters,
  withTenant,
  type Db,
  type Geometry,
  type LocalizedText,
  type LonLat,
  type PlaceEnrichmentGoogle,
  type PlaceEnrichmentWiki,
} from "../../db/index.js";
import type { ScheduleRows } from "../guide/index.js";

export type PlaceEnrichmentFacts = {
  google: PlaceEnrichmentGoogle | null;
  wiki: PlaceEnrichmentWiki | null;
  /** ИИ-текст карточки (places:enrich --ai). */
  ai: string | null;
};

/** Короткие факты Google о месте для подбора плана. */
export type PlaceRatingFacts = {
  rating: number | null;
  ratingCount: number | null;
  priceLevel: number | null;
  amenities: string[];
  typeLabel: string | null;
};

export type AssistantLocality = { id: string; code: string; name_i18n: LocalizedText; location: LonLat };

/** Совпадение по ключевым словам: место и вес совпадения (название 4, тип Google 3, описания 2, отзывы до 3). */
export type KeywordMatch = { id: string; score: number };

export type KeywordQuery = {
  /** Регулярное выражение Postgres по целым словам (keywordPattern) — тип, описания, отзывы. */
  pattern: string;
  /** Для названия — и внутри слитного («KitsuneSushi»): keywordPattern(…, false). */
  namePattern: string;
  /** Разделы или категории (вместе с подкатегориями и дополнительными категориями мест); пусто — весь каталог. */
  categoryIds: readonly string[];
  localityIds?: readonly string[];
  origin?: LonLat;
  radius?: number;
  /** Минимальный вес: без категорий одни упоминания в отзывах (отель, где «замовляли суші») не считаются. */
  minScore: number;
  limit: number;
};

/** Обогащение мест для ассистента: цена, удобства, описания — в контексте региона (RLS), одним запросом. */
@Injectable()
export class AssistantRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  async enrichments(regionId: string, ids: readonly string[]): Promise<Map<string, PlaceEnrichmentFacts>> {
    if (!ids.length) return new Map();
    const rows = await withTenant(this.db, regionContext(regionId), () =>
      currentDb(this.db)
        .selectFrom("place_enrichments")
        .select(["place_id", "google", "wiki", "ai_summary_uk"])
        .where("place_id", "in", ids)
        .execute(),
    );
    return new Map(rows.map((r) => [r.place_id, { google: r.google, wiki: r.wiki, ai: r.ai_summary_uk }]));
  }

  /** Рейтинг, цена и удобства Google (без отзывов и фото) — для подбора плана из сотен кандидатов. */
  async ratings(regionId: string, ids: readonly string[]): Promise<Map<string, PlaceRatingFacts>> {
    if (!ids.length) return new Map();
    const rows = await withTenant(this.db, regionContext(regionId), () =>
      currentDb(this.db)
        .selectFrom("place_enrichments")
        .select("place_id")
        .select(sql<number | null>`(google->>'rating')::float8`.as("rating"))
        .select(sql<number | null>`(google->>'ratingCount')::int`.as("rating_count"))
        .select(sql<number | null>`(google->>'priceLevel')::int`.as("price_level"))
        .select(sql<unknown>`google->'amenities'`.as("amenities"))
        .select(sql<string | null>`google->>'typeLabel'`.as("type_label"))
        .where("place_id", "in", [...ids])
        .execute(),
    );
    return new Map(
      rows.map((r) => [
        r.place_id,
        {
          rating: r.rating === null ? null : Number(r.rating),
          ratingCount: r.rating_count === null ? null : Number(r.rating_count),
          priceLevel: r.price_level === null ? null : Number(r.price_level),
          amenities: Array.isArray(r.amenities)
            ? r.amenities.filter((a): a is string => typeof a === "string")
            : [],
          typeLabel: r.type_label,
        },
      ]),
    );
  }

  /** Активные населённые пункты региона (для поля locality инструмента и выбора туриста). */
  localities(regionId: string): Promise<AssistantLocality[]> {
    return withTenant(
      this.db,
      regionContext(regionId),
      async () =>
        (await currentDb(this.db)
          .selectFrom("localities")
          .select(["id", "code", "name_i18n"])
          .select((eb) => lonLatOf(eb.ref("location")).as("location"))
          .where("active", "=", true)
          .where("kind", "=", "settlement")
          .orderBy("sort_order")
          .orderBy("code")
          .execute()) as AssistantLocality[],
    );
  }

  /**
   * Опубликованные места, где блюдо, кухня или особенность упоминается целым словом: в названии (uk/en), типе Google,
   * описаниях (ИИ-текст, Google, своё) или отзывах Google. Порядок — вес, затем расстояние (с точкой туриста).
   */
  keywordMatches(regionId: string, q: KeywordQuery): Promise<KeywordMatch[]> {
    const re = q.pattern;
    const name = q.namePattern;
    return withTenant(this.db, regionContext(regionId), async () => {
      // Отзывы — одной строкой jsonb (regexp_count, PG 15+): каждое упоминание +1, не больше 3.
      const score = sql<number>`(
        CASE WHEN coalesce(p.name_i18n->>'uk', '') ~* ${name} OR coalesce(p.name_i18n->>'en', '') ~* ${name} THEN 4 ELSE 0 END
        + CASE WHEN coalesce(e.google->>'typeLabel', '') ~* ${re} THEN 3 ELSE 0 END
        + CASE WHEN coalesce(e.ai_summary_uk, '') ~* ${re} OR coalesce(e.google->>'summary', '') ~* ${re}
            OR coalesce(p.description_i18n->>'uk', '') ~* ${re} THEN 2 ELSE 0 END
        + LEAST(3, regexp_count(coalesce((e.google->'reviews')::text, ''), ${re}, 1, 'i'))
      )::int`;
      const cats = [...q.categoryIds];
      let query = currentDb(this.db)
        .selectFrom("places as p")
        .innerJoin("categories as c", "c.id", "p.category_id")
        .leftJoin("place_enrichments as e", "e.place_id", "p.id")
        .where("p.status", "=", "published")
        .where("c.active", "=", true)
        .where("p.location", "is not", null)
        .where(sql<boolean>`${score} >= ${q.minScore}`);
      if (cats.length)
        query = query.where((eb) =>
          eb.or([
            eb("c.id", "in", cats),
            eb("c.parent_id", "in", cats),
            eb.exists(
              eb
                .selectFrom("place_extra_categories as x")
                .innerJoin("categories as xc", "xc.id", "x.category_id")
                .select("x.place_id")
                .whereRef("x.place_id", "=", "p.id")
                .where((w) => w.or([w("xc.id", "in", cats), w("xc.parent_id", "in", cats)])),
            ),
          ]),
        );
      if (q.localityIds?.length) query = query.where("p.locality_id", "in", [...q.localityIds]);
      const origin = q.origin;
      const geom = (eb: { ref(r: "p.location"): unknown }) => eb.ref("p.location") as Expression<Geometry>;
      if (origin && q.radius !== undefined) {
        const radius = q.radius;
        query = query.where((eb) => withinMeters(geom(eb), point(origin), radius));
      }
      let rows = query.select("p.id").select(score.as("score")).orderBy(score, "desc");
      if (origin) rows = rows.orderBy((eb) => distanceMeters(geom(eb), point(origin)));
      const found = await rows.orderBy("p.id").limit(q.limit).execute();
      return found.map((r) => ({ id: r.id, score: Number(r.score) }));
    });
  }

  /** График мест (недельный и исключения на даты плана) — для «відкрито» в нужное время плана. */
  async schedules(
    regionId: string,
    ids: readonly string[],
    dates: readonly string[],
  ): Promise<Map<string, ScheduleRows>> {
    type Mutable = {
      weekly: ScheduleRows["weekly"][number][];
      exceptions: ScheduleRows["exceptions"][number][];
    };
    const out = new Map<string, Mutable>();
    if (!ids.length) return out;
    await withTenant(this.db, regionContext(regionId), async () => {
      const db = currentDb(this.db);
      const [weekly, exceptions] = await Promise.all([
        db
          .selectFrom("place_schedules")
          .select(["place_id", "day_of_week", "opens_at", "closes_at"])
          .where("place_id", "in", [...ids])
          .orderBy("place_id")
          .orderBy("day_of_week")
          .orderBy("opens_at")
          .execute(),
        dates.length
          ? db
              .selectFrom("place_schedule_exceptions")
              .select((eb) => sql<string>`to_char(${eb.ref("date")}, 'YYYY-MM-DD')`.as("date"))
              .select(["place_id", "closed", "opens_at", "closes_at"])
              .where("place_id", "in", [...ids])
              .where(sql<boolean>`date = ANY(${[...dates]}::date[])`)
              .execute()
          : Promise.resolve([]),
      ]);
      for (const w of weekly) {
        const s = out.get(w.place_id) ?? { weekly: [], exceptions: [] };
        s.weekly.push({ dayOfWeek: w.day_of_week, opensAt: w.opens_at, closesAt: w.closes_at });
        out.set(w.place_id, s);
      }
      for (const e of exceptions) {
        const s = out.get(e.place_id) ?? { weekly: [], exceptions: [] };
        s.exceptions.push({ date: e.date, closed: e.closed, opensAt: e.opens_at, closesAt: e.closes_at });
        out.set(e.place_id, s);
      }
    });
    return out;
  }
}
