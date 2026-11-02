// T1-12: назначения ролей на реальной PostgreSQL под ролью приложения (логин-роль в группе app): RLS
// role_assignments, неизменяемость (только отзыв), функция app_active_role_assignments(), назначение и отзыв через
// RoleAssignmentService — запись аудита в той же транзакции, откат без аудита. README apps/api, «RBAC».
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  createDatabase,
  PLATFORM_CONTEXT,
  regionContext,
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
} from "../../src/db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../../src/modules/audit/index.js";
import {
  PLATFORM_SCOPE,
  RoleAssignmentsRepository,
  regionScope,
  ScopeHierarchy,
} from "../../src/modules/rbac/index.js";
import { RoleAssignmentService } from "../../src/modules/role-assignments/index.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_rbac_test";
const APP_PASSWORD = "tg_api_rbac_test";
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error("Ожидалась ошибка PostgreSQL, запрос выполнился");
}

describe.skipIf(!dockerAvailable)(`RBAC: назначения ролей (T1-12)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let owner: pg.Client;
  let appDb: Db;
  /** Прямой SQL под ролью приложения. */
  let raw: pg.Client;
  let regionA: string;
  let regionB: string;
  const service = new RoleAssignmentService(
    new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS),
    new ScopeHierarchy(),
  );

  /** Прямой SQL под ролью приложения в транзакции с переменными контекста (как их ставит withTenant). */
  async function inTx<T>(vars: { region?: string; actor?: string }, fn: () => Promise<T>): Promise<T> {
    await raw.query("BEGIN");
    try {
      await raw.query("SELECT set_config('app.region_id', $1, true), set_config('app.actor', $2, true)", [
        vars.region ?? "",
        vars.actor ?? "",
      ]);
      return await fn();
    } finally {
      await raw.query("ROLLBACK");
    }
  }

  const newUser = async () =>
    String((await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0]!.id);

  /** Назначение напрямую (владелец = суперпользователь контейнера, RLS не действует). */
  async function insertAssignment(
    user: string,
    role: string,
    region: string | null,
    extra = "",
  ): Promise<string> {
    const { rows } = await owner.query(
      `INSERT INTO role_assignments (user_id, role, scope_type, scope_id, region_id${extra ? ", valid_until, granted_at" : ""})
       VALUES ($1, $2, $3, $4, $4${extra ? `, ${extra}` : ""}) RETURNING id`,
      [user, role, region ? "REGION" : "PLATFORM", region],
    );
    return String(rows[0]!.id);
  }

  beforeAll(async () => {
    tdb = await startDatabase();
    owner = tdb.client;
    await owner.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    const region = async (code: string) =>
      String(
        (
          await owner.query(
            `INSERT INTO regions (code, name_i18n) VALUES ($1, '{"uk": "Регіон"}') RETURNING id`,
            [code],
          )
        ).rows[0]!.id,
      );
    regionA = await region("t112-a");
    regionB = await region("t112-b");
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    raw = new pg.Client({ connectionString: url.toString() });
    await raw.connect();
  });

  afterAll(async () => {
    await raw?.end();
    await appDb?.destroy();
    await stopDatabase(tdb);
  });

  it("миграция 0005 применена; role_assignments — RLS и FORCE", async () => {
    expect(tdb!.applied).toContain("0005_rbac.sql");
    const { rows } = await owner.query(
      "SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname = 'role_assignments'",
    );
    expect(rows).toEqual([{ rls: true, force: true }]);
  });

  describe("RLS role_assignments под ролью приложения", () => {
    let user: string;

    beforeAll(async () => {
      user = await newUser();
      await insertAssignment(user, "TECH_AUDITOR", regionA);
      await insertAssignment(user, "TECH_AUDITOR", regionB);
      await insertAssignment(user, "TECH_SUPERUSER", null);
    });

    const regionsSeen = () =>
      raw
        .query<{
          region_id: string | null;
        }>("SELECT region_id FROM role_assignments WHERE user_id = $1", [user])
        .then((r) => r.rows.map((x) => x.region_id));

    it("регион A видит только назначения A; без контекста — ничего; SYSTEM — все, включая PLATFORM", async () => {
      expect(await inTx({ region: regionA }, regionsSeen)).toEqual([regionA]);
      expect(await inTx({}, regionsSeen)).toEqual([]);
      expect((await inTx({ actor: "system" }, regionsSeen)).sort()).toEqual([regionA, regionB, null].sort());
    });

    it("регион A не пишет назначение в регион B и на PLATFORM", async () => {
      for (const region of [regionB, null])
        await inTx({ region: regionA }, async () => {
          const e = await pgError(
            raw.query(
              `INSERT INTO role_assignments (user_id, role, scope_type, scope_id, region_id) VALUES ($1, 'TECH_AUDITOR', $2, $3, $3)`,
              [user, region ? "REGION" : "PLATFORM", region],
            ),
          );
          expect(e.code, String(region)).toBe(INSUFFICIENT_PRIVILEGE);
        });
    });

    it("app_active_role_assignments: из транзакции региона A — назначения всех регионов и PLATFORM, контекст восстановлен", async () => {
      await inTx({ region: regionA }, async () => {
        const { rows } = await raw.query<{ region_id: string | null }>(
          "SELECT region_id FROM app_active_role_assignments($1)",
          [user],
        );
        expect(rows.map((r) => r.region_id).sort()).toEqual([regionA, regionB, null].sort());
        const after = await raw.query(
          "SELECT current_setting('app.actor', true) AS actor, current_setting('app.region_id', true) AS region",
        );
        expect(after.rows[0]).toEqual({ actor: "", region: regionA });
        // После вызова — снова только свой регион.
        expect(await regionsSeen()).toEqual([regionA]);
      });
    });

    it("app_active_role_assignments через Kysely вне withTenant (как RequestAccess); отозванные и истёкшие — нет", async () => {
      const other = await newUser();
      await insertAssignment(other, "TECH_AUDITOR", regionA);
      await insertAssignment(
        other,
        "TECH_REGION_ADMIN",
        regionA,
        "now() + interval '1 hour', now() - interval '2 hours'",
      );
      await insertAssignment(
        other,
        "TECH_ORG_EDITOR",
        regionA,
        "now() - interval '1 hour', now() - interval '2 hours'",
      );
      const revoked = await insertAssignment(other, "TECH_SUPERUSER", null);
      await owner.query("UPDATE role_assignments SET revoked_at = now() WHERE id = $1", [revoked]);
      const grants = await new RoleAssignmentsRepository(appDb).activeGrantsOf(other);
      expect(grants.map((g) => g.role).sort()).toEqual(["TECH_AUDITOR", "TECH_REGION_ADMIN"]);
    });
  });

  describe("неизменяемость и ограничения", () => {
    it("DELETE запрещён правами; UPDATE — только отзыв и один раз (триггер)", async () => {
      const user = await newUser();
      const id = await insertAssignment(user, "TECH_AUDITOR", regionA);
      await inTx({ actor: "system" }, async () => {
        expect((await pgError(raw.query("DELETE FROM role_assignments WHERE id = $1", [id]))).code).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      });
      for (const q of [
        "UPDATE role_assignments SET role = 'TECH_SUPERUSER', revoked_at = now() WHERE id = $1",
        "UPDATE role_assignments SET valid_until = now() + interval '1 day' WHERE id = $1",
      ])
        await inTx({ actor: "system" }, async () => {
          expect((await pgError(raw.query(q, [id]))).code, q).toBe(CHECK_VIOLATION);
        });
      await owner.query("UPDATE role_assignments SET revoked_at = now(), revoke_reason = 'x' WHERE id = $1", [
        id,
      ]);
      const twice = await pgError(
        owner.query("UPDATE role_assignments SET revoke_reason = 'y' WHERE id = $1", [id]),
      );
      expect(twice.code).toBe(CHECK_VIOLATION);
    });

    it("область согласована с region_id; действующее назначение уникально, после отзыва — можно снова", async () => {
      const user = await newUser();
      for (const [scopeType, scopeId, region] of [
        ["PLATFORM", null, regionA],
        ["REGION", regionA, regionB],
        ["REGION", regionA, null],
        ["ORGANIZATION", null, regionA],
      ] as const) {
        const e = await pgError(
          owner.query(
            "INSERT INTO role_assignments (user_id, role, scope_type, scope_id, region_id) VALUES ($1, 'TECH_AUDITOR', $2, $3, $4)",
            [user, scopeType, scopeId, region],
          ),
        );
        expect(e.code, `${scopeType} ${String(region)}`).toBe(CHECK_VIOLATION);
      }
      const first = await insertAssignment(user, "TECH_SUPERUSER", null);
      expect((await pgError(insertAssignment(user, "TECH_SUPERUSER", null))).code).toBe(UNIQUE_VIOLATION);
      await owner.query("UPDATE role_assignments SET revoked_at = now() WHERE id = $1", [first]);
      await insertAssignment(user, "TECH_SUPERUSER", null);
    });
  });

  describe("RoleAssignmentService: назначение и отзыв с аудитом", () => {
    let admin: string;
    let adminGrant: string;

    beforeAll(async () => {
      admin = await newUser();
      adminGrant = await insertAssignment(admin, "TECH_REGION_ADMIN", regionA);
    });

    const auditOf = (id: string) =>
      owner
        .query<{
          action: string;
          region_id: string | null;
          actor_user_id: string;
          role_assignment_id: string | null;
        }>(
          "SELECT action, region_id, actor_user_id, role_assignment_id FROM audit_logs WHERE entity_type = 'role_assignment' AND entity_id = $1 ORDER BY id",
          [id],
        )
        .then((r) => r.rows);

    it("назначение в регионе A: строка и запись аудита role.assign в одной транзакции; отзыв — role.revoke", async () => {
      const user = await newUser();
      const row = await withTenant(appDb, regionContext(regionA), (trx) =>
        service.assign(trx, {
          userId: user,
          role: "TECH_AUDITOR",
          scope: regionScope(regionA),
          actor: { type: "user", userId: admin },
          actorAssignmentId: adminGrant,
          requestId: "req-assign",
        }),
      );
      expect(row).toMatchObject({ region_id: regionA, granted_by: admin, revoked_at: null });
      await withTenant(appDb, regionContext(regionA), (trx) =>
        service.revoke(trx, {
          assignmentId: row.id,
          actor: { type: "user", userId: admin },
          actorAssignmentId: adminGrant,
          reason: "тест",
        }),
      );
      expect(await auditOf(row.id)).toEqual([
        { action: "role.assign", region_id: regionA, actor_user_id: admin, role_assignment_id: adminGrant },
        { action: "role.revoke", region_id: regionA, actor_user_id: admin, role_assignment_id: adminGrant },
      ]);
      const { rows } = await owner.query(
        "SELECT revoked_by, revoke_reason FROM role_assignments WHERE id = $1",
        [row.id],
      );
      expect(rows).toEqual([{ revoked_by: admin, revoke_reason: "тест" }]);
    });

    it("откат бизнес-транзакции — ни назначения, ни записи аудита", async () => {
      const user = await newUser();
      let id: string | undefined;
      const e = await withTenant(appDb, regionContext(regionA), async (trx) => {
        id = (
          await service.assign(trx, {
            userId: user,
            role: "TECH_AUDITOR",
            scope: regionScope(regionA),
            actor: { type: "system" },
          })
        ).id;
        throw new Error("откат");
      }).catch((err: unknown) => err as Error);
      expect(e.message).toBe("откат");
      expect(id).toBeDefined();
      expect((await owner.query("SELECT 1 FROM role_assignments WHERE id = $1", [id])).rows).toEqual([]);
      expect(await auditOf(id!)).toEqual([]);
    });

    it("PLATFORM-назначение — только в кросс-tenant контексте; аудит с region_id NULL", async () => {
      const user = await newUser();
      const row = await withTenant(appDb, PLATFORM_CONTEXT, (trx) =>
        service.assign(trx, {
          userId: user,
          role: "TECH_SUPERUSER",
          scope: PLATFORM_SCOPE,
          actor: { type: "system" },
        }),
      );
      expect(row.region_id).toBeNull();
      expect(await auditOf(row.id)).toEqual([
        { action: "role.assign", region_id: null, actor_user_id: null, role_assignment_id: null },
      ]);
      // Регион A не видит и не отзывает PLATFORM-назначение.
      const err = await withTenant(appDb, regionContext(regionA), (trx) =>
        service.revoke(trx, { assignmentId: row.id, actor: { type: "system" } }),
      ).then(
        () => undefined,
        (x: unknown) => (x as { reason?: string }).reason,
      );
      expect(err).toBe("not_found");
      await withTenant(appDb, SYSTEM_CONTEXT, (trx) =>
        service.revoke(trx, { assignmentId: row.id, actor: { type: "system" } }),
      );
    });

    it("audit_logs.role_assignment_id — только у актора-пользователя", async () => {
      const e = await pgError(
        owner.query(
          "INSERT INTO audit_logs (actor_type, action, entity_type, role_assignment_id) VALUES ('system', 'x', 'y', $1)",
          [adminGrant],
        ),
      );
      expect(e.code).toBe(CHECK_VIOLATION);
    });
  });
});
