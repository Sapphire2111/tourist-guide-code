import { Inject, Injectable } from "@nestjs/common";
import {
  currentDb,
  currentTenant,
  InjectDb,
  type Db,
  type JsonObject,
  type LocalizedText,
  type Region,
  type RegionStatus,
} from "../../db/index.js";
import { AuditService } from "../audit/index.js";
import { RegionsRepository } from "../regions/index.js";
import { CatalogError, guarded, type AuditMeta } from "./catalog.service.js";

export type RegionSettingsInput = {
  name?: LocalizedText;
  timezone?: string;
  defaultLanguage?: string;
};

export type RegionCreateInput = RegionSettingsInput & { code: string; name: LocalizedText };

/** Имя IANA-зоны, которое знает рантайм (CHECK в БД его не проверяет — 0002). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function snapshot(r: Region): JsonObject {
  return {
    code: r.code,
    name: r.name_i18n,
    status: r.status,
    timezone: r.timezone,
    defaultLanguage: r.default_language,
  };
}

/**
 * Регионы в админке (блок 3): regions — глобальная таблица (TenantGuardPlugin её не фильтрует), поэтому видимость
 * ограничивается здесь: в контексте региона — только он, в PLATFORM — все. Создание и статус — только PLATFORM
 * (SUPERADMIN, права region.create / region.manage на PLATFORM проверяет контроллер).
 */
@Injectable()
export class RegionsAdminService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Регион доступен в контексте запроса: свой регион или любой в PLATFORM/SYSTEM. */
  private visible(id: string): boolean {
    const tenant = currentTenant();
    if (!tenant) return false;
    return tenant.kind !== "region" || tenant.regionId === id.toLowerCase();
  }

  async list(): Promise<Region[]> {
    const tenant = currentTenant();
    if (!tenant) throw new CatalogError("region_context_required");
    if (tenant.kind !== "region") return this.regions.list();
    const own = await this.regions.findById(tenant.regionId);
    return own ? [own] : [];
  }

  async get(id: string): Promise<Region> {
    const region = this.visible(id) ? await this.regions.findById(id) : undefined;
    if (!region) throw new CatalogError("not_found");
    return region;
  }

  async update(meta: AuditMeta, id: string, input: RegionSettingsInput): Promise<Region> {
    const before = await this.get(id);
    if (input.timezone !== undefined && !isValidTimezone(input.timezone))
      throw new CatalogError("timezone_invalid");
    const after = await this.regions.update(id, {
      name_i18n: input.name,
      timezone: input.timezone,
      default_language: input.defaultLanguage,
    });
    if (!after) throw new CatalogError("not_found");
    await this.audit.record(currentDb(this.db), {
      ...meta,
      action: "region.settings.edit",
      entityType: "region",
      entityId: id,
      regionId: id,
      oldValues: snapshot(before),
      newValues: snapshot(after),
    });
    return after;
  }

  async setStatus(meta: AuditMeta, id: string, status: RegionStatus, reason: string | null): Promise<Region> {
    const before = await this.get(id);
    const after = await this.regions.update(id, { status });
    if (!after) throw new CatalogError("not_found");
    await this.audit.record(currentDb(this.db), {
      ...meta,
      action: "region.manage",
      entityType: "region",
      entityId: id,
      regionId: id,
      reason,
      oldValues: { status: before.status },
      newValues: { status: after.status },
    });
    return after;
  }

  /** Новый регион — draft; включает SUPERADMIN статусом active. */
  async create(meta: AuditMeta, input: RegionCreateInput): Promise<Region> {
    // Регион создаётся вне контекста региона (сессия без выбранного региона): аудит — уровня PLATFORM.
    if (currentTenant()?.kind === "region") throw new CatalogError("platform_context_required");
    if (input.timezone !== undefined && !isValidTimezone(input.timezone))
      throw new CatalogError("timezone_invalid");
    const created = await guarded(() =>
      this.regions.create({
        code: input.code,
        name_i18n: input.name,
        timezone: input.timezone,
        default_language: input.defaultLanguage,
      }),
    );
    await this.audit.record(currentDb(this.db), {
      ...meta,
      action: "region.create",
      entityType: "region",
      entityId: created.id,
      regionId: created.id,
      newValues: snapshot(created),
    });
    return created;
  }
}
