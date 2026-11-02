import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  type AuditLog,
  type AuditLogPii,
  type Db,
  type NewAuditLog,
  type NewAuditLogPii,
} from "../../db/index.js";

/** Фильтр ленты аудита для админа. Период — по created_at: from включительно, to не включительно. */
export type AuditLogFilter = {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
};

/**
 * Журнал действий: только добавление и чтение, методов изменения/удаления нет намеренно — в БД UPDATE/DELETE
 * запрещены правами роли app и триггером (миграция 0004, T1-13).
 * Tenant-optional (ADR-006): вызывается в withTenant() — в контексте региона видны и пишутся только записи
 * этого региона (region_id подставляет TenantGuardPlugin, второй рубеж — RLS), записи с region_id NULL —
 * только SYSTEM/PLATFORM. Запросы — через currentDb(): внутри withTenant() запись аудита автоматически идёт в
 * ту же транзакцию, что и изменение; новое соединение там запрещено (tenantGuardedDialect).
 * Писать аудит из бизнес-кода — через AuditService.record() (ПДн-часть, актор, регион).
 */
@Injectable()
export class AuditLogRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  append(entry: NewAuditLog): Promise<AuditLog> {
    return currentDb(this.db).insertInto("audit_logs").values(entry).returningAll().executeTakeFirstOrThrow();
  }

  /** ПДн-часть записи (audit_log_pii): region_id — тот же, что у записи действия (проверяет триггер БД). */
  appendPii(entry: NewAuditLogPii): Promise<AuditLogPii> {
    return currentDb(this.db)
      .insertInto("audit_log_pii")
      .values(entry)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  findById(id: string): Promise<AuditLog | undefined> {
    return currentDb(this.db).selectFrom("audit_logs").selectAll().where("id", "=", id).executeTakeFirst();
  }

  findPii(auditLogId: string): Promise<AuditLogPii | undefined> {
    return currentDb(this.db)
      .selectFrom("audit_log_pii")
      .selectAll()
      .where("audit_log_id", "=", auditLogId)
      .executeTakeFirst();
  }

  /** Последние записи (лента региона), от новых к старым; по умолчанию 100. */
  listRecent(limit = 100): Promise<AuditLog[]> {
    return currentDb(this.db)
      .selectFrom("audit_logs")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
  }

  /**
   * Страница ленты для админа: от новых к старым по id (uuidv7 растёт со временем; порядок строгий, поэтому
   * курсор — id последней записи страницы, `beforeId`). ПДн-часть сюда не входит.
   */
  search(filter: AuditLogFilter, page: { limit: number; beforeId?: string }): Promise<AuditLog[]> {
    let q = currentDb(this.db).selectFrom("audit_logs").selectAll();
    if (filter.entityType !== undefined) q = q.where("entity_type", "=", filter.entityType);
    if (filter.entityId !== undefined) q = q.where("entity_id", "=", filter.entityId);
    if (filter.actorUserId !== undefined) q = q.where("actor_user_id", "=", filter.actorUserId);
    if (filter.from !== undefined) q = q.where("created_at", ">=", filter.from);
    if (filter.to !== undefined) q = q.where("created_at", "<", filter.to);
    if (page.beforeId !== undefined) q = q.where("id", "<", page.beforeId);
    return q.orderBy("id", "desc").limit(page.limit).execute();
  }

  /** История объекта, от старых записей к новым. */
  listByEntity(entityType: string, entityId: string): Promise<AuditLog[]> {
    return currentDb(this.db)
      .selectFrom("audit_logs")
      .selectAll()
      .where("entity_type", "=", entityType)
      .where("entity_id", "=", entityId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }
}
