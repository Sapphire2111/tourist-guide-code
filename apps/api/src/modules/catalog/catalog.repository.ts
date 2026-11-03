import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  hasValues,
  InjectDb,
  lonLatOf,
  point,
  type Category,
  type CategoryUpdate,
  type Db,
  type LocalizedText,
  type Locality,
  type LocalityUpdate,
  type LonLat,
  type NewCategory,
  type NewLocality,
  type NewPlace,
  type NewTag,
  type Place,
  type PlaceBadgeEvent,
  type PlaceStatus,
  type PlaceUpdate,
  type Tag,
  type TagUpdate,
} from "../../db/index.js";

// Доступ к таблицам каталога (миграция 0012). Все таблицы — tenant: фильтр region_id в контексте региона ставит
// TenantGuardPlugin, region_id при вставке — тоже он; второй рубеж — RLS. Запросы — через currentDb(): внутри
// withTenant() это транзакция запроса. Бизнес-правила (переходы статусов, публикация) — в сервисах.

/** Точка — долгота/широта вместо geometry (EWKB). */
type WithLocation<T extends { location: unknown }> = Omit<T, "location"> & { location: LonLat | null };

export type LocalityRecord = WithLocation<Locality>;
/**
 * Коды категорий проживания (D-02): у таких мест в админке есть «Модуль готелю» (блок 5). Тестовый режим —
 * список захардкожен по демо-seed: корень stay и подкатегории hotels, sadyby (в них же импорт Google раскладывает
 * hotel/motel/hostel/lodging… и guest_house/cottage/campground…). Позже — признак категории в БД вместо списка.
 */
export const STAY_CATEGORY_CODES = ["stay", "hotels", "sadyby"] as const;

/** Без полей импорта Google (0016: source, google_place_id, last_synced_at) — админке и API они пока не нужны. */
export type PlaceRecord = WithLocation<
  Omit<Place, "source" | "google_place_id" | "last_synced_at" | "import_category_id">
>;

/** Запись места: точка — долгота/широта (null — убрать), остальное — как в таблице. */
export type PlaceWrite = Omit<NewPlace, "location" | "region_id"> & { location?: LonLat | null };
export type PlacePatch = Omit<PlaceUpdate, "location"> & { location?: LonLat | null };
export type LocalityWrite = Omit<NewLocality, "location" | "region_id"> & { location?: LonLat | null };
export type LocalityPatch = Omit<LocalityUpdate, "location"> & { location?: LonLat | null };

export type PlaceListFilter = {
  status?: PlaceStatus;
  /** Категория или её подкатегории. */
  categoryId?: string;
  /** Шаблон ILIKE по названию (uk, en). */
  namePattern?: string;
  /** id последнего места предыдущей страницы (порядок — по id убыванию, новые сверху). */
  afterId?: string;
  limit: number;
};

/** Фото места с полями файла, нужными админке и проверке публикации. */
export type PlaceMediaRecord = {
  media_asset_id: string;
  sort_order: number;
  is_cover: boolean;
  alt_i18n: LocalizedText | null;
  status: string;
  mime: string;
  owner_type: string;
  owner_id: string;
};

export type ScheduleRows = {
  weekly: { day_of_week: number; opens_at: string; closes_at: string }[];
  exceptions: {
    date: string;
    closed: boolean;
    opens_at: string | null;
    closes_at: string | null;
    note_i18n: LocalizedText | null;
  }[];
};

const geo = (v: LonLat | null | undefined) => (v === undefined ? undefined : v === null ? null : point(v));

const LOCALITY_COLUMNS = [
  "id",
  "region_id",
  "code",
  "kind",
  "name_i18n",
  "sort_order",
  "active",
  "created_at",
  "updated_at",
] as const;

const PLACE_COLUMNS = [
  "places.id",
  "places.region_id",
  "places.category_id",
  "places.locality_id",
  "places.name_i18n",
  "places.description_i18n",
  "places.address_i18n",
  "places.phone",
  "places.website",
  "places.telegram",
  "places.status",
  "places.recommended",
  "places.verified_at",
  "places.first_published_at",
  "places.created_by",
  "places.organization_id",
  "places.partner_template_id",
  "places.created_at",
  "places.updated_at",
] as const;

@Injectable()
export class CatalogRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  private get q(): Db {
    return currentDb(this.db);
  }

  // --- localities ---

  listLocalities(): Promise<LocalityRecord[]> {
    return this.q
      .selectFrom("localities")
      .select(LOCALITY_COLUMNS)
      .select((eb) => lonLatOf(eb.ref("location")).as("location"))
      .orderBy("sort_order")
      .orderBy("code")
      .execute();
  }

  findLocality(id: string): Promise<LocalityRecord | undefined> {
    return this.q
      .selectFrom("localities")
      .select(LOCALITY_COLUMNS)
      .select((eb) => lonLatOf(eb.ref("location")).as("location"))
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async createLocality(row: LocalityWrite): Promise<LocalityRecord> {
    const { location, ...rest } = row;
    const { id } = await this.q
      .insertInto("localities")
      .values({ ...rest, location: geo(location) })
      .returning("id")
      .executeTakeFirstOrThrow();
    return (await this.findLocality(id))!;
  }

  async updateLocality(id: string, patch: LocalityPatch): Promise<LocalityRecord | undefined> {
    const { location, ...rest } = patch;
    const set = { ...rest, location: geo(location) };
    if (hasValues(set)) {
      const updated = await this.q
        .updateTable("localities")
        .set(set)
        .where("id", "=", id)
        .returning("id")
        .executeTakeFirst();
      if (!updated) return undefined;
    }
    return this.findLocality(id);
  }

  async deleteLocality(id: string): Promise<boolean> {
    const r = await this.q.deleteFrom("localities").where("id", "=", id).executeTakeFirst();
    return r.numDeletedRows > 0n;
  }

  // --- categories ---

  listCategories(): Promise<Category[]> {
    return this.q.selectFrom("categories").selectAll().orderBy("sort_order").orderBy("code").execute();
  }

  findCategory(id: string): Promise<Category | undefined> {
    return this.q.selectFrom("categories").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Блокировка строк категорий FOR UPDATE в порядке id (один порядок у всех транзакций — без взаимоблокировки). */
  async lockCategories(ids: readonly string[]): Promise<void> {
    const sorted = [...new Set(ids.map((i) => i.toLowerCase()))].sort();
    await this.q
      .selectFrom("categories")
      .select("id")
      .where("id", "in", sorted)
      .orderBy("id")
      .forUpdate()
      .execute();
  }

  /**
   * Блокировка FOR SHARE категории места и её родителя (по возрастанию id, как lockCategories): публикация и перенос
   * места не идут параллельно с выключением категории или раздела (оно берёт FOR UPDATE).
   */
  async shareLockCategory(id: string): Promise<void> {
    const row = await this.q
      .selectFrom("categories")
      .select("parent_id")
      .where("id", "=", id)
      .executeTakeFirst();
    const ids = [id, ...(row?.parent_id ? [row.parent_id] : [])].map((i) => i.toLowerCase()).sort();
    await this.q
      .selectFrom("categories")
      .select("id")
      .where("id", "in", ids)
      .orderBy("id")
      .forShare()
      .execute();
  }

  /** Опубликованные места категории и её подкатегорий. */
  async countPublishedInCategory(id: string): Promise<number> {
    const row = await this.q
      .selectFrom("places")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("places.status", "=", "published")
      .where((eb) =>
        eb.or([
          eb("places.category_id", "=", id),
          eb(
            "places.category_id",
            "in",
            eb.selectFrom("categories").select("categories.id").where("categories.parent_id", "=", id),
          ),
        ]),
      )
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async hasSubcategories(id: string): Promise<boolean> {
    const row = await this.q
      .selectFrom("categories")
      .select("id")
      .where("parent_id", "=", id)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  createCategory(row: Omit<NewCategory, "region_id">): Promise<Category> {
    return this.q.insertInto("categories").values(row).returningAll().executeTakeFirstOrThrow();
  }

  updateCategory(id: string, patch: CategoryUpdate): Promise<Category | undefined> {
    if (!hasValues(patch)) return this.findCategory(id);
    return this.q.updateTable("categories").set(patch).where("id", "=", id).returningAll().executeTakeFirst();
  }

  async deleteCategory(id: string): Promise<boolean> {
    const r = await this.q.deleteFrom("categories").where("id", "=", id).executeTakeFirst();
    return r.numDeletedRows > 0n;
  }

  // --- tags ---

  listTags(): Promise<Tag[]> {
    return this.q
      .selectFrom("tags")
      .selectAll()
      .orderBy("tag_group")
      .orderBy("sort_order")
      .orderBy("code")
      .execute();
  }

  findTag(id: string): Promise<Tag | undefined> {
    return this.q.selectFrom("tags").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Сколько из тегов есть в регионе контекста (чужие и несуществующие не считаются). */
  async countTags(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const row = await this.q
      .selectFrom("tags")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("id", "in", ids)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  createTag(row: Omit<NewTag, "region_id">): Promise<Tag> {
    return this.q.insertInto("tags").values(row).returningAll().executeTakeFirstOrThrow();
  }

  updateTag(id: string, patch: TagUpdate): Promise<Tag | undefined> {
    if (!hasValues(patch)) return this.findTag(id);
    return this.q.updateTable("tags").set(patch).where("id", "=", id).returningAll().executeTakeFirst();
  }

  async deleteTag(id: string): Promise<boolean> {
    const r = await this.q.deleteFrom("tags").where("id", "=", id).executeTakeFirst();
    return r.numDeletedRows > 0n;
  }

  // --- places ---

  /** Категории проживания (раздел stay и его подкатегории, hotels, sadyby) — места, которым нужен «Про заклад». */
  async stayCategoryIds(): Promise<Set<string>> {
    const roots = await this.q
      .selectFrom("categories")
      .select("id")
      .where("code", "in", [...STAY_CATEGORY_CODES])
      .execute();
    const ids = roots.map((r) => r.id);
    const kids = ids.length
      ? await this.q.selectFrom("categories").select("id").where("parent_id", "in", ids).execute()
      : [];
    return new Set([...ids, ...kids.map((k) => k.id)]);
  }

  /** Места, к которым привязан QR отеля (type = hotel). */
  async hotelQrPlaceIds(placeIds: readonly string[]): Promise<Set<string>> {
    if (placeIds.length === 0) return new Set();
    const rows = await this.q
      .selectFrom("qr_points")
      .select("place_id")
      .where("type", "=", "hotel")
      .where("place_id", "in", [...placeIds])
      .execute();
    return new Set(rows.flatMap((r) => (r.place_id ? [r.place_id] : [])));
  }

  listPlaces(filter: PlaceListFilter): Promise<PlaceRecord[]> {
    let query = this.q
      .selectFrom("places")
      .select(PLACE_COLUMNS)
      .select((eb) => lonLatOf(eb.ref("places.location")).as("location"));
    if (filter.status) query = query.where("places.status", "=", filter.status);
    if (filter.categoryId) {
      const categoryId = filter.categoryId;
      query = query.where((eb) =>
        eb.or([
          eb("places.category_id", "=", categoryId),
          eb(
            "places.category_id",
            "in",
            eb
              .selectFrom("categories")
              .select("categories.id")
              .where("categories.parent_id", "=", categoryId),
          ),
        ]),
      );
    }
    if (filter.namePattern) {
      const pattern = filter.namePattern;
      query = query.where((eb) =>
        eb.or([
          eb(eb.ref("places.name_i18n", "->>").key("uk"), "ilike", pattern),
          eb(eb.ref("places.name_i18n", "->>").key("en"), "ilike", pattern),
        ]),
      );
    }
    if (filter.afterId) query = query.where("places.id", "<", filter.afterId);
    return query.orderBy("places.id", "desc").limit(filter.limit).execute();
  }

  findPlace(id: string): Promise<PlaceRecord | undefined> {
    return this.q
      .selectFrom("places")
      .select(PLACE_COLUMNS)
      .select((eb) => lonLatOf(eb.ref("places.location")).as("location"))
      .where("places.id", "=", id)
      .executeTakeFirst();
  }

  /** Строка места FOR UPDATE: переходы статуса и бейдж — без гонки двух админов. */
  async lockPlace(id: string): Promise<PlaceRecord | undefined> {
    const row = await this.q
      .selectFrom("places")
      .select("id")
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    return row ? this.findPlace(id) : undefined;
  }

  async createPlace(row: PlaceWrite): Promise<PlaceRecord> {
    const { location, ...rest } = row;
    const { id } = await this.q
      .insertInto("places")
      .values({ ...rest, location: geo(location) })
      .returning("id")
      .executeTakeFirstOrThrow();
    return (await this.findPlace(id))!;
  }

  async updatePlace(id: string, patch: PlacePatch): Promise<PlaceRecord | undefined> {
    const { location, ...rest } = patch;
    const set = { ...rest, location: geo(location) };
    if (hasValues(set)) {
      const updated = await this.q
        .updateTable("places")
        .set(set)
        .where("id", "=", id)
        .returning("id")
        .executeTakeFirst();
      if (!updated) return undefined;
    }
    return this.findPlace(id);
  }

  async deletePlace(id: string): Promise<boolean> {
    const r = await this.q.deleteFrom("places").where("id", "=", id).executeTakeFirst();
    return r.numDeletedRows > 0n;
  }

  /** Дополнительные категории места (0020): место видно и в этих разделах. */
  async placeExtraCategoryIds(placeId: string): Promise<string[]> {
    const rows = await this.q
      .selectFrom("place_extra_categories")
      .select("category_id")
      .where("place_id", "=", placeId)
      .orderBy("category_id")
      .execute();
    return rows.map((r) => r.category_id);
  }

  /** Сколько из id — активные категории, годные в дополнительные (0020): корень или подкатегория активного раздела. */
  async countAssignableCategories(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const cats = await this.q
      .selectFrom("categories")
      .select(["id", "parent_id"])
      .where("id", "in", ids)
      .where("active", "=", true)
      .execute();
    const parentIds = [...new Set(cats.flatMap((c) => (c.parent_id ? [c.parent_id] : [])))];
    const live = new Set<string>();
    if (parentIds.length > 0) {
      const parents = await this.q
        .selectFrom("categories")
        .select("id")
        .where("id", "in", parentIds)
        .where("active", "=", true)
        .execute();
      for (const p of parents) live.add(p.id);
    }
    return cats.filter((c) => !c.parent_id || live.has(c.parent_id)).length;
  }

  /**
   * Заменить дополнительные категории места правкой админки: все строки становятся manual (повторный импорт
   * пересобирает только source = import и на конфликте ничего не перезаписывает, так что ручные сохраняются).
   */
  async replacePlaceExtraCategories(placeId: string, categoryIds: readonly string[]): Promise<void> {
    await this.q.deleteFrom("place_extra_categories").where("place_id", "=", placeId).execute();
    if (categoryIds.length > 0) {
      await this.q
        .insertInto("place_extra_categories")
        .values(
          categoryIds.map((category_id) => ({ place_id: placeId, category_id, source: "manual" as const })),
        )
        .execute();
    }
  }

  async placeTagIds(placeId: string): Promise<string[]> {
    const rows = await this.q
      .selectFrom("place_tags")
      .select("tag_id")
      .where("place_id", "=", placeId)
      .orderBy("tag_id")
      .execute();
    return rows.map((r) => r.tag_id);
  }

  async replacePlaceTags(placeId: string, tagIds: readonly string[]): Promise<void> {
    await this.q.deleteFrom("place_tags").where("place_id", "=", placeId).execute();
    if (tagIds.length > 0)
      await this.q
        .insertInto("place_tags")
        .values(tagIds.map((tag_id) => ({ place_id: placeId, tag_id })))
        .execute();
  }

  // --- schedule ---

  async schedule(placeId: string): Promise<ScheduleRows> {
    const weekly = await this.q
      .selectFrom("place_schedules")
      .select(["day_of_week", "opens_at", "closes_at"])
      .where("place_id", "=", placeId)
      .orderBy("day_of_week")
      .orderBy("opens_at")
      .execute();
    const exceptions = await this.q
      .selectFrom("place_schedule_exceptions")
      // date pg отдаёт как Date в часовом поясе процесса — читаем строкой.
      .select((eb) => sql<string>`to_char(${eb.ref("date")}, 'YYYY-MM-DD')`.as("date"))
      .select(["closed", "opens_at", "closes_at", "note_i18n"])
      .where("place_id", "=", placeId)
      .orderBy("date")
      .orderBy("opens_at")
      .execute();
    return { weekly, exceptions };
  }

  async replaceSchedule(placeId: string, rows: ScheduleRows): Promise<void> {
    await this.q.deleteFrom("place_schedules").where("place_id", "=", placeId).execute();
    await this.q.deleteFrom("place_schedule_exceptions").where("place_id", "=", placeId).execute();
    if (rows.weekly.length > 0)
      await this.q
        .insertInto("place_schedules")
        .values(rows.weekly.map((w) => ({ place_id: placeId, ...w })))
        .execute();
    if (rows.exceptions.length > 0)
      await this.q
        .insertInto("place_schedule_exceptions")
        .values(rows.exceptions.map((e) => ({ place_id: placeId, ...e })))
        .execute();
  }

  // --- media ---

  placeMedia(placeId: string): Promise<PlaceMediaRecord[]> {
    return this.q
      .selectFrom("place_media")
      .innerJoin("media_assets", "media_assets.id", "place_media.media_asset_id")
      .select([
        "place_media.media_asset_id",
        "place_media.sort_order",
        "place_media.is_cover",
        "media_assets.alt_i18n",
        "media_assets.status",
        "media_assets.mime",
        "media_assets.owner_type",
        "media_assets.owner_id",
      ])
      .where("place_media.place_id", "=", placeId)
      .orderBy("place_media.sort_order")
      .orderBy("place_media.created_at")
      .execute();
  }

  /** Файл региона контекста (для привязки к месту). */
  findMediaAsset(
    id: string,
  ): Promise<{ id: string; kind: string; status: string; owner_type: string; owner_id: string } | undefined> {
    return this.q
      .selectFrom("media_assets")
      .select(["id", "kind", "status", "owner_type", "owner_id"])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async attachMedia(placeId: string, assetId: string, sortOrder: number): Promise<void> {
    await this.q
      .insertInto("place_media")
      .values({ place_id: placeId, media_asset_id: assetId, sort_order: sortOrder })
      .execute();
  }

  async nextMediaOrder(placeId: string): Promise<number> {
    const row = await this.q
      .selectFrom("place_media")
      .select((eb) => eb.fn.max("sort_order").as("max"))
      .where("place_id", "=", placeId)
      .executeTakeFirst();
    return row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
  }

  async updateMediaLink(
    placeId: string,
    assetId: string,
    patch: { sort_order?: number; is_cover?: boolean },
  ): Promise<boolean> {
    if (patch.is_cover)
      // Одна обложка на место (уникальный частичный индекс): сначала снимаем прежнюю.
      await this.q
        .updateTable("place_media")
        .set({ is_cover: false })
        .where("place_id", "=", placeId)
        .where("is_cover", "=", true)
        .where("media_asset_id", "<>", assetId)
        .execute();
    if (!hasValues(patch)) return this.mediaLinked(placeId, assetId);
    const r = await this.q
      .updateTable("place_media")
      .set(patch)
      .where("place_id", "=", placeId)
      .where("media_asset_id", "=", assetId)
      .executeTakeFirst();
    return r.numUpdatedRows > 0n;
  }

  async mediaLinked(placeId: string, assetId: string): Promise<boolean> {
    const row = await this.q
      .selectFrom("place_media")
      .select("id")
      .where("place_id", "=", placeId)
      .where("media_asset_id", "=", assetId)
      .executeTakeFirst();
    return !!row;
  }

  async setMediaAlt(assetId: string, alt: LocalizedText | null): Promise<void> {
    await this.q.updateTable("media_assets").set({ alt_i18n: alt }).where("id", "=", assetId).execute();
  }

  async detachMedia(placeId: string, assetId: string): Promise<boolean> {
    const r = await this.q
      .deleteFrom("place_media")
      .where("place_id", "=", placeId)
      .where("media_asset_id", "=", assetId)
      .executeTakeFirst();
    return r.numDeletedRows > 0n;
  }

  // --- badge ---

  appendBadgeEvent(event: {
    place_id: string;
    action: "grant" | "revoke";
    reason: string;
    actor_user_id: string | null;
  }): Promise<PlaceBadgeEvent> {
    return this.q.insertInto("place_badge_events").values(event).returningAll().executeTakeFirstOrThrow();
  }

  badgeHistory(placeId: string): Promise<PlaceBadgeEvent[]> {
    return this.q
      .selectFrom("place_badge_events")
      .selectAll()
      .where("place_id", "=", placeId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
  }

  async hasBadgeHistory(placeId: string): Promise<boolean> {
    const row = await this.q
      .selectFrom("place_badge_events")
      .select("id")
      .where("place_id", "=", placeId)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }
}
