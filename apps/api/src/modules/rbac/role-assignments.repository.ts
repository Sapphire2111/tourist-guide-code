import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  InjectDb,
  type Db,
  type NewRoleAssignment,
  type RoleAssignment,
  type ScopeType,
} from "../../db/index.js";
import type { Grant } from "./access.js";

/** Строка функции app_active_role_assignments() (миграция 0005). */
type ActiveRow = {
  id: string;
  role: string;
  scope_type: ScopeType;
  scope_id: string | null;
  region_id: string | null;
  granted_at: Date;
  valid_until: Date | null;
};

/**
 * Назначения ролей (tenant-optional, миграция 0005). Изменение — только отзыв (триггер БД), удаления нет.
 * Запросы — через currentDb(): в withTenant() регион видит и пишет только свои назначения, PLATFORM — только
 * SYSTEM/PLATFORM. Назначать и отзывать — через RoleAssignmentService (запись в аудит).
 */
@Injectable()
export class RoleAssignmentsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  insert(row: NewRoleAssignment): Promise<RoleAssignment> {
    return currentDb(this.db)
      .insertInto("role_assignments")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  findById(id: string): Promise<RoleAssignment | undefined> {
    return currentDb(this.db)
      .selectFrom("role_assignments")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
  }

  /** Неотозванное назначение той же тройки (user, role, scope) — уникально (индекс role_assignments_active_key). */
  findUnrevoked(
    userId: string,
    role: string,
    scopeType: ScopeType,
    scopeId: string | null,
  ): Promise<RoleAssignment | undefined> {
    return currentDb(this.db)
      .selectFrom("role_assignments")
      .selectAll()
      .where("user_id", "=", userId)
      .where("role", "=", role)
      .where("scope_type", "=", scopeType)
      .where("scope_id", scopeId === null ? "is" : "=", scopeId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
  }

  /** Отзыв неотозванного назначения; undefined — нет такого (или уже отозвано, или чужой регион). */
  revoke(
    id: string,
    by: { revokedBy: string | null; reason: string | null },
  ): Promise<RoleAssignment | undefined> {
    return currentDb(this.db)
      .updateTable("role_assignments")
      .set({ revoked_at: sql<Date>`now()`, revoked_by: by.revokedBy, revoke_reason: by.reason })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Действующие назначения пользователя во всех регионах — функцией БД app_active_role_assignments(): она читает
   * в режиме SYSTEM, поэтому вызов работает и вне withTenant(), и внутри транзакции любого региона.
   */
  async activeGrantsOf(userId: string): Promise<Grant[]> {
    const rows = await currentDb(this.db)
      .selectFrom(sql<ActiveRow>`app_active_role_assignments(${userId})`.as("ra"))
      .selectAll()
      .execute();
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      regionId: r.region_id,
      validUntil: r.valid_until,
    }));
  }
}
