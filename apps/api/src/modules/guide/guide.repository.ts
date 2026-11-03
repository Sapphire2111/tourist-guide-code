import { Injectable } from "@nestjs/common";
import { sql, type Expression, type ExpressionBuilder, type SelectQueryBuilder } from "kysely";
import {
  currentDb,
  distanceMeters,
  InjectDb,
  lonLatOf,
  point,
  withinMeters,
  type Database,
  type Db,
  type Geometry,
  type HomeSection,
  type LocalizedText,
  type LonLat,
  type MediaAsset,
  type PromotionAdLabel,
  type TagGroup,
} from "../../db/index.js";
import type { ExceptionRow, WeeklyRow } from "./open-now.js";

// Чтение публичного каталога (блок 4, ADR-0019) и избранное. Вызывается внутри withTenant(regionContext): фильтр
// region_id ставит TenantGuardPlugin, второй рубеж — RLS. Туристу — только опубликованные места в активной
// категории; черновик, приостановленное и архив не попадают ни в одну выборку.

/** Строка выдачи: место без служебных полей, точка — долгота/широта, расстояние — если задана точка туриста. */
export type PlaceRow = {
  id: string;
  category_id: string;
  name_i18n: LocalizedText;
  address_i18n: LocalizedText | null;
  phone: string | null;
  recommended: boolean;
  location: LonLat | null;
  distance: number | null;
};

export type PlaceCardRow = PlaceRow & {
  region_id: string;
  description_i18n: LocalizedText | null;
  website: string | null;
  telegram: string | null;
  verified_at: Date | null;
  /** Источник (0016): google — импорт places:import-google. */
  source: "manual" | "google";
};

export type SearchQuery = {
  origin?: LonLat;
  radius?: number;
  categoryId?: string;
  /** Населённые пункты (places.locality_id); пусто или нет — весь регион. */
  localityIds?: readonly string[];
  /** Текст без экранирования (экранирует репозиторий). */
  text?: string;
  /** Не показывать места разделов главной (корень категории — с этим home_section): «Що поруч» и карты без «Де жити». */
  excludeSections?: readonly HomeSection[];
  limit: number;
  offset: number;
};

export type PhotoRow = MediaAsset & { place_id: string; is_cover: boolean; sort_order: number };

export type TagRow = { id: string; code: string; name_i18n: LocalizedText; tag_group: TagGroup };

/** Избранных мест в выдаче — не больше (листания нет). */
export const FAVORITES_MAX = 200;

/** Экранирование % _ \ для ILIKE (ESCAPE по умолчанию — обратная косая черта). */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

type Q = SelectQueryBuilder<Database, "places" | "categories", object>;

/** Точка места (в выборке опубликованных она всегда есть — фильтр location IS NOT NULL). */
const geom = (eb: ExpressionBuilder<Database, "places">) => eb.ref("places.location") as Expression<Geometry>;

const nameUk = sql<string>`places.name_i18n->>'uk'`;
const nameEn = sql<string>`places.name_i18n->>'en'`;
const addressUk = sql<string>`places.address_i18n->>'uk'`;

@Injectable()
export class GuideRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  private get q(): Db {
    return currentDb(this.db);
  }

  /** Опубликованные места в активной категории. */
  private published(): Q {
    return this.q
      .selectFrom("places")
      .innerJoin("categories", "categories.id", "places.category_id")
      .where("places.status", "=", "published")
      .where("categories.active", "=", true)
      .where("places.location", "is not", null);
  }

  private selectRow(query: Q, origin: LonLat | undefined) {
    return query
      .select([
        "places.id",
        "places.category_id",
        "places.name_i18n",
        "places.address_i18n",
        "places.phone",
        "places.recommended",
      ])
      .select((eb) => lonLatOf(eb.ref("places.location")).as("location"))
      .select((eb) =>
        (origin ? distanceMeters(geom(eb), point(origin)) : sql<number | null>`NULL::float8`).as("distance"),
      );
  }

  // --- категории ---

  /** Активные категории; подкатегории выключенного раздела не входят. */
  activeCategories() {
    return this.q
      .selectFrom("categories")
      .leftJoin("categories as parent", "parent.id", "categories.parent_id")
      .selectAll("categories")
      .where("categories.active", "=", true)
      .where((eb) => eb.or([eb("categories.parent_id", "is", null), eb("parent.active", "=", true)]))
      .orderBy("categories.sort_order")
      .orderBy("categories.code")
      .execute();
  }

  /** Число опубликованных мест по категории (только своей, без подкатегорий). */
  async publishedCountByCategory(): Promise<Map<string, number>> {
    const rows = await this.q
      .selectFrom("places")
      .select(["places.category_id", (eb) => eb.fn.countAll<string>().as("n")])
      .where("places.status", "=", "published")
      .where("places.location", "is not", null)
      .groupBy("places.category_id")
      .execute();
    return new Map(rows.map((r) => [r.category_id, Number(r.n)]));
  }

  // --- населённые пункты ---

  /** Активные населённые пункты (kind settlement) по порядку, точка — долгота/широта. */
  activeLocalities() {
    return this.q
      .selectFrom("localities")
      .select(["localities.id", "localities.code", "localities.name_i18n", "localities.sort_order"])
      .select((eb) => lonLatOf(eb.ref("localities.location")).as("location"))
      .where("localities.active", "=", true)
      .where("localities.kind", "=", "settlement")
      .orderBy("localities.sort_order")
      .orderBy("localities.code")
      .execute();
  }

  /** Число опубликованных мест в активных категориях по населённому пункту. */
  async publishedCountByLocality(): Promise<Map<string, number>> {
    const rows = await this.published()
      .where("places.locality_id", "is not", null)
      .select(["places.locality_id", (eb) => eb.fn.countAll<string>().as("n")])
      .groupBy("places.locality_id")
      .execute();
    return new Map(rows.map((r) => [r.locality_id!, Number(r.n)]));
  }

  // --- поиск и карточка ---

  /** Страница выдачи (limit + 1 строка — признак следующей). Порядок — BR-10, C-02 (README «Публичный каталог»). */
  search(s: SearchQuery): Promise<PlaceRow[]> {
    let query = this.published();
    const { origin, categoryId, text } = s;
    if (origin && s.radius !== undefined) {
      const radius = s.radius;
      query = query.where((eb) => withinMeters(geom(eb), point(origin), radius));
    }
    // Категория или раздел — по основной ИЛИ дополнительной категории места (0020, place_extra_categories).
    if (categoryId)
      query = query.where((eb) =>
        eb.or([
          eb("places.category_id", "=", categoryId),
          eb("categories.parent_id", "=", categoryId),
          eb.exists(
            eb
              .selectFrom("place_extra_categories as x")
              .innerJoin("categories as xc", "xc.id", "x.category_id")
              .select("x.place_id")
              .whereRef("x.place_id", "=", "places.id")
              .where((w) => w.or([w("x.category_id", "=", categoryId), w("xc.parent_id", "=", categoryId)])),
          ),
        ]),
      );
    const exclude = s.excludeSections ?? [];
    if (exclude.length)
      query = query
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("categories as root")
                .select("root.id")
                .whereRef("root.id", "=", eb.fn.coalesce("categories.parent_id", "categories.id"))
                .where("root.home_section", "in", [...exclude]),
            ),
          ),
        )
        // …и по дополнительным категориям: место «Де жити» с доп. категорией тоже не показывается.
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("place_extra_categories as x")
                .innerJoin("categories as xc", "xc.id", "x.category_id")
                .innerJoin("categories as xr", (j) =>
                  j.on((o) => o("xr.id", "=", o.fn.coalesce("xc.parent_id", "xc.id"))),
                )
                .select("x.place_id")
                .whereRef("x.place_id", "=", "places.id")
                .where("xr.home_section", "in", [...exclude]),
            ),
          ),
        );
    if (s.localityIds?.length) query = query.where("places.locality_id", "in", [...s.localityIds]);
    const pattern = text === undefined ? undefined : likeContains(text);
    if (pattern !== undefined)
      query = query.where(
        sql<boolean>`(${nameUk} ILIKE ${pattern} OR ${nameEn} ILIKE ${pattern} OR ${addressUk} ILIKE ${pattern})`,
      );
    let rows = this.selectRow(query, origin);
    if (text !== undefined) {
      const prefix = likeContains(text).slice(1);
      rows = rows.orderBy(
        sql`CASE WHEN ${nameUk} ILIKE ${prefix} OR ${nameEn} ILIKE ${prefix} THEN 0
          WHEN ${nameUk} ILIKE ${pattern} OR ${nameEn} ILIKE ${pattern} THEN 1 ELSE 2 END`,
      );
    }
    if (origin) rows = rows.orderBy("distance");
    return rows
      .orderBy("places.recommended", "desc")
      .orderBy(nameUk)
      .orderBy("places.id")
      .limit(s.limit + 1)
      .offset(s.offset)
      .execute() as Promise<PlaceRow[]>;
  }

  /** Опубликованное место региона контекста; иначе undefined. */
  findPublished(id: string, origin: LonLat | undefined): Promise<PlaceCardRow | undefined> {
    return this.selectRow(this.published().where("places.id", "=", id), origin)
      .select([
        "places.region_id",
        "places.description_i18n",
        "places.website",
        "places.telegram",
        "places.verified_at",
        "places.source",
      ])
      .executeTakeFirst() as Promise<PlaceCardRow | undefined>;
  }

  /** Обогащение места (0018): Google, Вікіпедія, ИИ-текст; нет — undefined. */
  enrichment(placeId: string) {
    return this.q
      .selectFrom("place_enrichments")
      .select(["google", "wiki", "ai_summary_uk", "ai_model", "ai_generated_at"])
      .where("place_id", "=", placeId)
      .executeTakeFirst();
  }

  findCategory(id: string) {
    return this.q
      .selectFrom("categories")
      .select(["id", "parent_id", "name_i18n", "icon"])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  placeTags(placeId: string): Promise<TagRow[]> {
    return this.q
      .selectFrom("place_tags")
      .innerJoin("tags", "tags.id", "place_tags.tag_id")
      .select(["tags.id", "tags.code", "tags.name_i18n", "tags.tag_group"])
      .where("place_tags.place_id", "=", placeId)
      .where("tags.active", "=", true)
      .orderBy("tags.tag_group")
      .orderBy("tags.sort_order")
      .orderBy("tags.code")
      .execute();
  }

  /** Готовые фото мест по порядку: обложка первой, затем sort_order. */
  photos(placeIds: readonly string[]): Promise<PhotoRow[]> {
    if (placeIds.length === 0) return Promise.resolve([]);
    return (
      this.q
        .selectFrom("place_media")
        .innerJoin("media_assets", "media_assets.id", "place_media.media_asset_id")
        .selectAll("media_assets")
        .select(["place_media.place_id", "place_media.is_cover", "place_media.sort_order"])
        .where("place_media.place_id", "in", placeIds)
        .where("media_assets.status", "=", "ready")
        // Только фото: документ (private_document) туристу не отдаётся, даже если привязан по ошибке.
        .where("media_assets.kind", "=", "image")
        .orderBy("place_media.place_id")
        .orderBy("place_media.is_cover", "desc")
        .orderBy("place_media.sort_order")
        .orderBy("place_media.created_at")
        .execute()
    );
  }

  /** Обложка (или первое готовое фото) каждого места. */
  /** Обложки у нас (0018) для выдачи: без байтов — подпись, размеры, версия. */
  coverMeta(placeIds: readonly string[]) {
    if (placeIds.length === 0) return Promise.resolve([]);
    return this.q
      .selectFrom("place_cover_photos")
      .select([
        "place_id",
        "width",
        "height",
        "author_attributions",
        "license",
        "source_url",
        "source",
        "photo_name",
        "fetched_at",
      ])
      .where("place_id", "in", placeIds)
      .execute();
  }

  /** Версия обложки без байтов (GET /places/{id}/cover: ETag и 304 без чтения файла). */
  coverVersion(placeId: string) {
    return this.q
      .selectFrom("place_cover_photos")
      .select(["mime", "photo_name", "fetched_at"])
      .where("place_id", "=", placeId)
      .executeTakeFirst();
  }

  /** Байты обложки (GET /places/{id}/cover). */
  coverBytes(placeId: string) {
    return this.q
      .selectFrom("place_cover_photos")
      .select(["bytes", "mime", "photo_name", "fetched_at"])
      .where("place_id", "=", placeId)
      .executeTakeFirst();
  }

  covers(placeIds: readonly string[]): Promise<PhotoRow[]> {
    if (placeIds.length === 0) return Promise.resolve([]);
    return (
      this.q
        .selectFrom("place_media")
        .innerJoin("media_assets", "media_assets.id", "place_media.media_asset_id")
        .distinctOn("place_media.place_id")
        .selectAll("media_assets")
        .select(["place_media.place_id", "place_media.is_cover", "place_media.sort_order"])
        .where("place_media.place_id", "in", placeIds)
        .where("media_assets.status", "=", "ready")
        // Только фото: документ (private_document) туристу не отдаётся, даже если привязан по ошибке.
        .where("media_assets.kind", "=", "image")
        .orderBy("place_media.place_id")
        .orderBy("place_media.is_cover", "desc")
        .orderBy("place_media.sort_order")
        .orderBy("place_media.created_at")
        .execute()
    );
  }

  /**
   * Недельный график мест и исключения на даты `dates` (или все с `fromDate`). Время — "HH:MM:SS", дата — строкой
   * (to_char: pg отдал бы Date в часовом поясе процесса).
   */
  async schedules(
    placeIds: readonly string[],
    dates: { in?: readonly string[]; from?: string },
  ): Promise<
    Map<string, { weekly: WeeklyRow[]; exceptions: (ExceptionRow & { note: LocalizedText | null })[] }>
  > {
    const out = new Map<
      string,
      { weekly: WeeklyRow[]; exceptions: (ExceptionRow & { note: LocalizedText | null })[] }
    >();
    if (placeIds.length === 0) return out;
    for (const id of placeIds) out.set(id, { weekly: [], exceptions: [] });
    const weekly = await this.q
      .selectFrom("place_schedules")
      .select(["place_id", "day_of_week", "opens_at", "closes_at"])
      .where("place_id", "in", placeIds)
      .orderBy("place_id")
      .orderBy("day_of_week")
      .orderBy("opens_at")
      .execute();
    let ex = this.q
      .selectFrom("place_schedule_exceptions")
      .select((eb) => sql<string>`to_char(${eb.ref("date")}, 'YYYY-MM-DD')`.as("date"))
      .select(["place_id", "closed", "opens_at", "closes_at", "note_i18n"])
      .where("place_id", "in", placeIds);
    if (dates.in) ex = ex.where(sql<boolean>`date = ANY(${[...dates.in]}::date[])`);
    if (dates.from) ex = ex.where(sql<boolean>`date >= ${dates.from}::date`);
    const exceptions = await ex.orderBy("place_id").orderBy("date").orderBy("opens_at").execute();
    for (const w of weekly)
      out
        .get(w.place_id)
        ?.weekly.push({ dayOfWeek: w.day_of_week, opensAt: w.opens_at, closesAt: w.closes_at });
    for (const e of exceptions)
      out.get(e.place_id)?.exceptions.push({
        date: e.date,
        closed: e.closed,
        opensAt: e.opens_at,
        closesAt: e.closes_at,
        note: e.note_i18n,
      });
    return out;
  }

  /**
   * Метка действующего платного размещения места (ТЗ §4.3: всегда с меткой). На порядок выдачи не влияет (C-02),
   * бейдж «Ми рекомендуємо» не даёт (BR-09). При нескольких — «Реклама» важнее «Партнер».
   */
  async adLabels(placeIds: readonly string[]): Promise<Map<string, PromotionAdLabel>> {
    if (placeIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("promotions")
      .select(["place_id", "ad_label"])
      .where("place_id", "in", placeIds)
      .where("status", "=", "active")
      .where("starts_at", "<=", sql<Date>`now()`)
      .where("ends_at", ">", sql<Date>`now()`)
      .execute();
    const out = new Map<string, PromotionAdLabel>();
    for (const r of rows)
      if (r.place_id && (out.get(r.place_id) === undefined || r.ad_label === "advertising"))
        out.set(r.place_id, r.ad_label);
    return out;
  }

  // --- избранное ---

  /** Избранные опубликованные места пользователя в регионе контекста, новые сверху. */
  favorites(userId: string, origin?: LonLat): Promise<PlaceRow[]> {
    const query = this.published()
      .innerJoin("favorites", "favorites.place_id", "places.id")
      .where("favorites.user_id", "=", userId) as unknown as Q;
    return this.selectRow(query, origin)
      .orderBy(sql`favorites.created_at`, "desc")
      .orderBy("places.id")
      .limit(FAVORITES_MAX)
      .execute() as Promise<PlaceRow[]>;
  }

  /**
   * Избранных пользователя в регионе контекста — те же записи, что в списке (favorites): только опубликованные места.
   * Скрытые места лимит не занимают — пользователь их не видит и убрать не может.
   */
  async countFavorites(userId: string): Promise<number> {
    const row = await (
      this.published()
        .innerJoin("favorites", "favorites.place_id", "places.id")
        .where("favorites.user_id", "=", userId) as unknown as Q
    )
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  isFavorite(userId: string, placeId: string): Promise<boolean> {
    return this.q
      .selectFrom("favorites")
      .select("id")
      .where("user_id", "=", userId)
      .where("place_id", "=", placeId)
      .executeTakeFirst()
      .then((r) => r !== undefined);
  }

  /** Добавить (повтор — без изменений); возвращает запись. */
  async addFavorite(userId: string, placeId: string): Promise<{ place_id: string; created_at: Date }> {
    await this.q
      .insertInto("favorites")
      .values({ user_id: userId, place_id: placeId })
      .onConflict((oc) => oc.columns(["user_id", "place_id"]).doNothing())
      .execute();
    return this.q
      .selectFrom("favorites")
      .select(["place_id", "created_at"])
      .where("user_id", "=", userId)
      .where("place_id", "=", placeId)
      .executeTakeFirstOrThrow();
  }

  async removeFavorite(userId: string, placeId: string): Promise<boolean> {
    const r = await this.q
      .deleteFrom("favorites")
      .where("user_id", "=", userId)
      .where("place_id", "=", placeId)
      .executeTakeFirst();
    return r.numDeletedRows > 0n;
  }
}
