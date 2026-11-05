import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import {
  currentDb,
  InjectDb,
  regionContext,
  withTenant,
  type Db,
  type JsonObject,
  type LocalizedText,
  type PriceListItem,
  type PriceListSection,
} from "../../db/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import type { PlaceRecord } from "../catalog/index.js";
import {
  byOrder,
  moved,
  nextSortOrder,
  priceOf,
  renumber,
  underLimit,
  versionMatches,
} from "./price-list-rules.js";
import {
  PRICE_LIST_MAX_ITEMS,
  PRICE_LIST_MAX_SECTIONS,
  type CreatePriceItemDto,
  type CreatePriceSectionDto,
  type MoveDirection,
  type PartnerPriceItemDto,
  type PartnerPriceListDto,
  type UpdatePriceItemDto,
  type UpdatePriceSectionDto,
} from "./price-list.dto.js";
import { PriceListRepository, type PriceItemPatch, type PriceSectionPatch } from "./price-list.repository.js";
import { PARTNER_AUDIT, PartnerService, type AuditMeta, type PlaceAccess } from "./partner.service.js";

/** Право прайса (rbac/permissions.ts): ORG_OWNER, ORG_MANAGER; кассиру — 403 role_forbidden. */
const PERMISSION = "price_list.manage" as const;
export const PRICE_SECTION_ENTITY = "price_list_section";
export const PRICE_ITEM_ENTITY = "price_list_item";

const notFound = () => new ApiError("NOT_FOUND");
const versionConflict = (currentVersion: number | null) =>
  new ApiError("CONFLICT", {
    messageKey: "errors.priceList.versionConflict",
    details: { reason: "version_conflict", currentVersion },
  });
const placeArchived = (status: string) =>
  new ApiError("CONFLICT", {
    messageKey: "errors.partner.placeNotEditable",
    details: { reason: "not_editable", status },
  });

/** Мультиязычный текст запроса → JSON БД без пробелов по краям (пустые переводы — без ключа). */
function text(t: { uk: string; en?: string }): LocalizedText {
  const en = t.en?.trim();
  return { uk: t.uk.trim(), ...(en ? { en } : {}) };
}
const optText = (t: { uk: string; en?: string } | null | undefined) => (t ? text(t) : null);

/**
 * Прайс заведения (миграция 0030): разделы и позиции с ценами в кабинете партнёра. Доступ — как у акций P07:
 * место → организация → регион из БД, право price_list.manage (ORG_OWNER, ORG_MANAGER); транзакция региона места с
 * блокировкой строки места (лимиты и порядок считаются без гонок), каждое изменение — AuditLog. Ответ любого
 * изменения — прайс целиком (кабинет перерисовывает экран без отдельного запроса).
 */
@Injectable()
export class PriceListService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(PriceListRepository) private readonly repo: PriceListRepository,
    @Inject(PartnerService) private readonly partner: PartnerService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async get(userId: string, placeId: string): Promise<PartnerPriceListDto> {
    const access = await this.partner.placeAccess(userId, placeId, PERMISSION);
    return withTenant(this.db, regionContext(access.regionId), () => this.dto(access.placeId));
  }

  // --- разделы ---

  async createSection(
    userId: string,
    placeId: string,
    input: CreatePriceSectionDto,
    meta: AuditMeta,
  ): Promise<PartnerPriceListDto> {
    return this.edit(userId, placeId, async (access) => {
      const sections = await this.repo.sections(access.placeId);
      if (!underLimit(sections.length, PRICE_LIST_MAX_SECTIONS))
        throw new ApiError("UNPROCESSABLE", {
          messageKey: "errors.priceList.tooManySections",
          details: { reason: "too_many_sections", max: PRICE_LIST_MAX_SECTIONS },
        });
      const section = await this.repo.createSection({
        place_id: access.placeId,
        title_i18n: text(input.title),
        sort_order: nextSortOrder(sections),
        created_by: userId,
      });
      await this.record(meta, access, {
        action: PARTNER_AUDIT.priceSectionCreate,
        entityType: PRICE_SECTION_ENTITY,
        entityId: section.id,
        newValues: sectionSnapshot(section),
      });
    });
  }

  async updateSection(
    userId: string,
    placeId: string,
    sectionId: string,
    input: UpdatePriceSectionDto,
    meta: AuditMeta,
  ): Promise<PartnerPriceListDto> {
    return this.edit(userId, placeId, async (access) => {
      const before = await this.repo.findSection(access.placeId, sectionId.toLowerCase());
      if (!before) throw notFound();
      if (!versionMatches(input.version, before.version)) throw versionConflict(before.version);
      const patch: PriceSectionPatch = {};
      if (input.title) patch.title_i18n = text(input.title);
      if (typeof input.hidden === "boolean") patch.status = input.hidden ? "hidden" : "active";
      if (!Object.keys(patch).length) return;
      const after = await this.repo.updateSection(before.id, patch, input.version);
      if (!after) throw versionConflict(before.version);
      await this.record(meta, access, {
        action: PARTNER_AUDIT.priceSectionUpdate,
        entityType: PRICE_SECTION_ENTITY,
        entityId: after.id,
        oldValues: sectionSnapshot(before),
        newValues: sectionSnapshot(after),
      });
    });
  }

  async moveSection(
    userId: string,
    placeId: string,
    sectionId: string,
    direction: MoveDirection,
    meta: AuditMeta,
  ): Promise<PartnerPriceListDto> {
    return this.edit(userId, placeId, async (access) => {
      const sections = byOrder(await this.repo.sections(access.placeId));
      const id = sectionId.toLowerCase();
      if (!sections.some((s) => s.id === id)) throw notFound();
      const order = moved(
        sections.map((s) => s.id),
        id,
        direction,
      );
      if (!order) return;
      for (const r of renumber(sections, order))
        await this.repo.updateSection(r.id, { sort_order: r.sortOrder });
      await this.record(meta, access, {
        action: PARTNER_AUDIT.priceSectionMove,
        entityType: PRICE_SECTION_ENTITY,
        entityId: id,
        newValues: { direction, position: order.indexOf(id) },
      });
    });
  }

  /** В архив (вместо удаления) вместе с позициями раздела; повтор/нет раздела — 404 (архивные не видны). */
  async archiveSection(
    userId: string,
    placeId: string,
    sectionId: string,
    meta: AuditMeta,
  ): Promise<PartnerPriceListDto> {
    return this.edit(userId, placeId, async (access) => {
      const before = await this.repo.findSection(access.placeId, sectionId.toLowerCase());
      if (!before) throw notFound();
      const after = await this.repo.updateSection(before.id, { status: "archived" });
      const items = await this.repo.archiveSectionItems(access.placeId, before.id);
      await this.record(meta, access, {
        action: PARTNER_AUDIT.priceSectionArchive,
        entityType: PRICE_SECTION_ENTITY,
        entityId: before.id,
        oldValues: { status: before.status },
        newValues: { status: after?.status ?? "archived", archivedItems: items },
      });
    });
  }

  // --- позиции ---

  async createItem(
    userId: string,
    placeId: string,
    input: CreatePriceItemDto,
    meta: AuditMeta,
  ): Promise<PartnerPriceListDto> {
    return this.edit(userId, placeId, async (access) => {
      const section = await this.repo.findSection(access.placeId, input.sectionId.toLowerCase());
      if (!section) throw notFound();
      const items = await this.repo.items(access.placeId);
      if (!underLimit(items.length, PRICE_LIST_MAX_ITEMS)) throw tooManyItems();
      const item = await this.repo.createItem({
        place_id: access.placeId,
        section_id: section.id,
        name_i18n: text(input.name),
        description_i18n: optText(input.description),
        price_minor: input.priceMinor,
        price_from: input.priceFrom ?? false,
        unit_i18n: optText(input.unit),
        sort_order: nextSortOrder(items.filter((i) => i.section_id === section.id)),
        created_by: userId,
      });
      await this.record(meta, access, {
        action: PARTNER_AUDIT.priceItemCreate,
        entityType: PRICE_ITEM_ENTITY,
        entityId: item.id,
        newValues: itemSnapshot(item),
      });
    });
  }

  async updateItem(
    userId: string,
    placeId: string,
    itemId: string,
    input: UpdatePriceItemDto,
    meta: AuditMeta,
  ): Promise<PartnerPriceListDto> {
    return this.edit(userId, placeId, async (access) => {
      const before = await this.repo.findItem(access.placeId, itemId.toLowerCase());
      if (!before) throw notFound();
      if (!versionMatches(input.version, before.version)) throw versionConflict(before.version);
      const patch: PriceItemPatch = {};
      if (input.name) patch.name_i18n = text(input.name);
      if (input.description !== undefined) patch.description_i18n = optText(input.description);
      if (input.unit !== undefined) patch.unit_i18n = optText(input.unit);
      if (typeof input.priceMinor === "number") patch.price_minor = input.priceMinor;
      if (typeof input.priceFrom === "boolean") patch.price_from = input.priceFrom;
      if (typeof input.hidden === "boolean") patch.status = input.hidden ? "hidden" : "active";
      const target = input.sectionId?.toLowerCase();
      if (target && target !== before.section_id) {
        const section = await this.repo.findSection(access.placeId, target);
        if (!section) throw notFound();
        const items = await this.repo.items(access.placeId);
        patch.section_id = section.id;
        patch.sort_order = nextSortOrder(items.filter((i) => i.section_id === section.id));
      }
      if (!Object.keys(patch).length) return;
      const after = await this.repo.updateItem(before.id, patch, input.version);
      if (!after) throw versionConflict(before.version);
      await this.record(meta, access, {
        action: PARTNER_AUDIT.priceItemUpdate,
        entityType: PRICE_ITEM_ENTITY,
        entityId: after.id,
        oldValues: itemSnapshot(before),
        newValues: itemSnapshot(after),
      });
    });
  }

  async moveItem(
    userId: string,
    placeId: string,
    itemId: string,
    direction: MoveDirection,
    meta: AuditMeta,
  ): Promise<PartnerPriceListDto> {
    return this.edit(userId, placeId, async (access) => {
      const item = await this.repo.findItem(access.placeId, itemId.toLowerCase());
      if (!item) throw notFound();
      const siblings = byOrder(
        (await this.repo.items(access.placeId)).filter((i) => i.section_id === item.section_id),
      );
      const order = moved(
        siblings.map((i) => i.id),
        item.id,
        direction,
      );
      if (!order) return;
      for (const r of renumber(siblings, order))
        await this.repo.updateItem(r.id, { sort_order: r.sortOrder });
      await this.record(meta, access, {
        action: PARTNER_AUDIT.priceItemMove,
        entityType: PRICE_ITEM_ENTITY,
        entityId: item.id,
        newValues: { direction, position: order.indexOf(item.id) },
      });
    });
  }

  async archiveItem(
    userId: string,
    placeId: string,
    itemId: string,
    meta: AuditMeta,
  ): Promise<PartnerPriceListDto> {
    return this.edit(userId, placeId, async (access) => {
      const before = await this.repo.findItem(access.placeId, itemId.toLowerCase());
      if (!before) throw notFound();
      await this.repo.updateItem(before.id, { status: "archived" });
      await this.record(meta, access, {
        action: PARTNER_AUDIT.priceItemArchive,
        entityType: PRICE_ITEM_ENTITY,
        entityId: before.id,
        oldValues: { status: before.status },
        newValues: { status: "archived" },
      });
    });
  }

  // --- внутреннее ---

  /** Право, транзакция региона с блокировкой места (архивное место — 409), изменение, прайс целиком. */
  private async edit(
    userId: string,
    placeId: string,
    fn: (access: PlaceAccess, place: PlaceRecord) => Promise<void>,
  ): Promise<PartnerPriceListDto> {
    const access = await this.partner.placeAccess(userId, placeId, PERMISSION);
    return this.partner.inPlace(access, async (place) => {
      if (place.status === "archived") throw placeArchived(place.status);
      await fn(access, place);
      return this.dto(access.placeId);
    });
  }

  private async dto(placeId: string): Promise<PartnerPriceListDto> {
    const [sections, items] = await Promise.all([this.repo.sections(placeId), this.repo.items(placeId)]);
    const ordered = byOrder(items);
    return {
      placeId,
      itemCount: items.length,
      limits: { maxItems: PRICE_LIST_MAX_ITEMS, maxSections: PRICE_LIST_MAX_SECTIONS },
      sections: byOrder(sections).map((s) => ({
        id: s.id,
        title: s.title_i18n,
        hidden: s.status === "hidden",
        sortOrder: s.sort_order,
        version: s.version,
        items: ordered.filter((i) => i.section_id === s.id).map(toItemDto),
      })),
    };
  }

  private async record(
    meta: AuditMeta,
    access: PlaceAccess,
    entry: Omit<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii" | "regionId">,
  ): Promise<void> {
    await this.audit.record(currentDb(this.db), {
      ...meta,
      roleAssignmentId: access.grantId,
      regionId: access.regionId,
      ...entry,
    });
  }
}

function tooManyItems(): ApiError {
  return new ApiError("UNPROCESSABLE", {
    messageKey: "errors.priceList.tooManyItems",
    details: { reason: "too_many_items", max: PRICE_LIST_MAX_ITEMS },
  });
}

function toItemDto(i: PriceListItem): PartnerPriceItemDto {
  return {
    id: i.id,
    sectionId: i.section_id,
    name: i.name_i18n,
    description: i.description_i18n,
    priceMinor: priceOf(i.price_minor),
    currency: i.currency,
    priceFrom: i.price_from,
    unit: i.unit_i18n,
    hidden: i.status === "hidden",
    sortOrder: i.sort_order,
    version: i.version,
    updatedAt: i.updated_at.toISOString(),
  };
}

function sectionSnapshot(s: PriceListSection): JsonObject {
  return { placeId: s.place_id, title: s.title_i18n, status: s.status, sortOrder: s.sort_order };
}

function itemSnapshot(i: PriceListItem): JsonObject {
  return {
    placeId: i.place_id,
    sectionId: i.section_id,
    name: i.name_i18n,
    description: i.description_i18n,
    priceMinor: priceOf(i.price_minor),
    priceFrom: i.price_from,
    unit: i.unit_i18n,
    status: i.status,
  };
}
