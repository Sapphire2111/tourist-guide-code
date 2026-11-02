// T1-10/T1-11: изоляция регионов на реальной PostgreSQL 17 + PostGIS 3.5 под ролью приложения.
// Первый рубеж — TenantGuardPlugin (фильтр region_id), второй — RLS (миграция 0003). Логин-роль приложения
// заводится здесь так же, как в окружениях (README apps/api, «Роли БД»): LOGIN-роль в группе app.
// tenant-таблицы с region_id NOT NULL в боевой схеме ещё нет — тестовая t111_places создаётся только здесь,
// тем же app_enable_tenant_rls(), что будут вызывать миграции бизнес-таблиц.
import { Controller, Get, Inject, NotFoundException, Param, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { sql } from "kysely";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TenancyModule, TENANT_CONTEXT_SOURCE } from "../../src/common/tenancy/index.js";
import {
  createDatabase,
  readDbRoleStatus,
  DatabaseModule,
  PLATFORM_CONTEXT,
  regionContext,
  SYSTEM_CONTEXT,
  TABLE_TENANCY,
  TenantContextError,
  withTenant,
  type Db,
  type TenantContext,
} from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { AuditLogRepository, AuditModule } from "../../src/modules/audit/index.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_test";
const APP_PASSWORD = "tg_api_test";
const INSUFFICIENT_PRIVILEGE = "42501"; // и «permission denied», и «new row violates row-level security policy»

const TENANCY = { ...TABLE_TENANCY, t111_places: "tenant" } as const;
type Places = { t111_places: { id: string; region_id: string; name: string } };

/** Строка подключения к тому же контейнеру под другой ролью/базой. */
function urlWith(
  base: string,
  { user, password, database }: { user?: string; password?: string; database?: string },
) {
  const url = new URL(base);
  if (user) url.username = user;
  if (password) url.password = password;
  if (database) url.pathname = `/${database}`;
  return url.toString();
}

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error("Ожидалась ошибка PostgreSQL, запрос выполнился");
}

@Controller("t110/audit-logs")
class ProbeController {
  constructor(@Inject(AuditLogRepository) private readonly audit: AuditLogRepository) {}

  @Get()
  list() {
    return this.audit.listRecent();
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const row = await this.audit.findById(id);
    if (!row) throw new NotFoundException();
    return row;
  }
}

describe.skipIf(!dockerAvailable)(`Изоляция регионов: серверный фильтр и RLS (T1-10, T1-11)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let appUrl: string;
  /** Kysely под ролью приложения; одно соединение — проверка сброса контекста после транзакции. */
  let appDb: Db;
  /** Прямой SQL под ролью приложения, без Kysely и его плагина («забытый фильтр»). */
  let raw: pg.Client;
  const ids = {} as Record<
    "A" | "B" | "auditA" | "auditB" | "auditNull" | "eventA" | "eventB" | "eventNull" | "placeA" | "placeB",
    string
  >;
  let A: TenantContext;

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

  const regionsOf = async (table: string) =>
    (await raw.query(`SELECT id, region_id FROM ${table} ORDER BY id`)).rows as {
      id: string;
      region_id: string | null;
    }[];

  beforeAll(async () => {
    tdb = await startDatabase();
    const owner = tdb.client; // superuser контейнера = роль миграций (владелец схемы)
    await owner.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    await owner.query(`
      CREATE TABLE t111_places (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        region_id uuid NOT NULL REFERENCES regions(id),
        name text NOT NULL
      );
      SELECT app_enable_tenant_rls('t111_places');
    `);
    const one = async (q: string, params: unknown[]) => String((await owner.query(q, params)).rows[0]!.id);
    const region = (code: string) =>
      one(`INSERT INTO regions (code, name_i18n) VALUES ($1, '{"uk": "Регіон"}') RETURNING id`, [code]);
    const audit = (r: string | null) =>
      one(
        `INSERT INTO audit_logs (actor_type, region_id, action, entity_type) VALUES ('system', $1, 'test.seed', 'test') RETURNING id`,
        [r],
      );
    const event = (r: string | null) =>
      one(
        `INSERT INTO analytics_events (event_name, schema_version, occurred_at, region_id) VALUES ('app_opened', 1, now(), $1) RETURNING id`,
        [r],
      );
    ids.A = await region("t111-a");
    ids.B = await region("t111-b");
    ids.auditA = await audit(ids.A);
    ids.auditB = await audit(ids.B);
    ids.auditNull = await audit(null);
    ids.eventA = await event(ids.A);
    ids.eventB = await event(ids.B);
    ids.eventNull = await event(null);
    ids.placeA = await one(`INSERT INTO t111_places (region_id, name) VALUES ($1, 'a') RETURNING id`, [
      ids.A,
    ]);
    ids.placeB = await one(`INSERT INTO t111_places (region_id, name) VALUES ($1, 'b') RETURNING id`, [
      ids.B,
    ]);
    A = regionContext(ids.A);

    appUrl = urlWith(tdb.container.getConnectionUri(), { user: APP_LOGIN, password: APP_PASSWORD });
    appDb = createDatabase({ connectionString: appUrl, maxConnections: 1, tenancy: TENANCY });
    raw = new pg.Client({ connectionString: appUrl });
    await raw.connect();
  });

  afterAll(async () => {
    await raw?.end();
    await appDb?.destroy();
    await stopDatabase(tdb);
  });

  describe("роли и схема (T1-11)", () => {
    it("проверка при старте: логин-роль приложения RLS не обходит, суперпользователь — обходит", async () => {
      expect(await readDbRoleStatus(appDb)).toEqual({ role: APP_LOGIN, bypassesRls: false });
      const ownerDb = createDatabase({
        connectionString: tdb!.container.getConnectionUri(),
        maxConnections: 1,
      });
      try {
        expect((await readDbRoleStatus(ownerDb)).bypassesRls).toBe(true);
      } finally {
        await ownerDb.destroy();
      }
    });

    it("app — NOLOGIN, не superuser, без BYPASSRLS; логин-роль приложения ничем не владеет", async () => {
      const { rows } = await tdb!.client.query(
        `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
        [["app", APP_LOGIN]],
      );
      expect(rows).toEqual([
        { rolname: "app", rolcanlogin: false, rolsuper: false, rolbypassrls: false },
        { rolname: APP_LOGIN, rolcanlogin: true, rolsuper: false, rolbypassrls: false },
      ]);
      const owned = await tdb!.client.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) IN ('app', $1)`,
        [APP_LOGIN],
      );
      expect(owned.rows).toEqual([]);
    });

    it("каждая таблица public классифицирована; на tenant-таблицах RLS и FORCE, на глобальных — нет", async () => {
      const { rows } = await tdb!.client.query<{ relname: string; rls: boolean; force: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
           AND c.relname NOT IN ('schema_migrations', 't111_places')
           -- таблицы расширений (spatial_ref_sys PostGIS) — не наши
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
         ORDER BY c.relname`,
      );
      expect(rows.map((r) => r.relname)).toEqual(Object.keys(TABLE_TENANCY).sort());
      for (const r of rows) {
        const tenant = TABLE_TENANCY[r.relname as keyof typeof TABLE_TENANCY] !== "global";
        expect({ table: r.relname, rls: r.rls, force: r.force }).toEqual({
          table: r.relname,
          rls: tenant,
          force: tenant,
        });
      }
    });

    it("роль приложения: DML есть, DDL и служебных таблиц нет", async () => {
      for (const ddl of [
        "CREATE TABLE t111_ddl (id int)",
        "ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY",
        "DROP POLICY tenant_region ON audit_logs",
        "DROP TABLE t111_places",
        "TRUNCATE audit_logs",
        "SELECT * FROM schema_migrations",
        "SELECT app_enable_tenant_rls('regions')",
      ])
        expect((await pgError(raw.query(ddl))).code, ddl).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await raw.query("SELECT count(*)::int AS n FROM regions")).rows[0].n).toBeGreaterThanOrEqual(2);
    });

    it("повторная миграция в другой базе кластера, где роль app уже есть, не падает", async () => {
      await tdb!.client.query("CREATE DATABASE t111_second");
      const second = new pg.Client({
        connectionString: urlWith(tdb!.container.getConnectionUri(), { database: "t111_second" }),
      });
      await second.connect();
      try {
        expect(await runMigrations(second)).toContain("0003_tenant_rls.sql");
        const { rows } = await second.query(
          "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'audit_logs'",
        );
        expect(rows[0]?.relforcerowsecurity).toBe(true);
      } finally {
        await second.end();
      }
    });
  });

  describe("RLS: прямой SQL под ролью приложения (T1-11)", () => {
    it("контекст региона A: строк региона B и строк без региона нет ни в одной tenant-таблице", async () => {
      await inTx({ region: ids.A }, async () => {
        for (const table of ["audit_logs", "analytics_events", "t111_places"]) {
          const rows = await regionsOf(table);
          expect(rows.length, table).toBeGreaterThan(0);
          expect(new Set(rows.map((r) => r.region_id)), table).toEqual(new Set([ids.A]));
        }
      });
    });

    it("«забытый фильтр»: запрос по id строки B в обход серверного фильтра — 0 строк", async () => {
      await inTx({ region: ids.A }, async () => {
        for (const [table, id] of [
          ["audit_logs", ids.auditB],
          ["audit_logs", ids.auditNull],
          ["analytics_events", ids.eventB],
          ["t111_places", ids.placeB],
        ] as const)
          expect(
            (await raw.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows,
            `${table} ${id}`,
          ).toEqual([]);
      });
      // То же через Kysely без плагина внутри withTenant: фильтр «забыт», RLS всё равно режет.
      const rows = await withTenant(appDb, A, (trx) =>
        trx.withoutPlugins().selectFrom("audit_logs").select("region_id").execute(),
      );
      expect(new Set(rows.map((r) => r.region_id))).toEqual(new Set([ids.A]));
    });

    it("без контекста: чтение пусто, запись — ошибка", async () => {
      for (const table of ["audit_logs", "analytics_events", "t111_places"])
        expect((await raw.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
      const e = await pgError(
        raw.query(
          `INSERT INTO audit_logs (actor_type, region_id, action, entity_type) VALUES ('system', $1, 'x', 'test')`,
          [ids.A],
        ),
      );
      expect(e.code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("запись в контексте A: в регион B и с NULL — ошибка; строки B не меняются и не удаляются", async () => {
      const insert = (region: string | null) =>
        inTx({ region: ids.A }, () =>
          raw.query(
            `INSERT INTO audit_logs (actor_type, region_id, action, entity_type) VALUES ('system', $1, 'x', 'test')`,
            [region],
          ),
        );
      expect((await pgError(insert(ids.B))).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((await pgError(insert(null))).code).toBe(INSUFFICIENT_PRIVILEGE);
      await inTx({ region: ids.A }, async () => {
        expect(
          (await raw.query("UPDATE t111_places SET name = 'x' WHERE id = $1", [ids.placeB])).rowCount,
        ).toBe(0);
        expect((await raw.query("DELETE FROM t111_places WHERE id = $1", [ids.placeB])).rowCount).toBe(0);
        // Перенос своей строки в другой регион — WITH CHECK.
        const e = await pgError(
          raw.query("UPDATE t111_places SET region_id = $1 WHERE id = $2", [ids.B, ids.placeA]),
        );
        expect(e.code).toBe(INSUFFICIENT_PRIVILEGE);
      });
    });

    it("SYSTEM и PLATFORM видят все регионы и строки без региона", async () => {
      for (const actor of ["system", "platform"])
        await inTx({ actor }, async () => {
          const audit = (await regionsOf("audit_logs")).map((r) => r.id);
          expect(audit, actor).toEqual(expect.arrayContaining([ids.auditA, ids.auditB, ids.auditNull]));
          const places = (await regionsOf("t111_places")).map((r) => r.id);
          expect(places, actor).toEqual(expect.arrayContaining([ids.placeA, ids.placeB]));
        });
      const rows = await withTenant(appDb, SYSTEM_CONTEXT, (trx) =>
        trx.selectFrom("analytics_events").select("id").execute(),
      );
      expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([ids.eventA, ids.eventB, ids.eventNull]));
    });

    it("неизвестный app.actor не даёт кросс-tenant доступа", async () => {
      await inTx({ actor: "superadmin" }, async () => {
        expect((await raw.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n).toBe(0);
      });
    });
  });

  describe("серверный фильтр + withTenant под ролью приложения (T1-10)", () => {
    it("Kysely в контексте A: только строки A; контекст сбрасывается после транзакции", async () => {
      const rows = await withTenant(appDb, A, (trx) =>
        trx.withTables<Places>().selectFrom("t111_places").select(["id", "region_id"]).execute(),
      );
      expect(rows).toEqual([{ id: ids.placeA, region_id: ids.A }]);
      // Пул из одного соединения: то же соединение без контекста — RLS ничего не отдаёт, плагин — ошибка.
      const after = await sql<{ n: number }>`SELECT count(*)::int AS n FROM t111_places`.execute(
        appDb.withoutPlugins(),
      );
      expect(after.rows[0]?.n).toBe(0);
      await expect(appDb.selectFrom("audit_logs").selectAll().execute()).rejects.toBeInstanceOf(
        TenantContextError,
      );
    });

    it("INSERT в контексте A подставляет region_id = A", async () => {
      const row = await withTenant(appDb, A, (trx) =>
        trx
          .insertInto("audit_logs")
          .values({ actor_type: "system", action: "t110.insert", entity_type: "test" })
          .returning(["id", "region_id"])
          .executeTakeFirstOrThrow(),
      );
      expect(row.region_id).toBe(ids.A);
    });

    it("фильтр работает и без RLS: роль-владелец (RLS не действует) в контексте A не видит строк B", async () => {
      const ownerDb = createDatabase({
        connectionString: tdb!.container.getConnectionUri(),
        maxConnections: 1,
        tenancy: TENANCY,
      });
      try {
        const rows = await withTenant(ownerDb, A, (trx) =>
          trx
            .selectFrom("audit_logs")
            .select("region_id")
            .where("id", "in", [ids.auditB, ids.auditNull, ids.auditA])
            .execute(),
        );
        expect(rows).toEqual([{ region_id: ids.A }]);
      } finally {
        await ownerDb.destroy();
      }
    });
  });

  describe("API: регион-админ A и объекты региона B (ТЗ §16.2)", () => {
    let app: INestApplication;
    let tenant: TenantContext | undefined;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DatabaseModule.forRoot({ connectionString: appUrl }), TenancyModule, AuditModule],
        controllers: [ProbeController],
      })
        .overrideProvider(TENANT_CONTEXT_SOURCE)
        .useValue({ resolve: () => tenant })
        .compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    it("объект региона B по id → 404, свой объект → 200", async () => {
      tenant = A;
      await request(app.getHttpServer()).get(`/t110/audit-logs/${ids.auditB}`).expect(404);
      await request(app.getHttpServer()).get(`/t110/audit-logs/${ids.auditNull}`).expect(404);
      const own = await request(app.getHttpServer()).get(`/t110/audit-logs/${ids.auditA}`).expect(200);
      expect(own.body).toMatchObject({ id: ids.auditA, region_id: ids.A });
    });

    it("список → 0 записей региона B и без региона", async () => {
      tenant = A;
      const res = await request(app.getHttpServer()).get("/t110/audit-logs").expect(200);
      const rows = res.body as { id: string; region_id: string | null }[];
      expect(rows.map((r) => r.id)).toContain(ids.auditA);
      expect(rows.filter((r) => r.region_id !== ids.A)).toEqual([]);
    });

    it("PLATFORM видит все регионы и записи без региона", async () => {
      tenant = PLATFORM_CONTEXT;
      const res = await request(app.getHttpServer()).get("/t110/audit-logs").expect(200);
      expect((res.body as { id: string }[]).map((r) => r.id)).toEqual(
        expect.arrayContaining([ids.auditA, ids.auditB, ids.auditNull]),
      );
    });
  });
});
