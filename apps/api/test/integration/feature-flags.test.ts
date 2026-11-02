// T1-22: фича-флаги на реальной PostgreSQL под ролью приложения (логин-роль в группе app): миграция 0008, права
// (отметки гейта — только добавление), уникальность переопределения на окружение (NULLS NOT DISTINCT, upsert),
// FeatureFlagsService — переопределение и запись аудита в одной транзакции, откат без следов, finance.live выключен
// на чистой базе во всех окружениях. README apps/api, «Фича-флаги».
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { APP_ENVS } from "@tg/server-config";
import { createDatabase, PLATFORM_CONTEXT, withTenant, type Db } from "../../src/db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../../src/modules/audit/index.js";
import {
  FeatureFlagError,
  FeatureFlagsRepository,
  FeatureFlagsService,
} from "../../src/modules/feature-flags/index.js";
import { RbacService, RoleAssignmentsRepository, ScopeHierarchy } from "../../src/modules/rbac/index.js";
import { RegionsRepository } from "../../src/modules/regions/index.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_flags_test";
const APP_PASSWORD = "tg_api_flags_test";
const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error("Ожидалась ошибка PostgreSQL, запрос выполнился");
}

describe.skipIf(!dockerAvailable)(`Фича-флаги (T1-22)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let owner: pg.Client;
  let appDb: Db;
  let raw: pg.Client;
  let regionA: string;
  let admin: string;

  const service = (appEnv: (typeof APP_ENVS)[number]) =>
    new FeatureFlagsService(
      appEnv,
      new FeatureFlagsRepository(appDb),
      new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS),
      new RbacService(new RoleAssignmentsRepository(appDb), new ScopeHierarchy()),
      new RegionsRepository(appDb),
    );

  beforeAll(async () => {
    tdb = await startDatabase();
    owner = tdb.client;
    await owner.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    regionA = String(
      (
        await owner.query(
          `INSERT INTO regions (code, name_i18n) VALUES ('t122-a', '{"uk": "Регіон"}') RETURNING id`,
        )
      ).rows[0]!.id,
    );
    admin = String((await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0]!.id);
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

  it("миграция 0008 применена; таблицы global — без RLS", async () => {
    expect(tdb!.applied).toContain("0008_feature_flags.sql");
    const { rows } = await owner.query(
      "SELECT relname, relrowsecurity AS rls FROM pg_class WHERE relname IN ('feature_flags', 'feature_flag_gate_marks') ORDER BY relname",
    );
    expect(rows).toEqual([
      { relname: "feature_flag_gate_marks", rls: false },
      { relname: "feature_flags", rls: false },
    ]);
  });

  it("на чистой базе finance.live выключен во всех окружениях (и на уровне региона)", async () => {
    for (const env of APP_ENVS) {
      expect((await service(env).effective(null))["finance.live"], env).toBe(false);
      expect((await service(env).effective(regionA))["finance.live"], env).toBe(false);
    }
  });

  it("одно переопределение на окружение (NULLS NOT DISTINCT); формат ключа — CHECK", async () => {
    await owner.query("INSERT INTO feature_flags (key, enabled) VALUES ('module.t122', true)");
    const dup = await pgError(
      owner.query("INSERT INTO feature_flags (key, enabled) VALUES ('module.t122', false)"),
    );
    expect(dup.code).toBe(UNIQUE_VIOLATION);
    const bad = await pgError(
      owner.query("INSERT INTO feature_flags (key, enabled) VALUES ('Bad Key', true)"),
    );
    expect(bad.code).toBe(CHECK_VIOLATION);
    await owner.query("DELETE FROM feature_flags WHERE key = 'module.t122'");
  });

  it("отметки гейта под ролью приложения: INSERT и SELECT, UPDATE и DELETE запрещены", async () => {
    await raw.query("INSERT INTO feature_flag_gate_marks (decision, document_ref) VALUES ('D-99', 'тест')");
    for (const sql of [
      "UPDATE feature_flag_gate_marks SET document_ref = 'x' WHERE decision = 'D-99'",
      "DELETE FROM feature_flag_gate_marks WHERE decision = 'D-99'",
    ])
      expect((await pgError(raw.query(sql))).code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    await owner.query("DELETE FROM feature_flag_gate_marks WHERE decision = 'D-99'");
  });

  it("set: upsert переопределения окружения и региона, аудит в той же транзакции; повтор меняет строку", async () => {
    const flags = service("staging");
    const actor = { type: "user", userId: admin } as const;
    await withTenant(appDb, PLATFORM_CONTEXT, (trx) =>
      flags.set(trx, { key: "module.reviews", regionId: null, enabled: false, actor, requestId: "t122-1" }),
    );
    await withTenant(appDb, PLATFORM_CONTEXT, (trx) =>
      flags.set(trx, { key: "module.reviews", regionId: null, enabled: true, actor }),
    );
    await withTenant(appDb, PLATFORM_CONTEXT, (trx) =>
      flags.set(trx, { key: "module.reviews", regionId: regionA, enabled: false, actor }),
    );
    const { rows } = await owner.query(
      "SELECT target_region_id, enabled FROM feature_flags WHERE key = 'module.reviews' ORDER BY target_region_id NULLS FIRST",
    );
    expect(rows).toEqual([
      { target_region_id: null, enabled: true },
      { target_region_id: regionA, enabled: false },
    ]);
    expect((await flags.effective(regionA))["module.reviews"]).toBe(false);
    expect((await flags.effective(null))["module.reviews"]).toBe(true);
    const audit = await owner.query(
      "SELECT region_id, old_values, new_values FROM audit_logs WHERE action = 'feature_flag.set' AND entity_id = 'module.reviews' ORDER BY created_at, id",
    );
    expect(audit.rows).toEqual([
      { region_id: null, old_values: { enabled: null }, new_values: { enabled: false, appEnv: "staging" } },
      { region_id: null, old_values: { enabled: false }, new_values: { enabled: true, appEnv: "staging" } },
      {
        region_id: regionA,
        old_values: { enabled: null },
        new_values: { enabled: false, appEnv: "staging" },
      },
    ]);
  });

  it("ошибка после изменения — откат: ни переопределения, ни аудита", async () => {
    const flags = service("staging");
    await expect(
      withTenant(appDb, PLATFORM_CONTEXT, async (trx) => {
        await flags.set(trx, {
          key: "module.ambassadors",
          regionId: null,
          enabled: false,
          actor: { type: "system" },
        });
        throw new Error("сбой после изменения");
      }),
    ).rejects.toThrow("сбой после изменения");
    const { rows } = await owner.query(
      "SELECT (SELECT count(*) FROM feature_flags WHERE key = 'module.ambassadors') AS flags, " +
        "(SELECT count(*) FROM audit_logs WHERE entity_id = 'module.ambassadors') AS audits",
    );
    expect(rows[0]).toEqual({ flags: "0", audits: "0" });
  });

  it("prod: finance.live не включить без SUPERADMIN, отметок и второго фактора; отметки пишутся с аудитом", async () => {
    const flags = service("prod");
    const actor = { type: "user", userId: admin } as const;
    const err = await withTenant(appDb, PLATFORM_CONTEXT, (trx) =>
      flags.set(trx, { key: "finance.live", regionId: null, enabled: true, actor }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureFlagError);
    expect((err as FeatureFlagError).reason).toBe("finance_gate_role");
    await owner.query(
      "INSERT INTO role_assignments (user_id, role, scope_type) VALUES ($1, 'SUPERADMIN', 'PLATFORM')",
      [admin],
    );
    const open = await withTenant(appDb, PLATFORM_CONTEXT, (trx) =>
      flags.set(trx, { key: "finance.live", regionId: null, enabled: true, actor }),
    ).catch((e: unknown) => e);
    expect(open).toBeInstanceOf(FeatureFlagError);
    expect((open as FeatureFlagError).reason).toBe("finance_gate_open");
    for (const decision of ["D-09", "D-10", "D-13", "D-17", "D-20", "D-24"])
      await withTenant(appDb, PLATFORM_CONTEXT, (trx) =>
        flags.markGate(trx, { decision, documentRef: `заключение ${decision}`, actor }),
      );
    // Роль и все отметки есть, но второго фактора нет (D-52): гейт закрыт; учётка с методом totp — тоже (метод
    // ещё не поддержан).
    const noMfa = await withTenant(appDb, PLATFORM_CONTEXT, (trx) =>
      flags.set(trx, { key: "finance.live", regionId: null, enabled: true, actor }),
    ).catch((e: unknown) => e);
    expect((noMfa as FeatureFlagError).reason).toBe("finance_gate_mfa");
    await owner.query(
      "INSERT INTO admin_credentials (user_id, login, password_hash, mfa_method) VALUES ($1, 'ff-sa', 'scrypt$1024$8$1$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5a2V5a2V5', 'totp')",
      [admin],
    );
    const unsupported = await withTenant(appDb, PLATFORM_CONTEXT, (trx) =>
      flags.set(trx, { key: "finance.live", regionId: null, enabled: true, actor }),
    ).catch((e: unknown) => e);
    expect((unsupported as FeatureFlagError).reason).toBe("finance_gate_mfa");
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM feature_flags WHERE key = 'finance.live'",
    );
    expect(rows).toEqual([{ n: 0 }]);
    const marks = await owner.query(
      "SELECT count(*) AS n FROM audit_logs WHERE action = 'feature_flag.gate_mark'",
    );
    expect(marks.rows[0]).toEqual({ n: "6" });
  });
});
