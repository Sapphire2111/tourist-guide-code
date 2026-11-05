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
  type PlaceTagSource,
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
  /** id места Google: данные вершины (places-import/peaks.ts) — по нему. */
  google_place_id: string | null;
};

export type PlaceCardRow = PlaceRow & {
  region_id: string;
  description_i18n: LocalizedText | null;
  website: string | null;
  telegram: string | null;
  verified_at: Date | null;
  /** Источник (0016): google — импорт places:import-google. */
  source: "manual" | "google";
  /** Организация партнёра (0017): без неё прайса нет — запрос hasPriceList не нужен. */
  organization_id?: string | null;
};

export type SearchQuery = {
  origin?: LonLat;
  radius?: number;
  categoryId?: string;
  /** Населённые пункты (places.locality_id); пусто или нет — весь регион. */
  localityIds?: readonly string[];
  /** Текст без экранирования (экранирует репозиторий). */
  text?: string;
  /** Только эти места (ассистент: найденные по ключевым словам); пусто — ничего. */
  ids?: readonly string[];
  /** Не показывать места разделов главной (корень категории — с этим home_section): «Що поруч» и карты без «Де жити». */
  excludeSections?: readonly HomeSection[];
  /** Коды тегов: только места со всеми этими активными тегами (фильтр удобств «Де жити»). */
  tagCodes?: readonly string[];
  limit: number;
  offset: number;
};

export type PhotoRow = MediaAsset & { place_id: string; is_cover: boolean; sort_order: number };

export type TagRow = {
  id: string;
  code: string;
  name_i18n: LocalizedText;
  tag_group: TagGroup;
  source: PlaceTagSource;
};

/** Позиций прайса в карточке: лимит кабинета (PRICE_LIST_MAX_ITEMS) с запасом. */
export const PRICE_ROWS_MAX = 250;

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
/** Апострофы (' ʼ ’ ‘ `) — без них при поиске по названию: «Хом'як» = «Хомʼяк» = «Хомяк». */
const APOSTROPHES = "'ʼ’‘`";
const stripApostrophes = (s: string) => s.replace(/['ʼ’‘`]/g, "");
const bareNameUk = sql<string>`translate(${nameUk}, ${APOSTROPHES}, '')`;
const bareNameEn = sql<string>`translate(${nameEn}, ${APOSTROPHES}, '')`;

/** Категория или раздел — по основной ИЛИ дополнительной категории места (0020, place_extra_categories). */
function inCategory(query: Q, categoryId: string): Q {
  return query.where((eb) =>
    eb.or([
      eb("places.category_id", "=", categoryId),
      eb("categories.parent_id", "=", categoryId),
      eb.exists(
        eb
          .selectFrom("place_extra_categories as x")
          .innerJoin("categories as xc", "xc.id", "x.category_id")
          .select("x.place_id")
          .whereRef("x.place_id", "=", "places.id")
          .where("xc.active", "=", true)
          .where((w) => w.or([w("x.category_id", "=", categoryId), w("xc.parent_id", "=", categoryId)])),
      ),
    ]),
  );
}

/** У места есть активный тег с этим кодом. */
function withTag(query: Q, code: string): Q {
  return query.where((eb) =>
    eb.exists(
      eb
        .selectFrom("place_tags as ft")
        .innerJoin("tags as ftag", "ftag.id", "ft.tag_id")
        .select("ft.place_id")
        .whereRef("ft.place_id", "=", "places.id")
        .where("ftag.code", "=", code)
        .where("ftag.active", "=", true),
    ),
  );
}

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
        "places.google_place_id",
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

  /**
   * Число опубликованных мест по категориям — основной и дополнительной (place_extra_categories), без дублей:
   * own — места самой категории; tree — места корня вместе с активными подкатегориями (место в нескольких
   * подкатегориях раздела считается один раз). Правило то же, что у search: место видно, только если его основная
   * категория активна; в счёт категории/раздела идёт по основной или по активной доп. категории.
   */
  async publishedCountByCategory(): Promise<{ own: Map<string, number>; tree: Map<string, number> }> {
    const q = this.q.with("pc", (db) =>
      db
        .selectFrom("places")
        .innerJoin("categories as pc0", "pc0.id", "places.category_id")
        .select(["places.id as place_id", "places.category_id"])
        .where("places.status", "=", "published")
        .where("places.location", "is not", null)
        .where("pc0.active", "=", true)
        .union(
          // Доп. категория — только активная и только у места с активной основной (как в search).
          db
            .selectFrom("place_extra_categories as x")
            .innerJoin("places as xp", "xp.id", "x.place_id")
            .innerJoin("categories as xpc", "xpc.id", "xp.category_id")
            .innerJoin("categories as xc", "xc.id", "x.category_id")
            .select(["x.place_id", "x.category_id"])
            .where("xp.status", "=", "published")
            .where("xp.location", "is not", null)
            .where("xpc.active", "=", true)
            .where("xc.active", "=", true),
        ),
    );
    const own = await q
      .selectFrom("pc")
      .select(["pc.category_id", (eb) => eb.fn.count<string>("pc.place_id").distinct().as("n")])
      .groupBy("pc.category_id")
      .execute();
    const tree = await q
      .selectFrom("pc")
      .innerJoin("categories as c", "c.id", "pc.category_id")
      .select([
        (eb) => eb.fn.coalesce("c.parent_id", "c.id").as("root_id"),
        (eb) => eb.fn.count<string>("pc.place_id").distinct().as("n"),
      ])
      .where("c.active", "=", true)
      .groupBy((eb) => eb.fn.coalesce("c.parent_id", "c.id"))
      .execute();
    return {
      own: new Map(own.map((r) => [r.category_id, Number(r.n)])),
      tree: new Map(tree.map((r) => [r.root_id, Number(r.n)])),
    };
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
    const query = this.filtered(s);
    if (!query) return Promise.resolve([]);
    const { origin, text } = s;
    const bare = text === undefined ? undefined : likeContains(stripApostrophes(text));
    let rows = this.selectRow(query, origin);
    if (text !== undefined) {
      const prefix = bare!.slice(1);
      rows = rows.orderBy(
        sql`CASE WHEN ${bareNameUk} ILIKE ${prefix} OR ${bareNameEn} ILIKE ${prefix} THEN 0
          WHEN ${bareNameUk} ILIKE ${bare} OR ${bareNameEn} ILIKE ${bare} THEN 1 ELSE 2 END`,
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

  /** Фильтры выдачи (радиус, категория, теги, разделы, пункты, id, текст) — общие у search и tagCounts; null — пусто. */
  private filtered(s: Omit<SearchQuery, "limit" | "offset">): Q | null {
    let query = this.published();
    const { origin, categoryId, text } = s;
    if (origin && s.radius !== undefined) {
      const radius = s.radius;
      query = query.where((eb) => withinMeters(geom(eb), point(origin), radius));
    }
    if (categoryId) query = inCategory(query, categoryId);
    // Удобства (И): каждое — свой EXISTS по place_tags (индекс place_tags_pkey: place_id, tag_id).
    for (const code of new Set(s.tagCodes ?? [])) query = withTag(query, code);
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
                .where("xc.active", "=", true)
                .where("xr.home_section", "in", [...exclude]),
            ),
          ),
        );
    if (s.localityIds?.length) query = query.where("places.locality_id", "in", [...s.localityIds]);
    if (s.ids) {
      if (!s.ids.length) return null;
      query = query.where("places.id", "in", [...s.ids]);
    }
    const pattern = text === undefined ? undefined : likeContains(text);
    const bare = text === undefined ? undefined : likeContains(stripApostrophes(text));
    if (pattern !== undefined)
      query = query.where(
        sql<boolean>`(${bareNameUk} ILIKE ${bare} OR ${bareNameEn} ILIKE ${bare} OR ${addressUk} ILIKE ${pattern})`,
      );
    return query;
  }

  /**
   * Число опубликованных мест по активным тегам с теми же фильтрами, что у search (радиус от точки, категория с
   * подкатегориями и доп. категориями, пункты, текст), без фильтра тегов — счётчики совпадают со списком «Де жити».
   * Теги без мест не возвращаются.
   */
  async tagCounts(s: Omit<SearchQuery, "limit" | "offset" | "tagCodes">) {
    const query = this.filtered(s);
    if (!query) return [];
    return query
      .innerJoin("place_tags as pt", "pt.place_id", "places.id")
      .innerJoin("tags as t", "t.id", "pt.tag_id")
      .where("t.active", "=", true)
      .select([
        "t.code",
        "t.name_i18n",
        "t.tag_group",
        "t.sort_order",
        (eb) => eb.fn.count<string>("places.id").distinct().as("n"),
      ])
      .groupBy("t.id")
      .orderBy("t.tag_group")
      .orderBy("t.sort_order")
      .orderBy("t.code")
      .execute();
  }

  /** Опубликованное место региона контекста; иначе undefined. */
  findPublished(id: string, origin: LonLat | undefined): Promise<PlaceCardRow | undefined> {
    return this.selectRow(this.published().where("places.id", "=", id), origin)
      .select([
        "places.region_id",
        "places.organization_id",
        "places.description_i18n",
        "places.website",
        "places.telegram",
        "places.verified_at",
        "places.source",
      ])
      .executeTakeFirst() as Promise<PlaceCardRow | undefined>;
  }

  /** Есть ли у места видимый прайс (0030): active-позиция в active-разделе, только место партнёра. */
  async hasPriceList(placeId: string): Promise<boolean> {
    const row = await this.q
      .selectFrom("price_list_items as i")
      .innerJoin("price_list_sections as s", (j) =>
        j.onRef("s.id", "=", "i.section_id").onRef("s.place_id", "=", "i.place_id"),
      )
      .innerJoin("places as p", "p.id", "i.place_id")
      .select("i.id")
      .where("i.place_id", "=", placeId)
      .where("p.organization_id", "is not", null)
      .where("s.status", "=", "active")
      .where("i.status", "=", "active")
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Прайс для карточки (0030): позиции active в разделах active партнёрского места (organization_id задан), по
   * порядку разделов и позиций. Опубликованность места проверяет findPublished.
   */
  priceRows(placeId: string) {
    return this.q
      .selectFrom("price_list_items as i")
      .innerJoin("price_list_sections as s", (j) =>
        j.onRef("s.id", "=", "i.section_id").onRef("s.place_id", "=", "i.place_id"),
      )
      .innerJoin("places as p", "p.id", "i.place_id")
      .select([
        "s.id as section_id",
        "s.title_i18n",
        "i.id",
        "i.name_i18n",
        "i.description_i18n",
        "i.price_minor",
        "i.currency",
        "i.price_from",
        "i.unit_i18n",
      ])
      .where("i.place_id", "=", placeId)
      .where("p.organization_id", "is not", null)
      .where("s.status", "=", "active")
      .where("i.status", "=", "active")
      .orderBy("s.sort_order")
      .orderBy("s.id")
      .orderBy("i.sort_order")
      .orderBy("i.id")
      .limit(PRICE_ROWS_MAX)
      .execute();
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
      .select(["tags.id", "tags.code", "tags.name_i18n", "tags.tag_group", "place_tags.source"])
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

  /**
   * Действующие акции: status active, now внутри [starts_at, ends_at] (null — без границы), место привязано к
   * организации, организация не заблокирована (как и остальной партнёрский контент).
   */
  private activeOffers() {
    return this.q
      .selectFrom("offers")
      .innerJoin("places", "places.id", "offers.place_id")
      .innerJoin("organizations", "organizations.id", "places.organization_id")
      .where("places.organization_id", "is not", null)
      .where("organizations.status", "<>", "blocked")
      .where("offers.status", "=", "active")
      .where((eb) =>
        eb.or([eb("offers.starts_at", "is", null), eb("offers.starts_at", "<=", sql<Date>`now()`)]),
      )
      .where((eb) => eb.or([eb("offers.ends_at", "is", null), eb("offers.ends_at", ">=", sql<Date>`now()`)]));
  }

  /** Места из списка, у которых есть действующая акция партнёра (одним запросом на страницу выдачи). */
  async placeIdsWithOffer(placeIds: readonly string[]): Promise<Set<string>> {
    if (placeIds.length === 0) return new Set();
    const rows = await this.activeOffers()
      .select("offers.place_id")
      .distinct()
      .where("offers.place_id", "in", placeIds)
      .execute();
    return new Set(rows.map((r) => r.place_id));
  }

  /** Действующие акции места: ближайшие к окончанию сверху, без срока — в конце. */
  offers(placeId: string) {
    return this.activeOffers()
      .select([
        "offers.id",
        "offers.title_i18n",
        "offers.description_i18n",
        "offers.starts_at",
        "offers.ends_at",
      ])
      .where("offers.place_id", "=", placeId)
      .orderBy(sql`offers.ends_at asc nulls last`)
      .orderBy("offers.created_at", "desc")
      .limit(20)
      .execute();
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
