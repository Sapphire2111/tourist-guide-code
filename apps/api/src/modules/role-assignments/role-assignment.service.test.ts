// Unit (без БД): назначение и отзыв роли — строка role_assignments и запись аудита role.assign/role.revoke в одной
// транзакции, регион назначения из иерархии; отказы. На реальной PostgreSQL (RLS, откат) —
// test/integration/rbac.test.ts.
import type { CompiledQuery } from "kysely";
import { describe, expect, it } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import {
  PLATFORM_CONTEXT,
  regionContext,
  SYSTEM_CONTEXT,
  TenantContextError,
  withTenant,
} from "../../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../audit/index.js";
import {
  PLATFORM_SCOPE,
  RoleAssignmentsRepository,
  regionScope,
  scope,
  ScopeHierarchy,
} from "../rbac/index.js";
import { canAssignRole, RoleAssignmentError, RoleAssignmentService } from "./role-assignment.service.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const ORG_A = "0190f5c2-7d3e-7000-8000-0000000000a1";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const ADMIN = "0190f5c2-7d3e-7000-8000-0000000000ad";
const ADMIN_GRANT = "0190f5c2-7d3e-7000-8000-000000000101";
const RA_ID = "0190f5c2-7d3e-7000-8000-000000000201";

const service = new RoleAssignmentService(
  new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS),
  new ScopeHierarchy({ ORGANIZATION: (id) => (id === ORG_A ? regionScope(A) : undefined) }),
);

function assignmentRow(over: Record<string, unknown> = {}) {
  return {
    id: RA_ID,
    user_id: USER,
    role: "TECH_REGION_ADMIN",
    scope_type: "REGION",
    scope_id: A,
    region_id: A,
    granted_by: ADMIN,
    granted_at: new Date("2026-11-01T10:00:00Z"),
    valid_until: null,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    ...over,
  };
}

/** БД-заглушка: insert/update role_assignments и insert audit_logs отдают строку; select existing — `existing`. */
function db(opts: { existing?: boolean; row?: Record<string, unknown>; revoked?: boolean } = {}) {
  return recordingDb({}, (q: CompiledQuery) => {
    if (q.sql.startsWith('select * from "role_assignments"')) return opts.existing ? [assignmentRow()] : [];
    // Назначение актора ADMIN (по нему canAssignRole решает, кого он может назначить).
    if (q.sql.includes("app_active_role_assignments"))
      return [
        {
          id: ADMIN_GRANT,
          role: "TECH_REGION_ADMIN",
          scope_type: "REGION",
          scope_id: A,
          region_id: A,
          granted_at: new Date(),
          valid_until: null,
        },
      ];
    if (q.sql.startsWith('insert into "role_assignments"')) return [opts.row ?? assignmentRow()];
    if (q.sql.startsWith('update "role_assignments"'))
      return opts.revoked === false
        ? []
        : [
            assignmentRow({
              revoked_at: new Date("2026-11-02T10:00:00Z"),
              revoked_by: ADMIN,
              revoke_reason: "r",
            }),
          ];
    if (q.sql.startsWith('insert into "audit_logs"')) return [{ id: "log-1", region_id: A }];
    return [];
  });
}

/** БД-заглушка, где INSERT в role_assignments падает ошибкой PostgreSQL (как pg.DatabaseError: code, constraint). */
function failingInsertDb(code: string, constraint: string) {
  return recordingDb({}, (q: CompiledQuery) => {
    if (q.sql.startsWith('insert into "role_assignments"'))
      throw Object.assign(new Error("db error"), { code, constraint });
    return [];
  });
}

const auditInsert = (queries: CompiledQuery[]) =>
  queries.find((q) => q.sql.startsWith('insert into "audit_logs"'))!;

describe("RoleAssignmentService.assign", () => {
  it("в контексте региона: проверка дубля, вставка с регионом области, аудит role.assign в той же транзакции", async () => {
    const { db: kdb, queries } = db();
    const row = await withTenant(kdb, regionContext(A), (trx) =>
      service.assign(trx, {
        userId: USER,
        role: "TECH_REGION_ADMIN",
        scope: regionScope(A),
        actor: { type: "user", userId: ADMIN },
        actorAssignmentId: ADMIN_GRANT,
        reason: "пилот",
        requestId: "req-1",
      }),
    );
    expect(row.id).toBe(RA_ID);
    expect(queries.map((q) => q.sql.split(" (")[0])).toEqual([
      "SELECT set_config('app.region_id', $1, true), set_config('app.actor', $2, true)",
      // Роль актора — кого он может назначить (canAssignRole).
      'select * from app_active_role_assignments($1) as "ra"',
      'select * from "role_assignments" where',
      'insert into "role_assignments"',
      'insert into "audit_logs"',
    ]);
    expect(queries[3]!.sql).toContain('"region_id"');
    expect(queries[3]!.parameters).toEqual([USER, "TECH_REGION_ADMIN", "REGION", A, A, ADMIN, null]);
    const audit = auditInsert(queries);
    expect(audit.sql).toContain('"role_assignment_id"');
    expect(audit.parameters).toEqual([
      "user",
      ADMIN,
      A,
      "role.assign",
      "role_assignment",
      RA_ID,
      null,
      {
        userId: USER,
        role: "TECH_REGION_ADMIN",
        scopeType: "REGION",
        scopeId: A,
        regionId: A,
        validUntil: null,
      },
      "пилот",
      "req-1",
      ADMIN_GRANT,
    ]);
  });

  it("ORGANIZATION: region_id назначения — регион организации из иерархии", async () => {
    const { db: kdb, queries } = db();
    await withTenant(kdb, SYSTEM_CONTEXT, (trx) =>
      service.assign(trx, {
        userId: USER,
        role: "TECH_ORG_EDITOR",
        scope: scope("ORGANIZATION", ORG_A),
        actor: { type: "system" },
      }),
    );
    const insert = queries.find((q) => q.sql.startsWith('insert into "role_assignments"'))!;
    expect(insert.parameters).toEqual([USER, "TECH_ORG_EDITOR", "ORGANIZATION", ORG_A, A, null, null]);
  });

  it("отказы: неизвестная роль, недопустимая область, объект не найден, дубль — без вставки и аудита", async () => {
    const cases: [Parameters<RoleAssignmentService["assign"]>[1], string, boolean][] = [
      [
        { userId: USER, role: "AMBASSADOR", scope: PLATFORM_SCOPE, actor: { type: "system" } },
        "unknown_role",
        false,
      ],
      [
        { userId: USER, role: "TECH_REGION_ADMIN", scope: PLATFORM_SCOPE, actor: { type: "system" } },
        "scope_not_allowed",
        false,
      ],
      [
        {
          userId: USER,
          role: "TECH_ORG_EDITOR",
          scope: scope("ORGANIZATION", "0190f5c2-7d3e-7000-8000-0000000000ff"),
          actor: { type: "system" },
        },
        "scope_not_found",
        false,
      ],
      [
        { userId: USER, role: "TECH_REGION_ADMIN", scope: regionScope(A), actor: { type: "system" } },
        "already_assigned",
        true,
      ],
    ];
    for (const [input, reason, existing] of cases) {
      const { db: kdb, queries } = db({ existing });
      const err = await withTenant(kdb, SYSTEM_CONTEXT, (trx) => service.assign(trx, input)).catch(
        (e: unknown) => e,
      );
      expect(err, reason).toBeInstanceOf(RoleAssignmentError);
      expect((err as RoleAssignmentError).reason).toBe(reason);
      expect(queries.filter((q) => q.sql.startsWith("insert"))).toEqual([]);
    }
  });

  it("срок действия в прошлом или сейчас — valid_until_in_past до запросов к БД; в будущем — вставка", async () => {
    const input = {
      userId: USER,
      role: "TECH_REGION_ADMIN",
      scope: regionScope(A),
      actor: { type: "system" },
    } as const;
    for (const validUntil of [new Date(Date.now() - 60_000), new Date()]) {
      const { db: kdb, queries } = db();
      const err = await withTenant(kdb, SYSTEM_CONTEXT, (trx) =>
        service.assign(trx, { ...input, validUntil }),
      ).catch((e: unknown) => e);
      expect((err as RoleAssignmentError).reason).toBe("valid_until_in_past");
      expect(queries.filter((q) => q.sql.includes("role_assignments"))).toEqual([]);
    }
    const future = new Date(Date.now() + 86_400_000);
    const { db: kdb, queries } = db();
    await withTenant(kdb, SYSTEM_CONTEXT, (trx) => service.assign(trx, { ...input, validUntil: future }));
    const insert = queries.find((q) => q.sql.startsWith('insert into "role_assignments"'))!;
    expect(insert.parameters).toContain(future);
  });

  it("ошибки БД при вставке: FK пользователя/региона, гонка дублей, CHECK срока — RoleAssignmentError, без аудита", async () => {
    const cases: [string, string, string][] = [
      ["23503", "role_assignments_user_id_fkey", "user_not_found"],
      ["23503", "role_assignments_region_id_fkey", "scope_not_found"],
      ["23505", "role_assignments_active_key", "already_assigned"],
      ["23514", "role_assignments_valid_until_after_grant", "valid_until_in_past"],
    ];
    for (const [code, constraint, reason] of cases) {
      const { db: kdb, queries } = failingInsertDb(code, constraint);
      const err = await withTenant(kdb, SYSTEM_CONTEXT, (trx) =>
        service.assign(trx, {
          userId: USER,
          role: "TECH_REGION_ADMIN",
          scope: regionScope(A),
          actor: { type: "system" },
        }),
      ).catch((e: unknown) => e);
      expect(err, reason).toBeInstanceOf(RoleAssignmentError);
      expect((err as RoleAssignmentError).reason).toBe(reason);
      expect(queries.some((q) => q.sql.startsWith('insert into "audit_logs"'))).toBe(false);
    }
  });

  it("прочие ошибки БД при вставке (FK granted_by, другой код) — как есть", async () => {
    for (const [code, constraint] of [
      ["23503", "role_assignments_granted_by_fkey"],
      ["40001", "role_assignments_active_key"],
    ] as const) {
      const { db: kdb } = failingInsertDb(code, constraint);
      const err = await withTenant(kdb, SYSTEM_CONTEXT, (trx) =>
        service.assign(trx, {
          userId: USER,
          role: "TECH_REGION_ADMIN",
          scope: regionScope(A),
          actor: { type: "system" },
        }),
      ).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(RoleAssignmentError);
      expect((err as { code: string }).code).toBe(code);
    }
  });

  it("назначение PLATFORM в контексте региона — ошибка tenant-изоляции (region_id NULL в регионе)", async () => {
    const { db: kdb } = db({
      row: assignmentRow({ scope_type: "PLATFORM", scope_id: null, region_id: null }),
    });
    await expect(
      withTenant(kdb, regionContext(A), (trx) =>
        service.assign(trx, {
          userId: USER,
          role: "TECH_SUPERUSER",
          scope: PLATFORM_SCOPE,
          actor: { type: "system" },
        }),
      ),
    ).rejects.toBeInstanceOf(TenantContextError);
  });

  it("вне транзакции и с назначением актора-системы — ошибка", async () => {
    const { db: kdb } = db();
    const input = {
      userId: USER,
      role: "TECH_REGION_ADMIN",
      scope: regionScope(A),
      actor: { type: "system" },
    } as const;
    await expect(service.assign(kdb, input)).rejects.toThrow(/транзакцию/);
    await expect(
      withTenant(kdb, PLATFORM_CONTEXT, (trx) =>
        service.assign(trx, { ...input, actorAssignmentId: ADMIN_GRANT }),
      ),
    ).rejects.toThrow(/только для актора-пользователя/);
  });
});

describe("RoleAssignmentService.revoke", () => {
  it("отзыв: UPDATE только неотозванного, аудит role.revoke с old/new", async () => {
    const { db: kdb, queries } = db();
    await withTenant(kdb, regionContext(A), (trx) =>
      service.revoke(trx, {
        assignmentId: RA_ID,
        actor: { type: "user", userId: ADMIN },
        actorAssignmentId: ADMIN_GRANT,
        reason: "r",
      }),
    );
    const update = queries.find((q) => q.sql.startsWith('update "role_assignments"'))!;
    expect(update.sql).toBe(
      'update "role_assignments" set "revoked_at" = now(), "revoked_by" = $1, "revoke_reason" = $2 where ("id" = $3 and "revoked_at" is null) and "role_assignments"."region_id" = $4 returning *',
    );
    expect(update.parameters).toEqual([ADMIN, "r", RA_ID, A]);
    const audit = auditInsert(queries);
    expect(audit.parameters.slice(3, 8)).toEqual([
      "role.revoke",
      "role_assignment",
      RA_ID,
      expect.objectContaining({ revokedAt: null, role: "TECH_REGION_ADMIN" }),
      { revokedAt: "2026-11-02T10:00:00.000Z", revokedBy: ADMIN },
    ]);
  });

  it("нет действующего назначения (отозвано, чужой регион) — not_found, без аудита", async () => {
    const { db: kdb, queries } = db({ revoked: false });
    const err = await withTenant(kdb, regionContext(A), (trx) =>
      service.revoke(trx, { assignmentId: RA_ID, actor: { type: "system" } }),
    ).catch((e: unknown) => e);
    expect((err as RoleAssignmentError).reason).toBe("not_found");
    expect(queries.some((q) => q.sql.startsWith('insert into "audit_logs"'))).toBe(false);
  });
});

describe("RoleAssignmentsRepository.activeGrantsOf", () => {
  it("функция БД без tenant-контекста (до транзакции запроса) и внутри неё; строки → Grant", async () => {
    const { db: kdb, queries } = recordingDb({}, () => [
      {
        id: RA_ID,
        role: "TECH_AUDITOR",
        scope_type: "REGION",
        scope_id: A,
        region_id: A,
        granted_at: new Date(),
        valid_until: null,
      },
    ]);
    const repo = new RoleAssignmentsRepository(kdb);
    expect(await repo.activeGrantsOf(USER)).toEqual([
      { id: RA_ID, role: "TECH_AUDITOR", scopeType: "REGION", scopeId: A, regionId: A, validUntil: null },
    ]);
    await withTenant(kdb, regionContext(A), () => repo.activeGrantsOf(USER));
    expect(queries.map((q) => q.sql)).toEqual([
      'select * from app_active_role_assignments($1) as "ra"',
      "SELECT set_config('app.region_id', $1, true), set_config('app.actor', $2, true)",
      'select * from app_active_role_assignments($1) as "ra"',
    ]);
    expect(queries[0]!.parameters).toEqual([USER]);
  });
});

describe("кого может назначить актор (roles-and-data §1.4, §1.7г)", () => {
  it("canAssignRole: REGION_ADMIN — MODERATOR и AMBASSADOR; SUPERADMIN и REGION_ADMIN — только SUPERADMIN", () => {
    expect(canAssignRole("REGION_ADMIN", "MODERATOR")).toBe(true);
    expect(canAssignRole("REGION_ADMIN", "AMBASSADOR")).toBe(true);
    // Персонал заведения (блок 5, ADR-0020).
    expect(canAssignRole("REGION_ADMIN", "ORG_STAFF")).toBe(true);
    expect(canAssignRole("REGION_ADMIN", "ORG_OWNER")).toBe(true);
    for (const target of ["REGION_ADMIN", "SUPERADMIN", "TECH_AUDITOR"])
      expect(canAssignRole("REGION_ADMIN", target), target).toBe(false);
    for (const target of ["REGION_ADMIN", "SUPERADMIN", "MODERATOR"])
      expect(canAssignRole("SUPERADMIN", target), target).toBe(true);
    expect(canAssignRole("TECH_REGION_ADMIN", "REGION_ADMIN")).toBe(false);
    // Fail-closed: назначение актора не найдено — отказ для любой цели.
    for (const target of ["SUPERADMIN", "MODERATOR", "TECH_AUDITOR"])
      expect(canAssignRole(undefined, target)).toBe(false);
    // TECH_SUPERUSER назначает только платформа.
    expect(canAssignRole("REGION_ADMIN", "TECH_SUPERUSER")).toBe(false);
    expect(canAssignRole("TECH_REGION_ADMIN", "TECH_SUPERUSER")).toBe(false);
    expect(canAssignRole("SUPERADMIN", "TECH_SUPERUSER")).toBe(true);
    expect(canAssignRole("TECH_REGION_ADMIN", "TECH_AUDITOR")).toBe(true);
  });

  /** БД: назначения актора (функция app_active_role_assignments) и вставка назначения. */
  function actorDb(actorRole: string, actorScope: "REGION" | "PLATFORM") {
    return recordingDb({}, (q: CompiledQuery) => {
      if (q.sql.includes("app_active_role_assignments"))
        return [
          {
            id: ADMIN_GRANT,
            role: actorRole,
            scope_type: actorScope,
            scope_id: actorScope === "REGION" ? A : null,
            region_id: actorScope === "REGION" ? A : null,
            granted_at: new Date(),
            valid_until: null,
          },
        ];
      if (q.sql.startsWith('insert into "role_assignments"')) return [assignmentRow({ role: "MODERATOR" })];
      if (q.sql.startsWith('insert into "audit_logs"')) return [{ id: "log-1", region_id: A }];
      return [];
    });
  }

  const input = (role: string) => ({
    userId: USER,
    role,
    scope: regionScope(A),
    actor: { type: "user" as const, userId: ADMIN },
    actorAssignmentId: ADMIN_GRANT,
  });

  it("REGION_ADMIN назначает MODERATOR; REGION_ADMIN — отказ role_not_assignable без вставки", async () => {
    const ok = actorDb("REGION_ADMIN", "REGION");
    await withTenant(ok.db, regionContext(A), (trx) => service.assign(trx, input("MODERATOR")));
    expect(ok.queries.some((q) => q.sql.startsWith('insert into "role_assignments"'))).toBe(true);

    const denied = actorDb("REGION_ADMIN", "REGION");
    const err = await withTenant(denied.db, regionContext(A), (trx) =>
      service.assign(trx, input("REGION_ADMIN")),
    ).catch((e: unknown) => e);
    expect((err as RoleAssignmentError).reason).toBe("role_not_assignable");
    expect(denied.queries.some((q) => q.sql.startsWith('insert into "role_assignments"'))).toBe(false);
  });

  it("актор-пользователь без actorAssignmentId или с чужим/недействующим назначением — role_not_assignable", async () => {
    for (const actorAssignmentId of [undefined, "0190f5c2-7d3e-7000-8000-000000000999"]) {
      const d = actorDb("SUPERADMIN", "PLATFORM");
      const err = await withTenant(d.db, regionContext(A), (trx) =>
        service.assign(trx, { ...input("MODERATOR"), actorAssignmentId }),
      ).catch((e: unknown) => e);
      expect((err as RoleAssignmentError).reason, String(actorAssignmentId)).toBe("role_not_assignable");
      expect(d.queries.some((q) => q.sql.startsWith('insert into "role_assignments"'))).toBe(false);
    }
  });

  it("SUPERADMIN (назначение PLATFORM) назначает REGION_ADMIN и в контексте региона", async () => {
    const sa = actorDb("SUPERADMIN", "PLATFORM");
    await withTenant(sa.db, regionContext(A), (trx) => service.assign(trx, input("REGION_ADMIN")));
    expect(sa.queries.some((q) => q.sql.startsWith('insert into "role_assignments"'))).toBe(true);
  });
});
