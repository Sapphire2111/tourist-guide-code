import { Inject, Injectable } from "@nestjs/common";
import {
  currentDb,
  currentTenant,
  InjectDb,
  type BoundingBox,
  type Category,
  type CategoryUpdate,
  type Db,
  type HomeSection,
  type JsonObject,
  type LocalizedText,
  type LocalityKind,
  type LonLat,
  type PlaceBadgeEvent,
  type PlaceStatus,
  type Tag,
  type TagGroup,
  type TagUpdate,
} from "../../db/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import {
  archiveNeedsDelete,
  canTransition,
  likePattern,
  publishProblems,
  scheduleProblems,
  TRANSITION_TARGET,
  type PlaceTransition,
  type PublishProblem,
  type ScheduleException,
  type ScheduleProblem,
  type WeeklyInterval,
} from "./catalog-rules.js";
import {
  CatalogRepository,
  type LocalityPatch,
  type LocalityRecord,
  type LocalityWrite,
  type PlaceMediaRecord,
  type PlacePatch,
  type PlaceRecord,
} from "./catalog.repository.js";

export type CatalogErrorReason =
  | "not_found"
  | "region_context_required"
  | "platform_context_required"
  | "code_taken"
  | "timezone_invalid"
  | "in_use"
  | "parent_not_found"
  | "parent_not_root"
  | "has_subcategories"
  | "category_has_published_places"
  | "category_not_found"
  | "locality_not_found"
  | "tags_not_found"
  | "extra_categories_invalid"
  | "invalid_transition"
  | "not_publishable"
  | "moderation_required"
  | "not_deletable"
  | "archive_never_published"
  | "schedule_invalid"
  | "media_not_found"
  | "media_not_image"
  | "media_owner_mismatch"
  | "media_rejected"
  | "media_already_linked"
  | "already_recommended"
  | "not_recommended";

/** Отказ операции каталога; HTTP-код выбирает контроллер (catalog-http.ts). */
export class CatalogError extends Error {
  override readonly name = "CatalogError";

  constructor(
    readonly reason: CatalogErrorReason,
    readonly problems: readonly (PublishProblem | ScheduleProblem)[] = [],
  ) {
    super(`Catalog: ${reason}${problems.length ? ` (${problems.join(", ")})` : ""}`);
  }
}

/** Кто действует (auditFromRequest): актор, назначение, correlation id, ПДн запроса. */
export type AuditMeta = Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">;

export type LocalityInput = {
  code: string;
  kind?: LocalityKind;
  name: LocalizedText;
  location?: LonLat | null;
  sortOrder?: number;
  active?: boolean;
};

export type CategoryInput = {
  code: string;
  parentId?: string | null;
  name: LocalizedText;
  icon?: string | null;
  homeSection?: HomeSection | null;
  sortOrder?: number;
  active?: boolean;
};

export type TagInput = {
  code: string;
  name: LocalizedText;
  group?: TagGroup;
  sortOrder?: number;
  active?: boolean;
};

export type PlaceInput = {
  categoryId: string;
  localityId?: string | null;
  name: LocalizedText;
  description?: LocalizedText | null;
  address?: LocalizedText | null;
  location?: LonLat | null;
  phone?: string | null;
  website?: string | null;
  telegram?: string | null;
  verifiedAt?: string | null;
  tagIds?: string[];
  /** Дополнительные категории (0020): активные разделы и их подкатегории, не основная, не больше MAX_EXTRA_CATEGORIES. */
  extraCategoryIds?: string[];
};

export const MAX_EXTRA_CATEGORIES = 5;

/** Действие аудита «админка правила доп. категории места» (читает импорт Google, places-import/writer.ts). */
export const EXTRA_CATEGORIES_EDIT_ACTION = "place.extra_categories.edit";

export type PlaceDetails = PlaceRecord & { tagIds: string[]; extraCategoryIds?: string[] };

export type PlaceSchedule = {
  timezone: string;
  weekly: WeeklyInterval[];
  exceptions: (ScheduleException & { note: LocalizedText | null })[];
};

export type ScheduleInput = {
  weekly: WeeklyInterval[];
  exceptions: (ScheduleException & { note?: LocalizedText | null })[];
};

export type PlaceMediaInput = {
  alt?: LocalizedText | null;
  sortOrder?: number;
  isCover?: boolean;
};

/** Ошибка БД → CatalogError по коду и ограничению (иначе — как есть, 500). */
const CONSTRAINT_ERRORS: Readonly<Record<string, CatalogErrorReason>> = {
  "23505:regions_code_key": "code_taken",
  "23505:localities_region_code_key": "code_taken",
  "23505:categories_region_code_key": "code_taken",
  "23505:tags_region_code_key": "code_taken",
  "23505:place_media_asset_key": "media_already_linked",
  "23503:places_category_fk": "category_not_found",
  "23503:places_locality_fk": "locality_not_found",
  "23503:categories_parent_fk": "parent_not_found",
  // Удаление справочника, на который ссылаются (RESTRICT).
  "23503:places_category_fk:delete": "in_use",
  "23503:places_locality_fk:delete": "in_use",
  "23503:categories_parent_fk:delete": "in_use",
  // Место в пункте сценария (0015, блок 5) или с заявками гостей — не удаляется (RESTRICT).
  "23503:scenario_items_place_fk:delete": "in_use",
  "23503:service_requests_place_fk:delete": "in_use",
  // Брони, ресурсы, согласия на телефон, отзывы и история бейджа (0012, 0022, 0028) — тоже RESTRICT: 409, не 500.
  "23503:resources_place_fk:delete": "in_use",
  "23503:bookings_place_fk:delete": "in_use",
  "23503:partner_phone_consents_place_fk:delete": "in_use",
  "23503:review_eligibilities_place_fk:delete": "in_use",
  "23503:reviews_place_fk:delete": "in_use",
  "23503:place_badge_events_place_fk:delete": "in_use",
  "23514:categories_depth": "parent_not_root",
};

export function mapDbError(e: unknown, op: "write" | "delete" = "write"): unknown {
  if (typeof e !== "object" || e === null) return e;
  const { code, constraint } = e as { code?: unknown; constraint?: unknown };
  const key = `${String(code)}:${String(constraint)}`;
  const reason = (op === "delete" && CONSTRAINT_ERRORS[`${key}:delete`]) || CONSTRAINT_ERRORS[key];
  return reason ? new CatalogError(reason) : e;
}

export async function guarded<T>(fn: () => Promise<T>, op: "write" | "delete" = "write"): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapDbError(e, op);
  }
}

/** Регион запроса: каталог — tenant-данные, нужен контекст региона (PLATFORM без выбранного региона — 403). */
export function requireRegionContext(): string {
  const tenant = currentTenant();
  if (tenant?.kind !== "region") throw new CatalogError("region_context_required");
  return tenant.regionId;
}

/** Снимок места для аудита (без служебных полей). */
function placeSnapshot(
  p: PlaceRecord,
  tagIds?: readonly string[],
  extraCategoryIds?: readonly string[],
): JsonObject {
  return {
    status: p.status,
    categoryId: p.category_id,
    localityId: p.locality_id,
    name: p.name_i18n,
    description: p.description_i18n,
    address: p.address_i18n,
    location: p.location,
    phone: p.phone,
    website: p.website,
    telegram: p.telegram,
    recommended: p.recommended,
    verifiedAt: p.verified_at?.toISOString() ?? null,
    ...(tagIds ? { tagIds: [...tagIds] } : {}),
    ...(extraCategoryIds ? { extraCategoryIds: [...extraCategoryIds] } : {}),
  };
}

/**
 * Каталог региона для админки (блок 3, ADR-0017): справочники (населённые пункты, категории, теги) и места — CRUD,
 * статусы, график, фото, бейдж «Ми рекомендуємо». Каждое изменение — запись в audit_logs в той же транзакции.
 * Вызывается внутри транзакции запроса (TenantContextInterceptor → withTenant) в контексте региона.
 */
@Injectable()
export class CatalogService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(CatalogRepository) private readonly repo: CatalogRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Отдельная запись об изменении доп. категорий: по ней (action = EXTRA_CATEGORIES_EDIT_ACTION, актор-пользователь)
   * импорт Google узнаёт, что набор места правила админка, и больше его не пересобирает — в том числе когда админ
   * очистил список (строк нет, а след остался).
   */
  private async recordExtraEdit(
    meta: AuditMeta,
    placeId: string,
    before: readonly string[],
    after: readonly string[],
  ): Promise<void> {
    await this.record(meta, {
      action: EXTRA_CATEGORIES_EDIT_ACTION,
      entityType: "place",
      entityId: placeId,
      oldValues: { extraCategoryIds: [...before] },
      newValues: { extraCategoryIds: [...after] },
    });
  }

  private async record(meta: AuditMeta, entry: Omit<AuditEntry, keyof AuditMeta>): Promise<void> {
    await this.audit.record(currentDb(this.db), { ...meta, ...entry });
  }

  // --- localities ---

  listLocalities(): Promise<LocalityRecord[]> {
    requireRegionContext();
    return this.repo.listLocalities();
  }

  async getLocality(id: string): Promise<LocalityRecord> {
    requireRegionContext();
    return (await this.repo.findLocality(id)) ?? notFound();
  }

  async createLocality(meta: AuditMeta, input: LocalityInput): Promise<LocalityRecord> {
    requireRegionContext();
    const row: LocalityWrite = {
      code: input.code,
      kind: input.kind,
      name_i18n: input.name,
      location: input.location,
      sort_order: input.sortOrder,
      active: input.active,
    };
    const created = await guarded(() => this.repo.createLocality(row));
    await this.record(meta, {
      action: "locality.create",
      entityType: "locality",
      entityId: created.id,
      newValues: localitySnapshot(created),
    });
    return created;
  }

  async updateLocality(meta: AuditMeta, id: string, input: Partial<LocalityInput>): Promise<LocalityRecord> {
    requireRegionContext();
    const before = (await this.repo.findLocality(id)) ?? notFound();
    const patch: LocalityPatch = {
      code: input.code,
      kind: input.kind,
      name_i18n: input.name,
      location: input.location,
      sort_order: input.sortOrder,
      active: input.active,
    };
    const after = (await guarded(() => this.repo.updateLocality(id, patch))) ?? notFound();
    await this.record(meta, {
      action: "locality.update",
      entityType: "locality",
      entityId: id,
      oldValues: localitySnapshot(before),
      newValues: localitySnapshot(after),
    });
    return after;
  }

  async deleteLocality(meta: AuditMeta, id: string): Promise<void> {
    requireRegionContext();
    const before = (await this.repo.findLocality(id)) ?? notFound();
    await guarded(() => this.repo.deleteLocality(id), "delete");
    await this.record(meta, {
      action: "locality.delete",
      entityType: "locality",
      entityId: id,
      oldValues: localitySnapshot(before),
    });
  }

  // --- categories ---

  listCategories(): Promise<Category[]> {
    requireRegionContext();
    return this.repo.listCategories();
  }

  async getCategory(id: string): Promise<Category> {
    requireRegionContext();
    return (await this.repo.findCategory(id)) ?? notFound();
  }

  /**
   * Один уровень: родитель — корневая категория региона; у подкатегории нет кнопки главной. Строки самой категории и
   * родителя блокируются (FOR UPDATE, по возрастанию id — без взаимоблокировки): параллельные PATCH «A под B» и
   * «B под A» или вставка подкатегории под A, пока A становится подкатегорией, выполняются по очереди, и вторая
   * проверка видит результат первой (триггер categories_check_depth без блокировок такую гонку не ловит).
   */
  private async checkParent(id: string | null, parentId: string | null | undefined): Promise<void> {
    if (!parentId) return;
    await this.repo.lockCategories([parentId, ...(id ? [id] : [])]);
    const parent = await this.repo.findCategory(parentId);
    if (!parent) throw new CatalogError("parent_not_found");
    if (parent.parent_id !== null || parent.id === id) throw new CatalogError("parent_not_root");
    if (id && (await this.repo.hasSubcategories(id))) throw new CatalogError("has_subcategories");
  }

  async createCategory(meta: AuditMeta, input: CategoryInput): Promise<Category> {
    requireRegionContext();
    await this.checkParent(null, input.parentId);
    const created = await guarded(() =>
      this.repo.createCategory({
        code: input.code,
        parent_id: input.parentId ?? null,
        name_i18n: input.name,
        icon: input.icon ?? null,
        home_section: input.parentId ? null : (input.homeSection ?? null),
        sort_order: input.sortOrder,
        active: input.active,
      }),
    );
    await this.record(meta, {
      action: "category.create",
      entityType: "category",
      entityId: created.id,
      newValues: categorySnapshot(created),
    });
    return created;
  }

  async updateCategory(meta: AuditMeta, id: string, input: Partial<CategoryInput>): Promise<Category> {
    requireRegionContext();
    const before = (await this.repo.findCategory(id)) ?? notFound();
    if (input.parentId !== undefined) await this.checkParent(id, input.parentId);
    // Выключить категорию (или раздел) с опубликованными местами нельзя: раздел пропал бы у туриста, а места остались
    // бы опубликованными без навигации. Сначала приостановить или перенести места (ADR-0017).
    // FOR UPDATE строки категории — до подсчёта: публикация и перенос места берут её FOR SHARE (shareLockCategory),
    // поэтому «выключение ∥ публикация» выполняются по очереди и вторая операция видит результат первой.
    if (input.active === false && before.active) {
      await this.repo.lockCategories([id]);
      if ((await this.repo.countPublishedInCategory(id)) > 0)
        throw new CatalogError("category_has_published_places");
    }
    const parentAfter = input.parentId !== undefined ? input.parentId : before.parent_id;
    const patch: CategoryUpdate = {
      code: input.code,
      parent_id: input.parentId,
      name_i18n: input.name,
      icon: input.icon,
      // Подкатегория не бывает кнопкой главной (CHECK categories_home_section_root_only).
      home_section: parentAfter ? null : input.homeSection,
      sort_order: input.sortOrder,
      active: input.active,
    };
    const after = (await guarded(() => this.repo.updateCategory(id, patch))) ?? notFound();
    await this.record(meta, {
      action: "category.update",
      entityType: "category",
      entityId: id,
      oldValues: categorySnapshot(before),
      newValues: categorySnapshot(after),
    });
    return after;
  }

  async deleteCategory(meta: AuditMeta, id: string): Promise<void> {
    requireRegionContext();
    const before = (await this.repo.findCategory(id)) ?? notFound();
    await guarded(() => this.repo.deleteCategory(id), "delete");
    await this.record(meta, {
      action: "category.delete",
      entityType: "category",
      entityId: id,
      oldValues: categorySnapshot(before),
    });
  }

  // --- tags ---

  listTags(): Promise<Tag[]> {
    requireRegionContext();
    return this.repo.listTags();
  }

  async getTag(id: string): Promise<Tag> {
    requireRegionContext();
    return (await this.repo.findTag(id)) ?? notFound();
  }

  async createTag(meta: AuditMeta, input: TagInput): Promise<Tag> {
    requireRegionContext();
    const created = await guarded(() =>
      this.repo.createTag({
        code: input.code,
        name_i18n: input.name,
        tag_group: input.group,
        sort_order: input.sortOrder,
        active: input.active,
      }),
    );
    await this.record(meta, {
      action: "tag.create",
      entityType: "tag",
      entityId: created.id,
      newValues: tagSnapshot(created),
    });
    return created;
  }

  async updateTag(meta: AuditMeta, id: string, input: Partial<TagInput>): Promise<Tag> {
    requireRegionContext();
    const before = (await this.repo.findTag(id)) ?? notFound();
    const patch: TagUpdate = {
      code: input.code,
      name_i18n: input.name,
      tag_group: input.group,
      sort_order: input.sortOrder,
      active: input.active,
    };
    const after = (await guarded(() => this.repo.updateTag(id, patch))) ?? notFound();
    await this.record(meta, {
      action: "tag.update",
      entityType: "tag",
      entityId: id,
      oldValues: tagSnapshot(before),
      newValues: tagSnapshot(after),
    });
    return after;
  }

  async deleteTag(meta: AuditMeta, id: string): Promise<void> {
    requireRegionContext();
    const before = (await this.repo.findTag(id)) ?? notFound();
    // Связи place_tags удаляются каскадом.
    await guarded(() => this.repo.deleteTag(id), "delete");
    await this.record(meta, {
      action: "tag.delete",
      entityType: "tag",
      entityId: id,
      oldValues: tagSnapshot(before),
    });
  }

  // --- places ---

  /** Страница мест региона (новые сверху); limit + 1 строк — признак следующей страницы. */
  async listPlaces(filter: {
    status?: PlaceStatus;
    categoryId?: string;
    q?: string;
    /** Рамка карты: только места с точкой внутри. */
    bbox?: BoundingBox;
    afterId?: string;
    limit: number;
  }): Promise<{ items: PlaceRecord[]; hasMore: boolean }> {
    requireRegionContext();
    const rows = await this.repo.listPlaces({
      status: filter.status,
      categoryId: filter.categoryId,
      namePattern: filter.q?.trim() ? likePattern(filter.q) : undefined,
      bbox: filter.bbox,
      afterId: filter.afterId,
      limit: filter.limit + 1,
    });
    return { items: rows.slice(0, filter.limit), hasMore: rows.length > filter.limit };
  }

  /**
   * Места, которым нужен «Про заклад» (блок 5): категория проживания или привязанный QR отеля. Для признака
   * hostCapable в админке.
   */
  async hostCapablePlaceIds(places: readonly { id: string; category_id: string }[]): Promise<Set<string>> {
    if (places.length === 0) return new Set();
    const [stay, qr] = await Promise.all([
      this.repo.stayCategoryIds(),
      this.repo.hotelQrPlaceIds(places.map((p) => p.id)),
    ]);
    return new Set(places.filter((p) => stay.has(p.category_id) || qr.has(p.id)).map((p) => p.id));
  }

  async getPlace(id: string): Promise<PlaceDetails> {
    requireRegionContext();
    const place = (await this.repo.findPlace(id)) ?? notFound();
    const [tagIds, extraCategoryIds] = await Promise.all([
      this.repo.placeTagIds(id),
      this.repo.placeExtraCategoryIds(id),
    ]);
    return { ...place, tagIds, extraCategoryIds };
  }

  private async checkRefs(input: Partial<PlaceInput>, mainCategoryId?: string): Promise<void> {
    if (input.categoryId !== undefined) {
      await this.repo.shareLockCategory(input.categoryId);
      if (!(await this.repo.findCategory(input.categoryId))) throw new CatalogError("category_not_found");
    }
    if (input.localityId && !(await this.repo.findLocality(input.localityId)))
      throw new CatalogError("locality_not_found");
    if (input.tagIds) {
      const unique = [...new Set(input.tagIds)];
      if ((await this.repo.countTags(unique)) !== unique.length) throw new CatalogError("tags_not_found");
    }
    if (input.extraCategoryIds) {
      const unique = [...new Set(input.extraCategoryIds)];
      const main = (input.categoryId ?? mainCategoryId)?.toLowerCase();
      if (
        unique.length > MAX_EXTRA_CATEGORIES ||
        unique.some((c) => c.toLowerCase() === main) ||
        (await this.repo.countAssignableCategories(unique)) !== unique.length
      )
        throw new CatalogError("extra_categories_invalid");
    }
  }

  async createPlace(meta: AuditMeta, input: PlaceInput): Promise<PlaceDetails> {
    requireRegionContext();
    await this.checkRefs(input);
    const created = await guarded(() =>
      this.repo.createPlace({
        category_id: input.categoryId,
        locality_id: input.localityId ?? null,
        name_i18n: input.name,
        description_i18n: input.description ?? null,
        address_i18n: input.address ?? null,
        location: input.location ?? null,
        phone: input.phone ?? null,
        website: input.website ?? null,
        telegram: input.telegram ?? null,
        verified_at: input.verifiedAt ?? null,
        created_by: meta.actor.type === "user" ? meta.actor.userId : null,
      }),
    );
    const tagIds = [...new Set(input.tagIds ?? [])].sort();
    await this.repo.replacePlaceTags(created.id, tagIds);
    const extraCategoryIds = [...new Set(input.extraCategoryIds ?? [])].sort();
    if (extraCategoryIds.length) await this.repo.replacePlaceExtraCategories(created.id, extraCategoryIds);
    await this.record(meta, {
      action: "place.create",
      entityType: "place",
      entityId: created.id,
      newValues: placeSnapshot(created, tagIds, extraCategoryIds),
    });
    if (extraCategoryIds.length) await this.recordExtraEdit(meta, created.id, [], extraCategoryIds);
    return { ...created, tagIds, extraCategoryIds };
  }

  /** Правка сразу в живую версию (§1.6 — без PlaceRevision); опубликованное место должно остаться готовым. */
  async updatePlace(meta: AuditMeta, id: string, input: Partial<PlaceInput>): Promise<PlaceDetails> {
    requireRegionContext();
    const before = (await this.repo.lockPlace(id)) ?? notFound();
    const tagsBefore = await this.repo.placeTagIds(id);
    const extrasBefore = await this.repo.placeExtraCategoryIds(id);
    await this.checkRefs(input, before.category_id);
    // Новая основная категория не должна дублироваться в старых дополнительных — снять её оттуда.
    const newMain = input.categoryId?.toLowerCase();
    const extraWanted =
      input.extraCategoryIds ??
      (newMain && extrasBefore.includes(newMain) ? extrasBefore.filter((c) => c !== newMain) : undefined);
    const patch: PlacePatch = {
      category_id: input.categoryId,
      locality_id: input.localityId,
      name_i18n: input.name,
      description_i18n: input.description,
      address_i18n: input.address,
      location: input.location,
      phone: input.phone,
      website: input.website,
      telegram: input.telegram,
      verified_at: input.verifiedAt,
    };
    if (before.status === "published") {
      // Перенос опубликованного места в неактивную категорию запрещён (место пропало бы у туриста).
      const moved = input.categoryId !== undefined && input.categoryId.toLowerCase() !== before.category_id;
      await this.assertPublishable({ ...before, ...applied(before, input) }, moved ? "move" : "edit");
    }
    const after = (await guarded(() => this.repo.updatePlace(id, patch))) ?? notFound();
    // uuid из БД — в нижнем регистре: сравнение и разница — по нему же.
    const tagIds = input.tagIds ? [...new Set(input.tagIds.map((t) => t.toLowerCase()))].sort() : tagsBefore;
    // Админка присылает теги всегда: тот же набор — строки не трогаем, иначе — по разнице (источник оставшихся тегов
    // import/reviews сохраняется, «за відгуками Google» не пропадает).
    if (input.tagIds && tagIds.join() !== tagsBefore.join())
      await this.repo.syncPlaceTags(id, tagsBefore, tagIds);
    const extraCategoryIds = extraWanted ? [...new Set(extraWanted)].sort() : extrasBefore;
    // Набор не изменился — строки не трогаем (иначе import молча стал бы manual).
    const extrasChanged = !!extraWanted && extraCategoryIds.join() !== extrasBefore.join();
    if (extrasChanged) await this.repo.replacePlaceExtraCategories(id, extraCategoryIds);
    await this.record(meta, {
      action: "place.edit",
      entityType: "place",
      entityId: id,
      oldValues: placeSnapshot(before, tagsBefore, extrasBefore),
      newValues: placeSnapshot(after, tagIds, extraCategoryIds),
    });
    if (extrasChanged) await this.recordExtraEdit(meta, id, extrasBefore, extraCategoryIds);
    return { ...after, tagIds, extraCategoryIds };
  }

  /** Удалить можно только ни разу не публиковавшееся место без истории бейджа; остальное — в архив. */
  async deletePlace(meta: AuditMeta, id: string): Promise<void> {
    requireRegionContext();
    const before = (await this.repo.lockPlace(id)) ?? notFound();
    if (before.first_published_at !== null || (await this.repo.hasBadgeHistory(id)))
      throw new CatalogError("not_deletable");
    await guarded(() => this.repo.deletePlace(id), "delete");
    await this.record(meta, {
      action: "place.delete",
      entityType: "place",
      entityId: id,
      oldValues: placeSnapshot(before),
    });
  }

  private async problemsOf(place: PlaceRecord): Promise<PublishProblem[]> {
    const category = await this.repo.findCategory(place.category_id);
    const media = await this.repo.placeMedia(place.id);
    return publishProblems({
      place: {
        description_i18n: place.description_i18n,
        address_i18n: place.address_i18n,
        hasLocation: place.location !== null,
      },
      categoryActive: !!category?.active,
      media: media.map((m) => ({ alt: m.alt_i18n, status: m.status })),
    });
  }

  /**
   * publish — все правила; edit (правка опубликованного места, работа с его фото) — только обязательные поля и alt
   * text: неактивная категория и отклонённое фото возникают не по вине правки и не должны блокировать исправление
   * карточки (их ловит следующая публикация). move — правка с переносом в другую категорию: ещё и активность новой
   * категории.
   */
  private async assertPublishable(
    place: PlaceRecord,
    mode: "publish" | "edit" | "move" = "publish",
  ): Promise<void> {
    const all = await this.problemsOf(place);
    const problems =
      mode === "publish"
        ? all
        : all.filter((p) => EDIT_PROBLEMS.has(p) || (mode === "move" && p === "category_inactive"));
    if (problems.length > 0) throw new CatalogError("not_publishable", problems);
  }

  /** Проблемы публикации без изменения (для экрана карточки: что заполнить). */
  async publishCheck(id: string): Promise<PublishProblem[]> {
    requireRegionContext();
    return this.problemsOf((await this.repo.findPlace(id)) ?? notFound());
  }

  async transition(
    meta: AuditMeta,
    id: string,
    action: PlaceTransition,
    reason: string | null,
  ): Promise<PlaceDetails> {
    requireRegionContext();
    const before = (await this.repo.lockPlace(id)) ?? notFound();
    if (!canTransition(before.status, action)) throw new CatalogError("invalid_transition");
    if (archiveNeedsDelete(action, before.first_published_at))
      throw new CatalogError("archive_never_published");
    // Место партнёра (блок 6, ADR-0021) впервые публикуется только решением модератора (AD02), не админом напрямую.
    if (action === "publish" && !!before.organization_id && !before.first_published_at)
      throw new CatalogError("moderation_required");
    if (action === "publish") {
      await this.repo.shareLockCategory(before.category_id);
      await this.assertPublishable(before);
    }
    const status = TRANSITION_TARGET[action];
    const after =
      (await this.repo.updatePlace(id, {
        status,
        first_published_at:
          action === "publish" && before.first_published_at === null ? new Date() : undefined,
      })) ?? notFound();
    await this.record(meta, {
      action: `place.${action}`,
      entityType: "place",
      entityId: id,
      reason,
      oldValues: { status: before.status },
      newValues: { status: after.status },
    });
    return { ...after, tagIds: await this.repo.placeTagIds(id) };
  }

  // --- schedule ---

  async getSchedule(id: string): Promise<PlaceSchedule> {
    requireRegionContext();
    if (!(await this.repo.findPlace(id))) notFound();
    return this.scheduleOf(id);
  }

  private async scheduleOf(id: string): Promise<PlaceSchedule> {
    const rows = await this.repo.schedule(id);
    return {
      timezone: await this.regionTimezone(),
      weekly: rows.weekly.map((w) => ({
        dayOfWeek: w.day_of_week,
        opensAt: hhmm(w.opens_at),
        closesAt: hhmm(w.closes_at),
      })),
      exceptions: rows.exceptions.map((e) => ({
        date: e.date,
        closed: e.closed,
        opensAt: e.opens_at === null ? null : hhmm(e.opens_at),
        closesAt: e.closes_at === null ? null : hhmm(e.closes_at),
        note: e.note_i18n,
      })),
    };
  }

  private async regionTimezone(): Promise<string> {
    const regionId = requireRegionContext();
    const region = await currentDb(this.db)
      .selectFrom("regions")
      .select("timezone")
      .where("id", "=", regionId)
      .executeTakeFirst();
    return region?.timezone ?? "Europe/Kyiv";
  }

  /** Замена графика целиком (недельные интервалы и исключения). */
  async replaceSchedule(meta: AuditMeta, id: string, input: ScheduleInput): Promise<PlaceSchedule> {
    requireRegionContext();
    if (!(await this.repo.lockPlace(id))) notFound();
    const problems = scheduleProblems(input.weekly, input.exceptions);
    if (problems.length > 0) throw new CatalogError("schedule_invalid", problems);
    const before = await this.scheduleOf(id);
    await this.repo.replaceSchedule(id, {
      weekly: input.weekly.map((w) => ({
        day_of_week: w.dayOfWeek,
        opens_at: w.opensAt,
        closes_at: w.closesAt,
      })),
      exceptions: input.exceptions.map((e) => ({
        date: e.date,
        closed: e.closed,
        opens_at: e.closed ? null : (e.opensAt ?? null),
        closes_at: e.closed ? null : (e.closesAt ?? null),
        note_i18n: e.note ?? null,
      })),
    });
    const after = await this.scheduleOf(id);
    await this.record(meta, {
      action: "schedule.edit",
      entityType: "place",
      entityId: id,
      oldValues: { weekly: before.weekly, exceptions: before.exceptions },
      newValues: { weekly: after.weekly, exceptions: after.exceptions },
    });
    return after;
  }

  // --- media ---

  async listMedia(id: string): Promise<PlaceMediaRecord[]> {
    requireRegionContext();
    if (!(await this.repo.findPlace(id))) notFound();
    return this.repo.placeMedia(id);
  }

  /** Привязать загруженное фото (POST /media/uploads с ownerType place и ownerId места). */
  async attachMedia(
    meta: AuditMeta,
    id: string,
    assetId: string,
    input: PlaceMediaInput,
  ): Promise<PlaceMediaRecord[]> {
    requireRegionContext();
    const place = (await this.repo.lockPlace(id)) ?? notFound();
    const asset = await this.repo.findMediaAsset(assetId);
    if (!asset) throw new CatalogError("media_not_found");
    if (asset.kind !== "image") throw new CatalogError("media_not_image");
    if (asset.owner_type !== "place" || asset.owner_id !== id) throw new CatalogError("media_owner_mismatch");
    if (asset.status === "rejected") throw new CatalogError("media_rejected");
    const order = input.sortOrder ?? (await this.repo.nextMediaOrder(id));
    await guarded(() => this.repo.attachMedia(id, assetId, order));
    if (input.isCover) await this.repo.updateMediaLink(id, assetId, { is_cover: true });
    if (input.alt !== undefined) await this.repo.setMediaAlt(assetId, input.alt);
    if (place.status === "published") await this.assertPublishable(place, "edit");
    await this.record(meta, {
      action: "media.attach",
      entityType: "place",
      entityId: id,
      newValues: {
        mediaAssetId: assetId,
        sortOrder: order,
        isCover: !!input.isCover,
        alt: input.alt ?? null,
      },
    });
    return this.repo.placeMedia(id);
  }

  async updateMedia(
    meta: AuditMeta,
    id: string,
    assetId: string,
    input: PlaceMediaInput,
  ): Promise<PlaceMediaRecord[]> {
    requireRegionContext();
    const place = (await this.repo.lockPlace(id)) ?? notFound();
    const before = (await this.repo.placeMedia(id)).find((m) => m.media_asset_id === assetId);
    if (!before) throw new CatalogError("not_found");
    await this.repo.updateMediaLink(id, assetId, { sort_order: input.sortOrder, is_cover: input.isCover });
    if (input.alt !== undefined) await this.repo.setMediaAlt(assetId, input.alt);
    if (place.status === "published") await this.assertPublishable(place, "edit");
    await this.record(meta, {
      action: "media.update",
      entityType: "place",
      entityId: id,
      oldValues: {
        mediaAssetId: assetId,
        sortOrder: before.sort_order,
        isCover: before.is_cover,
        alt: before.alt_i18n,
      },
      newValues: {
        mediaAssetId: assetId,
        sortOrder: input.sortOrder ?? before.sort_order,
        isCover: input.isCover ?? before.is_cover,
        alt: input.alt === undefined ? before.alt_i18n : input.alt,
      },
    });
    return this.repo.placeMedia(id);
  }

  async detachMedia(meta: AuditMeta, id: string, assetId: string): Promise<void> {
    requireRegionContext();
    if (!(await this.repo.lockPlace(id))) notFound();
    if (!(await this.repo.detachMedia(id, assetId))) throw new CatalogError("not_found");
    await this.record(meta, {
      action: "media.detach",
      entityType: "place",
      entityId: id,
      oldValues: { mediaAssetId: assetId },
    });
  }

  // --- badge «Ми рекомендуємо» (D-32: поле + история с причиной) ---

  async setBadge(meta: AuditMeta, id: string, grant: boolean, reason: string): Promise<PlaceDetails> {
    requireRegionContext();
    const before = (await this.repo.lockPlace(id)) ?? notFound();
    if (grant && before.recommended) throw new CatalogError("already_recommended");
    if (!grant && !before.recommended) throw new CatalogError("not_recommended");
    const after = (await this.repo.updatePlace(id, { recommended: grant })) ?? notFound();
    await this.repo.appendBadgeEvent({
      place_id: id,
      action: grant ? "grant" : "revoke",
      reason,
      actor_user_id: meta.actor.type === "user" ? meta.actor.userId : null,
    });
    await this.record(meta, {
      action: grant ? "badge.recommend.grant" : "badge.recommend.revoke",
      entityType: "place",
      entityId: id,
      reason,
      oldValues: { recommended: before.recommended },
      newValues: { recommended: grant },
    });
    return { ...after, tagIds: await this.repo.placeTagIds(id) };
  }

  async badgeHistory(id: string): Promise<PlaceBadgeEvent[]> {
    requireRegionContext();
    if (!(await this.repo.findPlace(id))) notFound();
    return this.repo.badgeHistory(id);
  }
}

/** Проблемы, которые проверяются и при правке опубликованного места. */
const EDIT_PROBLEMS: ReadonlySet<PublishProblem> = new Set<PublishProblem>([
  "description_missing",
  "address_missing",
  "location_missing",
  "media_alt_missing",
]);

function notFound(): never {
  throw new CatalogError("not_found");
}

const hhmm = (time: string) => time.slice(0, 5);

/** Поля места после применения правки (для проверки готовности опубликованного места до записи). */
function applied(before: PlaceRecord, input: Partial<PlaceInput>): Partial<PlaceRecord> {
  return {
    ...(input.categoryId !== undefined ? { category_id: input.categoryId } : {}),
    ...(input.description !== undefined ? { description_i18n: input.description } : {}),
    ...(input.address !== undefined ? { address_i18n: input.address } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    id: before.id,
  };
}

function localitySnapshot(l: LocalityRecord): JsonObject {
  return {
    code: l.code,
    kind: l.kind,
    name: l.name_i18n,
    location: l.location,
    sortOrder: l.sort_order,
    active: l.active,
  };
}

function categorySnapshot(c: Category): JsonObject {
  return {
    code: c.code,
    parentId: c.parent_id,
    name: c.name_i18n,
    icon: c.icon,
    homeSection: c.home_section,
    sortOrder: c.sort_order,
    active: c.active,
  };
}

function tagSnapshot(tag: Tag): JsonObject {
  return {
    code: tag.code,
    name: tag.name_i18n,
    group: tag.tag_group,
    sortOrder: tag.sort_order,
    active: tag.active,
  };
}
