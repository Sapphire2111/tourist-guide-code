// Блок 2 (ADR-0016): QR-контекст на реальной PostgreSQL (миграция 0011) под ролью приложения — RLS по региону,
// CHECK формата кода и карточки «Про заклад», составные FK журнала, запись скана/контекста/касания сервисом,
// демо-QR seed. Без Docker — пропуск (проверяется в CI).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createDatabase, regionContext, SYSTEM_CONTEXT, withTenant, type Db } from "../../src/db/index.js";
import type { AnalyticsService } from "../../src/modules/analytics/index.js";
import { QrContextRepository, QrContextService } from "../../src/modules/qr-context/index.js";
import { seedBase, seedQrPoints, seedUserId, type SeedBaseResult } from "../../src/seed/seed.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_qr_test";
const APP_PASSWORD = "tg_api_qr_test";
const ANON = "0192f0c1-7a2b-7c3d-8e4f-0000000000f1";

describe.skipIf(!dockerAvailable)(`QR-контекст (блок 2, миграция 0011)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let base: SeedBaseResult;
  let qr: Awaited<ReturnType<typeof seedQrPoints>>;
  const emit = vi.fn(async () => {});

  beforeAll(async () => {
    tdb = await startDatabase();
    await tdb.client.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    qr = await seedQrPoints(ownerDb, base.regions);
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  const service = () =>
    new QrContextService(appDb, new QrContextRepository(appDb), { emit } as unknown as AnalyticsService);
  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);

  it("миграция: четыре таблицы с RLS (ENABLE + FORCE)", async () => {
    const { rows } = await sql(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('qr_points', 'qr_scan_events', 'entry_contexts', 'attribution_touches') ORDER BY relname`,
    );
    expect(rows).toEqual(
      ["attribution_touches", "entry_contexts", "qr_points", "qr_scan_events"].map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
  });

  it("seed идемпотентен: повторный запуск — те же id и столько же точек", async () => {
    const again = await seedQrPoints(ownerDb, base.regions);
    expect(again).toEqual(qr);
    const { rows } = await sql("SELECT count(*)::int AS n FROM qr_points");
    expect(rows[0].n).toBe(Object.keys(qr).length);
  });

  it("CHECK: код не по формату, одни цифры, карточка у не-отеля, кампания без метки — отказ", async () => {
    const insert = (values: Record<string, unknown>) => {
      const row = { region_id: base.regions.a, type: "region", label: "x", ...values };
      const cols = Object.keys(row);
      return sql(
        `INSERT INTO qr_points (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(row).map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v)),
      );
    };
    await expect(insert({ code: "short" })).rejects.toThrow(/qr_points_code_format/);
    await expect(insert({ code: "380501234567" })).rejects.toThrow(/qr_points_code_format/);
    await expect(insert({ code: "has space 123" })).rejects.toThrow(/qr_points_code_format/);
    await expect(insert({ code: "regionVenue1", venue_name_i18n: { uk: "X" } })).rejects.toThrow(
      /qr_points_venue_hotel_only/,
    );
    await expect(insert({ code: "campaignNo01", type: "campaign" })).rejects.toThrow(
      /qr_points_campaign_required/,
    );
    await expect(insert({ code: "demoHotel01" })).rejects.toThrow(/qr_points_code_key/);
    await expect(
      sql(
        `INSERT INTO qr_scan_events (result, anonymous_id, raw_start_param) VALUES ('invalid', $1, '380501234567')`,
        [ANON],
      ),
    ).rejects.toThrow(/qr_scan_events_raw_format/);
    await expect(sql(`INSERT INTO qr_scan_events (result) VALUES ('invalid')`)).rejects.toThrow(
      /qr_scan_events_actor/,
    );
  });

  it("составной FK: скан точки региона A с region_id региона B — отказ", async () => {
    await expect(
      sql(
        `INSERT INTO qr_scan_events (region_id, qr_point_id, result, anonymous_id) VALUES ($1, $2, 'ok', $3)`,
        [base.regions.b, qr.hotel, ANON],
      ),
    ).rejects.toThrow(/qr_scan_events_point_fk/);
  });

  it("RLS под ролью app: регион видит только свои точки, без контекста — пусто", async () => {
    const codesIn = (regionId: string) =>
      withTenant(appDb, regionContext(regionId), (trx) =>
        trx.selectFrom("qr_points").select("code").orderBy("code").execute(),
      );
    expect((await codesIn(base.regions.b)).map((r) => r.code)).toEqual(["demoHotelB01"]);
    expect((await codesIn(base.regions.a)).map((r) => r.code)).not.toContain("demoHotelB01");
    // Прямой SQL под ролью app без контекста — RLS не пропускает ни одной строки.
    const url = new URL(tdb!.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    const raw = new pg.Client({ connectionString: url.toString() });
    await raw.connect();
    try {
      expect((await raw.query("SELECT count(*)::int AS n FROM qr_points")).rows[0].n).toBe(0);
    } finally {
      await raw.end();
    }
  });

  it("активный QR отеля: «Про заклад», запись скана, контекста и касания в регионе точки", async () => {
    const res = await service().resolve({ startParam: "demoHotel01", anonymousId: ANON });
    expect(res).toMatchObject({
      status: "ok",
      entryType: "hotel",
      region: { id: base.regions.a, code: "test-region" },
      point: { id: qr.hotel, type: "hotel" },
      venue: { name: { uk: "Тестовий готель" }, phone: "+380000000001" },
      anonymousId: ANON,
    });
    const { rows: scans } = await sql("SELECT * FROM qr_scan_events WHERE qr_point_id = $1", [qr.hotel]);
    expect(scans).toEqual([
      expect.objectContaining({ region_id: base.regions.a, result: "ok", raw_start_param: "demoHotel01" }),
    ]);
    const { rows: entries } = await sql("SELECT * FROM entry_contexts WHERE id = $1", [res.entryContextId]);
    expect(entries).toEqual([
      expect.objectContaining({ region_id: base.regions.a, qr_point_id: qr.hotel, entry_type: "hotel" }),
    ]);
    const { rows: touches } = await sql("SELECT * FROM attribution_touches WHERE entry_context_id = $1", [
      res.entryContextId,
    ]);
    expect(touches).toEqual([
      expect.objectContaining({ source: "qr", qr_point_id: qr.hotel, anonymous_id: ANON }),
    ]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ event: "qr_scanned", props: { qrPointId: qr.hotel, result: "ok" } }),
    );
    // Журнал региона A не виден контексту региона B.
    const seenByB = await withTenant(appDb, regionContext(base.regions.b), (trx) =>
      trx.selectFrom("qr_scan_events").select("id").where("qr_point_id", "=", qr.hotel).execute(),
    );
    expect(seenByB).toEqual([]);
  });

  it("с пользователем сессии — user_id во всех записях", async () => {
    const userId = seedUserId("admin-a");
    const res = await service().resolve({ startParam: "demoCampaign1", userId });
    const { rows } = await sql(
      "SELECT user_id, campaign FROM attribution_touches WHERE entry_context_id = $1",
      [res.entryContextId],
    );
    expect(rows).toEqual([{ user_id: userId, campaign: "summer-2026" }]);
  });

  it("деактивированный, неизвестный и мусорный параметр — нейтральный контекст и запись скана", async () => {
    const inactive = await service().resolve({ startParam: "demoHotelOff1" });
    expect(inactive).toMatchObject({ status: "inactive", entryType: "default", point: null, venue: null });
    const unknown = await service().resolve({ startParam: "unknownCode42" });
    expect(unknown).toMatchObject({ status: "not_found", region: { code: "test-region" } });
    const garbage = await service().resolve({ startParam: "+380501234567" });
    expect(garbage.status).toBe("invalid");
    const { rows } = await sql(
      `SELECT result, raw_start_param, qr_point_id FROM qr_scan_events
       WHERE anonymous_id = ANY($1::uuid[]) ORDER BY scanned_at, id`,
      [[inactive.anonymousId, unknown.anonymousId, garbage.anonymousId]],
    );
    expect(rows).toEqual([
      { result: "inactive", raw_start_param: "demoHotelOff1", qr_point_id: qr["hotel-inactive"] },
      { result: "not_found", raw_start_param: "unknownCode42", qr_point_id: null },
      { result: "invalid", raw_start_param: null, qr_point_id: null },
    ]);
    const { rows: entries } = await sql(
      "SELECT entry_type, qr_point_id FROM entry_contexts WHERE id = ANY($1::uuid[])",
      [[inactive.entryContextId, unknown.entryContextId, garbage.entryContextId]],
    );
    expect(entries).toHaveLength(3);
    for (const e of entries) expect(e).toEqual({ entry_type: "default", qr_point_id: null });
  });

  it("журналы под ролью app: без DELETE и UPDATE, кроме обнуления user_id/anonymous_id (D-48)", async () => {
    const url = new URL(tdb!.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    const raw = new pg.Client({ connectionString: url.toString() });
    await raw.connect();
    try {
      await raw.query("SELECT set_config('app.actor', 'system', false)");
      for (const table of ["qr_scan_events", "attribution_touches"]) {
        await expect(raw.query(`DELETE FROM ${table}`), table).rejects.toThrow(/permission denied/);
        await expect(raw.query(`TRUNCATE ${table}`), table).rejects.toThrow(/permission denied/);
        await expect(raw.query(`UPDATE ${table} SET region_id = NULL`), table).rejects.toThrow(
          /permission denied/,
        );
        await raw.query(
          `UPDATE ${table} SET anonymous_id = NULL WHERE anonymous_id = $1 AND user_id IS NOT NULL`,
          ["0192f0c1-7a2b-7c3d-8e4f-0000000000ff"],
        );
      }
    } finally {
      await raw.end();
    }
  });

  it("удаление точки обнуляет ссылку в журналах (SET NULL), регион остаётся", async () => {
    const id = await withTenant(
      ownerDb,
      SYSTEM_CONTEXT,
      async (trx) =>
        (
          await trx
            .insertInto("qr_points")
            .values({ region_id: base.regions.a, code: "toDelete0001", type: "region", label: "temp" })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id,
    );
    const res = await service().resolve({ startParam: "toDelete0001" });
    await sql("DELETE FROM qr_points WHERE id = $1", [id]);
    const { rows } = await sql(
      "SELECT region_id, qr_point_id FROM attribution_touches WHERE entry_context_id = $1",
      [res.entryContextId],
    );
    expect(rows).toEqual([{ region_id: base.regions.a, qr_point_id: null }]);
  });
});
