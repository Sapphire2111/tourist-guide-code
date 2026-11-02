import { Inject, Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  regionContext,
  withTenant,
  type Db,
  type EmergencyContact,
  type EmergencyContactKind,
  type EmergencyContactUpdate,
  type JsonObject,
  type LocalizedText,
} from "../../db/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import { RegionsRepository } from "../regions/index.js";
import { EmergencyContactsRepository, type EmergencyContactFilter } from "./emergency-contacts.repository.js";

export const EMERGENCY_CONTACT_ENTITY = "emergency_contact";
export const EMERGENCY_CONTACT_AUDIT = {
  create: "emergency_contact.create",
  update: "emergency_contact.update",
  delete: "emergency_contact.delete",
} as const;

export type EmergencyContactInput = {
  kind: EmergencyContactKind;
  name: LocalizedText;
  phone: string;
  description?: LocalizedText | null;
  sortOrder?: number;
  active?: boolean;
};

export type EmergencyContactPatch = Partial<EmergencyContactInput>;

export type AuditMeta = Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">;

/**
 * Экстренные контакты «Халепа?» (ТЗ §4.2; блок 3 — правка, блок 4 — экран туриста; ADR-0018). Правка — в
 * транзакции запроса админа (currentDb) с записью аудита; публичная выдача — только активные контакты активного
 * региона, без сессии.
 */
@Injectable()
export class EmergencyContactsService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(EmergencyContactsRepository) private readonly repo: EmergencyContactsRepository,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  list(filter: EmergencyContactFilter): Promise<EmergencyContact[]> {
    return this.repo.list(filter);
  }

  find(id: string): Promise<EmergencyContact | undefined> {
    return this.repo.findById(id);
  }

  async create(regionId: string, input: EmergencyContactInput, meta: AuditMeta): Promise<EmergencyContact> {
    const row = await this.repo.create({
      region_id: regionId,
      kind: input.kind,
      name_i18n: input.name,
      phone: input.phone,
      description_i18n: input.description ?? null,
      sort_order: input.sortOrder ?? 0,
      active: input.active ?? true,
    });
    await this.record(meta, EMERGENCY_CONTACT_AUDIT.create, row, null, snapshot(row));
    return row;
  }

  /** undefined — контакта нет (или он в другом регионе); пустая правка — без изменений и аудита. */
  async update(
    id: string,
    input: EmergencyContactPatch,
    meta: AuditMeta,
  ): Promise<EmergencyContact | undefined> {
    const before = await this.repo.findById(id);
    if (!before) return undefined;
    const patch: EmergencyContactUpdate = {};
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.name !== undefined) patch.name_i18n = input.name;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.description !== undefined) patch.description_i18n = input.description;
    if (input.sortOrder !== undefined) patch.sort_order = input.sortOrder;
    if (input.active !== undefined) patch.active = input.active;
    if (Object.keys(patch).length === 0) return before;
    const after = await this.repo.update(id, patch);
    if (!after) return undefined;
    const old: JsonObject = {};
    const next: JsonObject = {};
    const a = snapshot(before);
    const b = snapshot(after);
    for (const key of Object.keys(b))
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
        old[key] = a[key];
        next[key] = b[key];
      }
    if (Object.keys(next).length) await this.record(meta, EMERGENCY_CONTACT_AUDIT.update, after, old, next);
    return after;
  }

  /** Удаление (настоящее DELETE, ADR-006); история — в аудите. */
  async remove(id: string, meta: AuditMeta): Promise<boolean> {
    const row = await this.repo.delete(id);
    if (!row) return false;
    await this.record(meta, EMERGENCY_CONTACT_AUDIT.delete, row, snapshot(row), null);
    return true;
  }

  /**
   * Публичный список региона для туриста: только active, по порядку. Регион не найден или не active — undefined
   * (404). Контекст — регион из пути: данные публичные, а RLS и фильтр плагина ограничивают чтение этим регионом.
   */
  async publicList(regionId: string): Promise<EmergencyContact[] | undefined> {
    const region = await this.regions.findById(regionId);
    if (region?.status !== "active") return undefined;
    return withTenant(this.db, regionContext(region.id), () => this.repo.list({ active: true }));
  }

  private async record(
    meta: AuditMeta,
    action: string,
    row: EmergencyContact,
    oldValues: JsonObject | null,
    newValues: JsonObject | null,
  ): Promise<void> {
    await this.audit.record(currentDb(this.db), {
      ...meta,
      action,
      entityType: EMERGENCY_CONTACT_ENTITY,
      entityId: row.id,
      oldValues,
      newValues,
      regionId: row.region_id,
    });
  }
}

/** Поля для аудита: телефон — служебный номер службы, не ПДн. */
function snapshot(row: EmergencyContact): JsonObject {
  return {
    kind: row.kind,
    name: row.name_i18n,
    phone: row.phone,
    description: row.description_i18n,
    sortOrder: row.sort_order,
    active: row.active,
  };
}
