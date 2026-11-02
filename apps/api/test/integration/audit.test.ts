// T1-13: журнал действий только на добавление и ПДн-часть аудита со сроком хранения — на реальной PostgreSQL под
// ролью приложения (логин-роль в группе app, как в окружениях; README apps/api, «Роли БД» и «Аудит»).
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { configureApp } from "../../src/bootstrap/configure-app.js";
import { TenancyModule } from "../../src/common/tenancy/index.js";
import {
  createDatabase,
  DatabaseModule,
  regionContext,
  PLATFORM_CONTEXT,
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
} from "../../src/db/index.js";
import {
  AuditLogRepository,
  AuditModule,
  AuditService,
  DEFAULT_AUDIT_PII_RETENTION_DAYS,
} from "../../src/modules/audit/index.js";
import { PRINCIPAL_SOURCE, RbacModule, RbacTenantContextSource } from "../../src/modules/rbac/index.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_audit_test";
const APP_PASSWORD = "tg_api_audit_test";
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error("Ожидалась ошибка PostgreSQL, запрос выполнился");
}

describe.skipIf(!dockerAvailable)(`Аудит: append-only и ПДн со сроком хранения (T1-13)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let owner: pg.Client;
  let appUrl: string;
  let appDb: Db;
  /** Прямой SQL под ролью приложения. */
  let raw: pg.Client;
  let regionA: string;
  let regionB: string;
  const service = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);

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

  /** То же в контексте SYSTEM (видны все строки). */
  const asSystem = <T>(fn: () => Promise<T>) => inTx({ actor: "system" }, fn);

  /** Текущие переменные контекста в транзакции raw. */
  const contextVars = async () =>
    (
      await raw.query<{ region: string | null; actor: string | null }>(
        "SELECT current_setting('app.region_id', true) AS region, current_setting('app.actor', true) AS actor",
      )
    ).rows[0]!;

  /** Запись аудита с ПДн в регионе через сервис (под ролью приложения). */
  const recordIn = (region: string, action = "test.action") =>
    withTenant(appDb, regionContext(region), (trx) =>
      service.record(trx, {
        actor: { type: "system" },
        action,
        entityType: "test",
        entityId: "e-1",
        newValues: { a: 1 },
        requestId: "req-1",
        pii: { ip: "203.0.113.7", userAgent: "UA", sessionId: "s-1" },
      }),
    );

  beforeAll(async () => {
    tdb = await startDatabase();
    owner = tdb.client; // superuser контейнера = роль миграций
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
    regionA = await region("t113-a");
    regionB = await region("t113-b");
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appUrl = url.toString();
    appDb = createDatabase({ connectionString: appUrl, maxConnections: 2 });
    raw = new pg.Client({ connectionString: appUrl });
    await raw.connect();
  });

  afterAll(async () => {
    await raw?.end();
    await appDb?.destroy();
    await stopDatabase(tdb);
  });

  it("миграция 0004 применена", () => {
    expect(tdb!.applied).toContain("0004_audit_append_only.sql");
  });

  describe("неизменяемость записи действия", () => {
    it("роль приложения: UPDATE, DELETE, TRUNCATE audit_logs отклоняются БД", async () => {
      const log = await recordIn(regionA);
      // Каждый запрос — в своей транзакции: после ошибки транзакция прервана.
      for (const q of [
        "UPDATE audit_logs SET action = 'подмена' WHERE id = $1",
        "DELETE FROM audit_logs WHERE id = $1",
        "TRUNCATE audit_logs CASCADE",
      ])
        await asSystem(async () => {
          const params = q.includes("$1") ? [log.id] : [];
          expect((await pgError(raw.query(q, params))).code, q).toBe(INSUFFICIENT_PRIVILEGE);
        });
      // Через Kysely (как код приложения) — то же.
      const e = await pgError(
        withTenant(appDb, SYSTEM_CONTEXT, (trx) =>
          trx.deleteFrom("audit_logs").where("id", "=", log.id).execute(),
        ),
      );
      expect(e.code).toBe(INSUFFICIENT_PRIVILEGE);
      const { rows } = await owner.query("SELECT action FROM audit_logs WHERE id = $1", [log.id]);
      expect(rows).toEqual([{ action: "test.action" }]);
    });

    it("владелец схемы: триггер отклоняет UPDATE/DELETE/TRUNCATE, даже без подходящих строк", async () => {
      const log = await recordIn(regionA);
      for (const [q, params] of [
        ["UPDATE audit_logs SET reason = 'x' WHERE id = $1", [log.id]],
        ["DELETE FROM audit_logs WHERE id = $1", [log.id]],
        ["DELETE FROM audit_logs WHERE false", []],
        ["TRUNCATE audit_logs CASCADE", []],
      ] as const) {
        const e = await pgError(owner.query(q, [...params]));
        expect(e.code, q).toBe(INSUFFICIENT_PRIVILEGE);
        expect(e.message, q).toMatch(/только на добавление/);
      }
      const { rows } = await owner.query("SELECT action, reason FROM audit_logs WHERE id = $1", [log.id]);
      expect(rows).toEqual([{ action: "test.action", reason: null }]);
    });

    it("ПДн-строку роль приложения не меняет (UPDATE нет), region_id ПДн = region_id записи", async () => {
      const log = await recordIn(regionA);
      await asSystem(async () => {
        const e = await pgError(
          raw.query("UPDATE audit_log_pii SET ip = '10.0.0.1' WHERE audit_log_id = $1", [log.id]),
        );
        expect(e.code).toBe(INSUFFICIENT_PRIVILEGE);
      });
      const logB = await recordIn(regionB);
      const mismatch = await pgError(
        owner.query(
          "INSERT INTO audit_log_pii (audit_log_id, region_id, ip, expires_at) VALUES ($1, $2, '10.0.0.1', now())",
          [logB.id, regionA],
        ),
      );
      expect(mismatch.code).toBe(CHECK_VIOLATION);
    });
  });

  describe("запись в транзакции бизнес-изменения", () => {
    it("commit: запись действия и ПДн-часть в регионе контекста, срок ПДн ≈ 90 дней", async () => {
      const log = await recordIn(regionA, "test.commit");
      expect(log).toMatchObject({ region_id: regionA, action: "test.commit", request_id: "req-1" });
      const { rows } = await owner.query(
        `SELECT region_id, host(ip) AS ip, user_agent, session_id,
                round(extract(epoch FROM expires_at - created_at) / 86400) AS days
         FROM audit_log_pii WHERE audit_log_id = $1`,
        [log.id],
      );
      expect(rows).toEqual([
        { region_id: regionA, ip: "203.0.113.7", user_agent: "UA", session_id: "s-1", days: "90" },
      ]);
    });

    it("откат бизнес-транзакции откатывает и запись аудита с ПДн", async () => {
      const marker = `test.rollback.${Date.now()}`;
      const failure = new Error("бизнес-ошибка");
      await expect(
        withTenant(appDb, regionContext(regionA), async (trx) => {
          const user = await trx
            .insertInto("users")
            .values({ language: "uk" })
            .returning("id")
            .executeTakeFirstOrThrow();
          await service.record(trx, {
            actor: { type: "user", userId: user.id },
            action: marker,
            entityType: "user",
            entityId: user.id,
            pii: { ip: "203.0.113.8" },
          });
          throw failure;
        }),
      ).rejects.toBe(failure);
      const logs = await owner.query("SELECT id FROM audit_logs WHERE action = $1", [marker]);
      expect(logs.rows).toEqual([]);
      const pii = await owner.query("SELECT 1 FROM audit_log_pii WHERE ip = '203.0.113.8'");
      expect(pii.rows).toEqual([]);
    });
  });

  describe("изоляция ПДн-части по регионам под ролью приложения", () => {
    it("RLS: регион A не видит ПДн региона B (Kysely и прямой SQL)", async () => {
      const logB = await recordIn(regionB, "test.pii.rls");
      const viaRepo = await withTenant(appDb, regionContext(regionA), (trx) =>
        new AuditLogRepository(trx).findPii(logB.id),
      );
      expect(viaRepo).toBeUndefined();
      await inTx({ region: regionA }, async () => {
        const { rows } = await raw.query(
          "SELECT count(*)::int AS n FROM audit_log_pii WHERE audit_log_id = $1",
          [logB.id],
        );
        expect(rows[0].n).toBe(0);
      });
      const own = await withTenant(appDb, regionContext(regionB), (trx) =>
        new AuditLogRepository(trx).findPii(logB.id),
      );
      expect(own).toMatchObject({ audit_log_id: logB.id, region_id: regionB });
    });

    it("триггер согласования региона под ролью приложения", async () => {
      // Записи действия без ПДн: ПДн-строку к ним вставляем вручную.
      const bare = (region: string) =>
        withTenant(appDb, regionContext(region), (trx) =>
          service.record(trx, { actor: { type: "system" }, action: "test.pii.bare", entityType: "test" }),
        );
      const logA = await bare(regionA);
      const logB = await bare(regionB);
      const insert = (logId: string, region: string | null) =>
        raw.query(
          "INSERT INTO audit_log_pii (audit_log_id, region_id, ip, expires_at) VALUES ($1, $2, '10.0.0.1', now() + interval '1 day')",
          [logId, region],
        );
      // Контекст A: запись действия региона B не видна (RLS) — как будто её нет.
      await inTx({ region: regionA }, async () => {
        expect((await pgError(insert(logB.id, regionA))).code).toBe(FK_VIOLATION);
      });
      // SYSTEM: запись видна, но регион ПДн другой или NULL — ошибка.
      for (const region of [regionB, null])
        await inTx({ actor: "system" }, async () => {
          expect((await pgError(insert(logA.id, region))).code, String(region)).toBe(CHECK_VIOLATION);
        });
      // Совпадающий регион — вставка проходит.
      await inTx({ region: regionA }, async () => {
        expect((await insert(logA.id, regionA)).rowCount).toBe(1);
      });
    });

    it("SYSTEM и PLATFORM: запись действия и ПДн с region_id NULL", async () => {
      for (const ctx of [SYSTEM_CONTEXT, PLATFORM_CONTEXT]) {
        const log = await withTenant(appDb, ctx, (trx) =>
          service.record(trx, {
            actor: { type: "system" },
            action: `test.pii.${ctx.kind}`,
            entityType: "test",
            pii: { ip: "198.51.100.1" },
          }),
        );
        expect(log.region_id, ctx.kind).toBeNull();
        const { rows } = await owner.query(
          "SELECT region_id, host(ip) AS ip FROM audit_log_pii WHERE audit_log_id = $1",
          [log.id],
        );
        expect(rows, ctx.kind).toEqual([{ region_id: null, ip: "198.51.100.1" }]);
      }
    });
  });

  describe("очистка ПДн по сроку (функция задачи воркера audit.purge-expired-pii)", () => {
    it("истёкшая ПДн удаляется, запись действия остаётся читаемой и целой; неистёкшая ПДн остаётся", async () => {
      const expired = await recordIn(regionA, "test.purge.expired");
      const fresh = await recordIn(regionB, "test.purge.fresh");
      // Срок истёк: сдвигаем expires_at в прошлое (под владельцем — у приложения UPDATE нет).
      await owner.query(
        "UPDATE audit_log_pii SET expires_at = now() - interval '1 day' WHERE audit_log_id = $1",
        [expired.id],
      );
      const before = await owner.query("SELECT * FROM audit_logs WHERE id = $1", [expired.id]);

      // Вызов как у воркера: роль приложения, без tenant-контекста; контекст после вызова не остаётся.
      await raw.query("BEGIN");
      const { rows } = await raw.query<{ deleted: number }>("SELECT audit_purge_expired_pii() AS deleted");
      const actor = await raw.query<{ actor: string | null }>(
        "SELECT current_setting('app.actor', true) AS actor",
      );
      await raw.query("COMMIT");
      expect(rows[0]!.deleted).toBeGreaterThanOrEqual(1);
      expect(actor.rows[0]!.actor ?? "").toBe("");

      const pii = await owner.query("SELECT audit_log_id FROM audit_log_pii WHERE audit_log_id = ANY($1)", [
        [expired.id, fresh.id],
      ]);
      expect(pii.rows).toEqual([{ audit_log_id: fresh.id }]);
      const after = await owner.query("SELECT * FROM audit_logs WHERE id = $1", [expired.id]);
      expect(after.rows).toEqual(before.rows);
      // Читаема под ролью приложения в своём регионе.
      const read = await withTenant(appDb, regionContext(regionA), (trx) =>
        new AuditLogRepository(trx).findById(expired.id),
      );
      expect(read).toMatchObject({ id: expired.id, action: "test.purge.expired", new_values: { a: 1 } });
      // Повторный вызов ничего не удаляет (идемпотентно).
      const again = await raw.query<{ deleted: number }>("SELECT audit_purge_expired_pii() AS deleted");
      expect(again.rows[0]!.deleted).toBe(0);
    });

    it("вызов внутри транзакции с контекстом PLATFORM или региона не меняет переменные контекста", async () => {
      for (const vars of [{ actor: "platform" }, { region: regionA }])
        await inTx(vars, async () => {
          const before = await contextVars();
          await raw.query("SELECT audit_purge_expired_pii()");
          expect(await contextVars(), JSON.stringify(vars)).toEqual(before);
          expect(before).toEqual({ region: vars.region ?? "", actor: vars.actor ?? "" });
        });
    });

    it("max_rows ограничивает пачку; max_rows < 1 — ошибка", async () => {
      for (let i = 0; i < 3; i++) await recordIn(regionA, "test.purge.batch");
      await owner.query("UPDATE audit_log_pii SET expires_at = now() - interval '1 day'");
      const first = await raw.query<{ deleted: number }>("SELECT audit_purge_expired_pii(2) AS deleted");
      expect(first.rows[0]!.deleted).toBe(2);
      expect((await pgError(raw.query("SELECT audit_purge_expired_pii(0)"))).code).toBe("22023");
      const rest = await raw.query<{ deleted: number }>("SELECT audit_purge_expired_pii() AS deleted");
      expect(rest.rows[0]!.deleted).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /admin/audit-logs (аудитор региона A по назначению роли, T1-12)", () => {
    let app: INestApplication;

    beforeAll(async () => {
      // Пользователь с назначением TECH_AUDITOR на регион A: tenant-контекст и право — из role_assignments.
      const user = String((await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0]!.id);
      await owner.query(
        `INSERT INTO role_assignments (user_id, role, scope_type, scope_id, region_id)
         VALUES ($1, 'TECH_AUDITOR', 'REGION', $2, $2)`,
        [user, regionA],
      );
      const moduleRef = await Test.createTestingModule({
        imports: [
          DatabaseModule.forRoot({ connectionString: appUrl }),
          TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
          AuditModule,
        ],
      })
        .overrideProvider(PRINCIPAL_SOURCE)
        .useValue({ resolve: () => ({ userId: user }) })
        .compile();
      app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "prod" });
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    it("регион-админ A: только записи A, без ПДн; курсор ведёт на следующую страницу без повторов", async () => {
      await recordIn(regionB, "test.api");
      for (let i = 0; i < 3; i++) await recordIn(regionA, "test.api");
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await request(app.getHttpServer())
          .get("/admin/audit-logs")
          .query({ entityType: "test", limit: 2, ...(cursor ? { cursor } : {}) })
          .expect(200);
        const body = res.body as { items: Record<string, unknown>[]; nextCursor: string | null };
        for (const item of body.items) {
          expect(item.regionId).toBe(regionA);
          expect(Object.keys(item)).not.toEqual(expect.arrayContaining(["ip"]));
          expect(JSON.stringify(item)).not.toContain("203.0.113.7");
          seen.push(item.id as string);
        }
        cursor = body.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual([...seen].sort().reverse());
      const { rows } = await owner.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE region_id = $1 AND entity_type = 'test'",
        [regionA],
      );
      expect(seen).toHaveLength(rows[0].n);
    });
  });
});
