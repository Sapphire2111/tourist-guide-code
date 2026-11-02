import { isIP } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import {
  currentTenant,
  TenantContextError,
  type AuditLog,
  type Db,
  type JsonObject,
} from "../../db/index.js";
import { AuditLogRepository } from "./audit-log.repository.js";

/**
 * Срок хранения ПДн-части аудита (IP, user agent, session id), дней — D-73, рекомендация в тестовом режиме
 * проекта; юридическая проверка срока отложена. Запись действия хранится без этого срока (D-48 — блок 8).
 */
export const DEFAULT_AUDIT_PII_RETENTION_DAYS = 90;

/** DI-токен срока хранения ПДн аудита в днях (по умолчанию DEFAULT_AUDIT_PII_RETENTION_DAYS). */
export const AUDIT_PII_RETENTION_DAYS = Symbol("AUDIT_PII_RETENTION_DAYS");

const DAY_MS = 24 * 60 * 60 * 1000;
/** Лимиты колонок audit_log_pii (CHECK в миграции 0004). */
const USER_AGENT_MAX = 1024;
const SESSION_ID_MAX = 255;

/** Кто выполнил действие: пользователь или система (фоновая задача, миграция данных). */
export type AuditActor = { readonly type: "user"; readonly userId: string } | { readonly type: "system" };

/** ПДн запроса; хранятся отдельно от записи действия и удаляются по сроку. */
export type AuditPii = {
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
};

export type AuditEntry = {
  actor: AuditActor;
  /** Permission-код действия (roles-and-data §1.3), например role.assign. */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** ПДн в old/new — маскированно или ссылкой (roles-and-data §2.12). */
  oldValues?: JsonObject | null;
  newValues?: JsonObject | null;
  reason?: string | null;
  /** Correlation id запроса (заголовок X-Request-Id, req.correlationId) или id задачи воркера. */
  requestId?: string | null;
  /**
   * Назначение роли, по которому действовал актор-пользователь (`req.authorization.grant.id` после
   * @RequirePermission, T1-12); для актора system — только null.
   */
  roleAssignmentId?: string | null;
  /**
   * Регион записи в кросс-tenant контексте (SYSTEM/PLATFORM); по умолчанию NULL — действие уровня платформы.
   * В контексте региона регион берётся из него, другой — ошибка.
   */
  regionId?: string | null;
  pii?: AuditPii;
};

/**
 * Запись аудита (ТЗ §12.1, T1-13). record() пишет в переданную транзакцию бизнес-изменения: откат изменения
 * откатывает и аудит, отдельной транзакции нет. Регион — из tenant-контекста withTenant().
 */
@Injectable()
export class AuditService {
  constructor(@Inject(AUDIT_PII_RETENTION_DAYS) private readonly retentionDays: number) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1)
      throw new Error(`Срок хранения ПДн аудита — целое число дней ≥ 1, получено ${retentionDays}`);
  }

  /** trx — транзакция бизнес-изменения (из withTenant() или db.transaction()); вне транзакции — ошибка. */
  async record(trx: Db, entry: AuditEntry): Promise<AuditLog> {
    if (!trx.isTransaction)
      throw new Error("AuditService.record: передайте транзакцию бизнес-изменения, а не корневой db");
    const repo = new AuditLogRepository(trx);
    const log = await repo.append({
      actor_type: entry.actor.type,
      actor_user_id: entry.actor.type === "user" ? entry.actor.userId : null,
      region_id: this.regionOf(entry),
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      old_values: entry.oldValues ?? null,
      new_values: entry.newValues ?? null,
      reason: entry.reason ?? null,
      request_id: entry.requestId ?? null,
      role_assignment_id: entry.roleAssignmentId ?? null,
    });
    const pii = normalizePii(entry.pii);
    if (pii)
      await repo.appendPii({
        audit_log_id: log.id,
        region_id: log.region_id,
        ...pii,
        expires_at: new Date(Date.now() + this.retentionDays * DAY_MS),
      });
    return log;
  }

  private regionOf(entry: AuditEntry): string | null {
    const tenant = currentTenant();
    if (tenant?.kind !== "region") return entry.regionId ?? null;
    if (entry.regionId !== undefined && entry.regionId?.toLowerCase() !== tenant.regionId)
      throw new TenantContextError("Регион записи аудита не совпадает с tenant-контекстом");
    return tenant.regionId;
  }
}

/**
 * ПДн к записи или undefined, если записывать нечего. Некорректный IP отбрасывается, zone id IPv6 — тоже (иначе
 * ошибка приведения к inet откатила бы бизнес-транзакцию), длинный user agent обрезается, длинный session id — отбрасывается.
 */
export function normalizePii(
  pii: AuditPii | undefined,
): { ip: string | null; user_agent: string | null; session_id: string | null } | undefined {
  if (!pii) return undefined;
  // Zone id IPv6 (fe80::1%eth0) net.isIP принимает, а inet — нет: отбрасываем его.
  const ip = pii.ip?.trim().split("%")[0];
  const userAgent = pii.userAgent?.trim();
  const sessionId = pii.sessionId?.trim();
  const out = {
    ip: ip && isIP(ip) ? ip : null,
    // По символам (кодовым точкам), как char_length в CHECK.
    user_agent: userAgent ? Array.from(userAgent).slice(0, USER_AGENT_MAX).join("") : null,
    session_id: sessionId && Array.from(sessionId).length <= SESSION_ID_MAX ? sessionId : null,
  };
  return (out.ip ?? out.user_agent ?? out.session_id) !== null ? out : undefined;
}
