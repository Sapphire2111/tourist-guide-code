import { Inject, Injectable } from "@nestjs/common";
import type { Db, JsonObject, RoleAssignment } from "../../db/index.js";
import { AuditService, type AuditActor } from "../audit/index.js";
import {
  chainRegionId,
  isRoleCode,
  RoleAssignmentsRepository,
  ROLES,
  ScopeHierarchy,
  scopeId,
  type ScopeRef,
} from "../rbac/index.js";

/** Коды действий в аудите (audit_logs.action) для изменений назначений (ТЗ §13 «Audit … рольових дій»). */
export const ROLE_AUDIT_ACTIONS = { assign: "role.assign", revoke: "role.revoke" } as const;
export const ROLE_ASSIGNMENT_ENTITY = "role_assignment";

export type RoleAssignmentErrorReason =
  | "unknown_role"
  | "scope_not_allowed"
  | "scope_not_found"
  | "user_not_found"
  | "valid_until_in_past"
  | "already_assigned"
  | "role_not_assignable"
  | "not_found";

/** Отказ назначения/отзыва; HTTP-код выбирает вызывающий эндпоинт (409/404/422). */
export class RoleAssignmentError extends Error {
  override readonly name = "RoleAssignmentError";

  constructor(readonly reason: RoleAssignmentErrorReason) {
    super(`RoleAssignment: ${reason}`);
  }
}

/** Общие поля для аудита изменения: кто, по какому назначению, зачем, correlation id. */
type AuditMeta = {
  actor: AuditActor;
  /** Назначение, по которому действует актор-пользователь (req.authorization.grant.id). */
  actorAssignmentId?: string | null;
  reason?: string | null;
  requestId?: string | null;
};

export type AssignRoleInput = AuditMeta & {
  userId: string;
  role: string;
  scope: ScopeRef;
  validUntil?: Date | null;
};

export type RevokeRoleInput = AuditMeta & { assignmentId: string };

/**
 * Назначение и отзыв ролей (roles-and-data §1.2: «изменения — только через сервис ролей с записью в AuditLog»).
 * Пишет в переданную транзакцию: назначение и запись аудита коммитятся или откатываются вместе. Право актора
 * (role.assign.admin и т. п.) проверяет вызывающий — @RequirePermission эндпоинта; запрет операций самому себе
 * и матрица «кто кого назначает» (roles-and-data §1.6, §1.7г) — с бизнес-ролями (блоки 3 и 6).
 */
@Injectable()
export class RoleAssignmentService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ScopeHierarchy) private readonly hierarchy: ScopeHierarchy,
  ) {}

  async assign(trx: Db, input: AssignRoleInput): Promise<RoleAssignment> {
    requireTransaction(trx);
    checkActorAssignment(input);
    if (!isRoleCode(input.role)) throw new RoleAssignmentError("unknown_role");
    if (!ROLES[input.role].scopes.has(input.scope.type)) throw new RoleAssignmentError("scope_not_allowed");
    await this.checkTargetRole(trx, input);
    // CHECK valid_until > granted_at (now() транзакции) отклонил бы прошедший срок ошибкой БД (500) — проверяем заранее.
    if (input.validUntil && input.validUntil.getTime() <= Date.now())
      throw new RoleAssignmentError("valid_until_in_past");
    // Регион назначения — из иерархии на сервере (region_id области), не из запроса.
    const chain = await this.hierarchy.chain(input.scope);
    if (!chain) throw new RoleAssignmentError("scope_not_found");
    const repo = new RoleAssignmentsRepository(trx);
    const id = scopeId(input.scope);
    if (await repo.findUnrevoked(input.userId, input.role, input.scope.type, id))
      throw new RoleAssignmentError("already_assigned");
    const row = await repo
      .insert({
        user_id: input.userId,
        role: input.role,
        scope_type: input.scope.type,
        scope_id: id,
        region_id: chainRegionId(chain),
        granted_by: input.actor.type === "user" ? input.actor.userId : null,
        valid_until: input.validUntil ?? null,
      })
      .catch((e: unknown) => {
        throw insertError(e);
      });
    await this.audit.record(trx, {
      ...auditMeta(input),
      action: ROLE_AUDIT_ACTIONS.assign,
      entityType: ROLE_ASSIGNMENT_ENTITY,
      entityId: row.id,
      newValues: snapshot(row),
      regionId: row.region_id,
    });
    return row;
  }

  /**
   * Кого может назначить актор (roles-and-data §1.4 «Назначить RA/MO/FI/AM», §1.7г): REGION_ADMIN — только MODERATOR
   * и AMBASSADOR; SUPERADMIN и REGION_ADMIN назначает только SUPERADMIN (или TECH_SUPERUSER в тестах/seed). Роль актора
   * — по его назначению (actorAssignmentId) среди действующих назначений пользователя (функция БД от SYSTEM: назначение
   * PLATFORM не видно в контексте региона). SYSTEM (seed, CLI) не ограничен. Fail-closed: у актора-пользователя без
   * actorAssignmentId или с назначением, которого нет среди действующих, — role_not_assignable. Эндпоинт назначения
   * (блок 3/6) берёт actorAssignmentId только из req.authorization.grant.id (итог @RequirePermission), не из тела.
   */
  private async checkTargetRole(trx: Db, input: AssignRoleInput): Promise<void> {
    if (input.actor.type !== "user") return;
    const actorId = input.actorAssignmentId?.toLowerCase();
    const actorRole = actorId
      ? (await new RoleAssignmentsRepository(trx).activeGrantsOf(input.actor.userId)).find(
          (g) => g.id.toLowerCase() === actorId,
        )?.role
      : undefined;
    if (!canAssignRole(actorRole, input.role)) throw new RoleAssignmentError("role_not_assignable");
  }

  /** Отзыв действующего назначения; уже отозванное, чужого региона или несуществующее — not_found. */
  async revoke(trx: Db, input: RevokeRoleInput): Promise<RoleAssignment> {
    requireTransaction(trx);
    checkActorAssignment(input);
    const row = await new RoleAssignmentsRepository(trx).revoke(input.assignmentId, {
      revokedBy: input.actor.type === "user" ? input.actor.userId : null,
      reason: input.reason ?? null,
    });
    if (!row) throw new RoleAssignmentError("not_found");
    await this.audit.record(trx, {
      ...auditMeta(input),
      action: ROLE_AUDIT_ACTIONS.revoke,
      entityType: ROLE_ASSIGNMENT_ENTITY,
      entityId: row.id,
      oldValues: { ...snapshot(row), revokedAt: null },
      newValues: { revokedAt: row.revoked_at?.toISOString() ?? null, revokedBy: row.revoked_by },
      regionId: row.region_id,
    });
    return row;
  }
}

/** Роли, которые назначает только платформа (SUPERADMIN). */
const PLATFORM_ASSIGNED_ROLES: ReadonlySet<string> = new Set([
  "SUPERADMIN",
  "TECH_SUPERUSER",
  "REGION_ADMIN",
]);
const PLATFORM_ASSIGNERS: ReadonlySet<string> = new Set(["SUPERADMIN", "TECH_SUPERUSER"]);
/**
 * Кого назначает REGION_ADMIN в своём регионе (AMBASSADOR — блок 11, пока не в реестре): модератора, персонал
 * заведения ORG_STAFF/ORG_OWNER (блок 5 — назначение админом до кабинета партнёра блока 6, ADR-0020).
 */
const REGION_ADMIN_ASSIGNS: ReadonlySet<string> = new Set([
  "MODERATOR",
  "AMBASSADOR",
  "ORG_STAFF",
  "ORG_MANAGER",
  "ORG_OWNER",
]);
/** Кого назначает владелец организации (S-06, блок 6): только сотрудников — менеджера и кассира, не владельца. */
const ORG_OWNER_ASSIGNS: ReadonlySet<string> = new Set(["ORG_MANAGER", "ORG_STAFF"]);
/** Роли партнёра без права назначать кого-либо (S-06: «ORG_MANAGER пытается выдать роль» — отказ). */
const ORG_NON_ASSIGNERS: ReadonlySet<string> = new Set(["ORG_MANAGER", "ORG_STAFF"]);

/**
 * Может ли актор с ролью actorRole назначить роль target. undefined — назначение актора не найдено: отказ
 * (fail-closed). Технические роли-заглушки (TECH_*) вне бизнес-матрицы: ограничены только платформенными целями.
 */
export function canAssignRole(actorRole: string | undefined, target: string): boolean {
  if (actorRole === undefined) return false;
  if (PLATFORM_ASSIGNERS.has(actorRole)) return true;
  if (PLATFORM_ASSIGNED_ROLES.has(target)) return false;
  if (actorRole === "REGION_ADMIN") return REGION_ADMIN_ASSIGNS.has(target);
  if (actorRole === "ORG_OWNER") return ORG_OWNER_ASSIGNS.has(target);
  if (ORG_NON_ASSIGNERS.has(actorRole)) return false;
  return true;
}

/**
 * Ошибка БД при вставке назначения → RoleAssignmentError (иначе — как есть, 500): нет пользователя или региона (FK,
 * 23503 — регион REGION-области иерархия не проверяет), гонка одинаковых назначений (уникальный индекс, 23505),
 * срок не после granted_at (CHECK, 23514 — расхождение часов приложения и БД). Транзакция после такой ошибки
 * прервана — вызывающий её откатывает (withTenant — при исключении).
 */
const INSERT_CONSTRAINT_ERRORS: Readonly<Record<string, RoleAssignmentErrorReason>> = {
  "23503:role_assignments_user_id_fkey": "user_not_found",
  "23503:role_assignments_region_id_fkey": "scope_not_found",
  "23505:role_assignments_active_key": "already_assigned",
  "23514:role_assignments_valid_until_after_grant": "valid_until_in_past",
};

function insertError(e: unknown): unknown {
  if (typeof e !== "object" || e === null) return e;
  const { code, constraint } = e as { code?: unknown; constraint?: unknown };
  const reason = INSERT_CONSTRAINT_ERRORS[`${String(code)}:${String(constraint)}`];
  return reason ? new RoleAssignmentError(reason) : e;
}

function requireTransaction(trx: Db): void {
  if (!trx.isTransaction)
    throw new Error("RoleAssignmentService: передайте транзакцию (withTenant), а не корневой db");
}

function checkActorAssignment(meta: AuditMeta): void {
  if (meta.actor.type === "system" && meta.actorAssignmentId)
    throw new Error("RoleAssignmentService: actorAssignmentId — только для актора-пользователя");
}

function auditMeta(meta: AuditMeta) {
  return {
    actor: meta.actor,
    roleAssignmentId: meta.actorAssignmentId ?? null,
    reason: meta.reason ?? null,
    requestId: meta.requestId ?? null,
  };
}

/** Неизменяемые поля назначения для аудита (без ПДн: только id). */
function snapshot(row: RoleAssignment): JsonObject {
  return {
    userId: row.user_id,
    role: row.role,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    regionId: row.region_id,
    validUntil: row.valid_until?.toISOString() ?? null,
  };
}
