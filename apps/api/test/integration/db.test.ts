// T1-08: миграции, соглашения схемы и PostGIS на реальной PostgreSQL 17 + PostGIS 3.5.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, distanceMeters, point, withinMeters, type Db } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

describe.skipIf(!dockerAvailable)(`БД: миграции, соглашения, PostGIS${title}`, () => {
  let tdb: TestDatabase | undefined;
  let db: Db | undefined;

  beforeAll(async () => {
    tdb = await startDatabase();
    // Пул из одного соединения: проверка, что SET LOCAL не протекает в следующий запрос.
    db = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 1 });
  });

  afterAll(async () => {
    await db?.destroy();
    await stopDatabase(tdb);
  });

  describe("миграции", () => {
    it("на чистую БД применяются все файлы, с контрольными суммами", async () => {
      expect(tdb!.applied[0]).toBe("0001_init.sql");
      const { rows } = await tdb!.client.query("SELECT name, checksum FROM schema_migrations ORDER BY name");
      expect(rows.map((r) => r.name)).toEqual(tdb!.applied);
      for (const r of rows) expect(String(r.checksum)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("повторный запуск — no-op", async () => {
      const before = await tdb!.client.query("SELECT name, applied_at FROM schema_migrations ORDER BY name");
      expect(await runMigrations(tdb!.client)).toEqual([]);
      const after = await tdb!.client.query("SELECT name, applied_at FROM schema_migrations ORDER BY name");
      expect(after.rows).toEqual(before.rows);
    });

    it("расширение postgis установлено", async () => {
      const { rows } = await tdb!.client.query(
        "SELECT extversion FROM pg_extension WHERE extname = 'postgis'",
      );
      expect(String(rows[0]?.extversion)).toMatch(/^3\.5/);
    });
  });

  describe("соглашения схемы", () => {
    beforeAll(async () => {
      // Тестовая tenant-таблица по соглашениям ADR-006 (только в тесте; бизнес-таблицы — T1-09).
      await tdb!.client.query(`
        CREATE TABLE t108_probe (
          id uuid PRIMARY KEY DEFAULT uuidv7(),
          region_id uuid NOT NULL,
          location geometry(Point, 4326) NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TRIGGER t108_probe_set_updated_at BEFORE UPDATE ON t108_probe
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        CREATE INDEX t108_probe_location_geog ON t108_probe USING gist ((location::geography));
      `);
    });

    it("uuidv7(): версия 7, вариант RFC 9562, растёт по времени", async () => {
      const next = async () => String((await tdb!.client.query("SELECT uuidv7()::text AS u")).rows[0]?.u);
      const a = await next();
      await tdb!.client.query("SELECT pg_sleep(0.005)");
      const b = await next();
      for (const u of [a, b])
        expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(a < b).toBe(true);
      // Первые 48 бит — миллисекунды Unix-времени, близкие к текущему.
      const ms = Number.parseInt(a.replace(/-/g, "").slice(0, 12), 16);
      expect(Math.abs(ms - Date.now())).toBeLessThan(60_000);
    });

    it("updated_at ставит триггер при UPDATE, created_at не меняется", async () => {
      const ins = await tdb!.client.query(
        `INSERT INTO t108_probe (region_id, location)
         VALUES (gen_random_uuid(), ST_SetSRID(ST_MakePoint(30.5, 50.4), 4326))
         RETURNING id, created_at, updated_at`,
      );
      const row = ins.rows[0]!;
      // Новая транзакция: now() у UPDATE позже, чем у INSERT.
      await tdb!.client.query("SELECT pg_sleep(0.01)");
      const upd = await tdb!.client.query(
        "UPDATE t108_probe SET location = ST_SetSRID(ST_MakePoint(30.6, 50.4), 4326) WHERE id = $1 RETURNING created_at, updated_at",
        [row.id],
      );
      const after = upd.rows[0]!;
      expect(after.created_at).toEqual(row.created_at);
      expect((after.updated_at as Date).getTime()).toBeGreaterThan((row.updated_at as Date).getTime());
    });
  });

  describe("PostGIS через Kysely", () => {
    it("distanceMeters: 1° долготы на экваторе = 111 319,49 м (сфероид WGS 84)", async () => {
      const r = await db!
        .selectNoFrom(distanceMeters(point({ lon: 0, lat: 0 }), point({ lon: 1, lat: 0 })).as("m"))
        .executeTakeFirstOrThrow();
      expect(r.m).toBeCloseTo(111_319.49, 0);
    });

    it("distanceMeters: 1° широты от экватора = 110 574,39 м", async () => {
      const r = await db!
        .selectNoFrom(distanceMeters(point({ lon: 0, lat: 0 }), point({ lon: 0, lat: 1 })).as("m"))
        .executeTakeFirstOrThrow();
      expect(r.m).toBeCloseTo(110_574.39, 0);
    });

    it("distanceMeters: Киев — Львов ≈ 468 км", async () => {
      const r = await db!
        .selectNoFrom(
          distanceMeters(point({ lon: 30.5234, lat: 50.4501 }), point({ lon: 24.0297, lat: 49.8397 })).as(
            "m",
          ),
        )
        .executeTakeFirstOrThrow();
      expect(typeof r.m).toBe("number");
      expect(Math.abs(r.m - 468_000)).toBeLessThan(5_000);
    });

    it("withinMeters: граница радиуса", async () => {
      const a = point({ lon: 0, lat: 0 });
      const b = point({ lon: 1, lat: 0 });
      const r = await db!
        .selectNoFrom([withinMeters(a, b, 111_400).as("inside"), withinMeters(a, b, 111_200).as("outside")])
        .executeTakeFirstOrThrow();
      expect(r).toEqual({ inside: true, outside: false });
    });
  });

  describe("контекст региона для RLS (основа T1-11)", () => {
    it("set_config(…, true) виден внутри транзакции и сбрасывается после неё на том же соединении", async () => {
      const regionId = "0190f5c2-7d3e-7000-8000-000000000001";
      const inside = await db!.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.region_id', ${regionId}, true)`.execute(trx);
        const r = await sql<{ v: string }>`SELECT current_setting('app.region_id', true) AS v`.execute(trx);
        return r.rows[0]?.v;
      });
      expect(inside).toBe(regionId);
      // Пул из одного соединения — этот запрос идёт по тому же соединению.
      const r = await sql<{ v: string | null }>`SELECT current_setting('app.region_id', true) AS v`.execute(
        db!,
      );
      expect(r.rows[0]?.v ?? "").toBe("");
    });
  });
});
