import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  type Db,
  type LocalizedText,
  type PriceListItem,
  type PriceListSection,
  type PriceListStatus,
} from "../../db/index.js";

/** Поля позиции, которые меняет партнёр. */
export type PriceItemPatch = {
  section_id?: string;
  name_i18n?: LocalizedText;
  description_i18n?: LocalizedText | null;
  price_minor?: number;
  price_from?: boolean;
  unit_i18n?: LocalizedText | null;
  status?: PriceListStatus;
  sort_order?: number;
};

export type PriceSectionPatch = {
  title_i18n?: LocalizedText;
  status?: PriceListStatus;
  sort_order?: number;
};

/**
 * Прайс заведения (миграция 0030). Вызывается в withTenant(региона места): TenantGuardPlugin фильтрует region_id
 * каждой таблицы и подставляет его во вставки, RLS — второй рубеж. Архивные строки — только история (AuditLog).
 * Изменения увеличивают version; с expectedVersion — условие version = ожидаемой (нет строки — конфликт).
 */
@Injectable()
export class PriceListRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  private get q(): Db {
    return currentDb(this.db);
  }

  /** Разделы места не в архиве. */
  sections(placeId: string): Promise<PriceListSection[]> {
    return this.q
      .selectFrom("price_list_sections")
      .selectAll()
      .where("place_id", "=", placeId)
      .where("status", "<>", "archived")
      .orderBy("sort_order")
      .orderBy("id")
      .execute();
  }

  /** Позиции места не в архиве (по всем разделам). */
  items(placeId: string): Promise<PriceListItem[]> {
    return this.q
      .selectFrom("price_list_items")
      .selectAll()
      .where("place_id", "=", placeId)
      .where("status", "<>", "archived")
      .orderBy("sort_order")
      .orderBy("id")
      .execute();
  }

  findSection(placeId: string, id: string): Promise<PriceListSection | undefined> {
    return this.q
      .selectFrom("price_list_sections")
      .selectAll()
      .where("id", "=", id)
      .where("place_id", "=", placeId)
      .where("status", "<>", "archived")
      .forUpdate()
      .executeTakeFirst();
  }

  findItem(placeId: string, id: string): Promise<PriceListItem | undefined> {
    return this.q
      .selectFrom("price_list_items")
      .selectAll()
      .where("id", "=", id)
      .where("place_id", "=", placeId)
      .where("status", "<>", "archived")
      .forUpdate()
      .executeTakeFirst();
  }

  createSection(row: {
    place_id: string;
    title_i18n: LocalizedText;
    sort_order: number;
    created_by: string;
  }): Promise<PriceListSection> {
    return this.q.insertInto("price_list_sections").values(row).returningAll().executeTakeFirstOrThrow();
  }

  createItem(row: {
    place_id: string;
    section_id: string;
    name_i18n: LocalizedText;
    description_i18n: LocalizedText | null;
    price_minor: number;
    price_from: boolean;
    unit_i18n: LocalizedText | null;
    sort_order: number;
    created_by: string;
  }): Promise<PriceListItem> {
    return this.q.insertInto("price_list_items").values(row).returningAll().executeTakeFirstOrThrow();
  }

  /** undefined — версия не совпала (строку изменили параллельно). */
  updateSection(
    id: string,
    patch: PriceSectionPatch,
    expectedVersion?: number,
  ): Promise<PriceListSection | undefined> {
    let q = this.q
      .updateTable("price_list_sections")
      .set((eb) => ({ ...patch, version: eb("version", "+", 1) }))
      .where("id", "=", id);
    if (expectedVersion !== undefined) q = q.where("version", "=", expectedVersion);
    return q.returningAll().executeTakeFirst();
  }

  updateItem(
    id: string,
    patch: PriceItemPatch,
    expectedVersion?: number,
  ): Promise<PriceListItem | undefined> {
    let q = this.q
      .updateTable("price_list_items")
      .set((eb) => ({ ...patch, version: eb("version", "+", 1) }))
      .where("id", "=", id);
    if (expectedVersion !== undefined) q = q.where("version", "=", expectedVersion);
    return q.returningAll().executeTakeFirst();
  }

  /** Архив позиций раздела (вместе с разделом); число перенесённых. */
  async archiveSectionItems(placeId: string, sectionId: string): Promise<number> {
    const rows = await this.q
      .updateTable("price_list_items")
      .set((eb) => ({ status: "archived" as const, version: eb("version", "+", 1) }))
      .where("place_id", "=", placeId)
      .where("section_id", "=", sectionId)
      .where("status", "<>", "archived")
      .returning("id")
      .execute();
    return rows.length;
  }
}
