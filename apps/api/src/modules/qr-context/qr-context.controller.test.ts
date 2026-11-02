// Unit (без БД): GET /context/{start_param} — активный, неактивный, неизвестный, мусорный и ПДн-подобный параметр,
// привязка к сессии и anonymousId, событие qr_scanned. Репозиторий — в памяти, Kysely — recordingDb (только
// set_config транзакции SYSTEM). На реальной PostgreSQL (RLS, FK, CHECK) — test/integration/qr-context.test.ts.
import { Reflector } from "@nestjs/core";
import { APP_GUARD } from "@nestjs/core";
import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "@tg/server-config";
import type { AnalyticsEvent } from "@tg/shared";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import {
  DATABASE,
  DatabaseModule,
  type NewAttributionTouch,
  type NewEntryContext,
  type NewQrScanEvent,
} from "../../db/index.js";
import { AnalyticsModule, ANALYTICS_SINK } from "../analytics/index.js";
import type { RbacRequest } from "../rbac/index.js";
import { QrContextController, QR_CONTEXT_RATE_LIMIT } from "./qr-context.controller.js";
import { QrContextModule } from "./qr-context.module.js";
import { QrContextRepository, type ContextRegion, type ResolvedQrPoint } from "./qr-context.repository.js";

const REGION_A = "0192f0c1-7a2b-7c3d-8e4f-0000000000a1";
const REGION_DEFAULT = "0192f0c1-7a2b-7c3d-8e4f-0000000000d1";
const REGION_SUSPENDED = "0192f0c1-7a2b-7c3d-8e4f-0000000000c1";
const USER = "0192f0c1-7a2b-7c3d-8e4f-0000000000e1";
const ANON = "0192f0c1-7a2b-7c3d-8e4f-0000000000f1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const region = (id: string, code: string, status: ContextRegion["status"] = "active"): ContextRegion => ({
  id,
  code,
  name_i18n: { uk: `Регіон ${code}` },
  status,
  timezone: "Europe/Kyiv",
  default_language: "uk",
});

const point = (over: Partial<ResolvedQrPoint>): ResolvedQrPoint => ({
  id: "0192f0c1-7a2b-7c3d-8e4f-000000000101",
  region_id: REGION_A,
  code: "demoHotel01",
  type: "hotel",
  place_id: null,
  campaign: null,
  source: "sticker",
  active: true,
  label: "Ресепшн",
  venue_name_i18n: { uk: "Тестовий готель", en: "Test hotel" },
  venue_description_i18n: { uk: "Опис" },
  venue_address_i18n: { uk: "вул. Тестова, 1" },
  venue_phone: "+380000000001",
  venue_website: "https://hotel.example",
  venue_telegram: "test_hotel_demo",
  created_at: new Date(),
  updated_at: new Date(),
  region_status: "active",
  ...over,
});

/** Репозиторий в памяти: точки по коду, регионы; записи журнала копятся. */
class FakeRepo {
  scans: NewQrScanEvent[] = [];
  entries: NewEntryContext[] = [];
  touches: NewAttributionTouch[] = [];
  lookups: string[] = [];
  constructor(
    private readonly points: ResolvedQrPoint[],
    private readonly regions: ContextRegion[],
  ) {}
  async findPointByCode(code: string) {
    this.lookups.push(code);
    return this.points.find((p) => p.code === code);
  }
  async findRegion(id: string) {
    return this.regions.find((r) => r.id === id);
  }
  async findDefaultRegion(code: string) {
    const active = this.regions.filter((r) => r.status === "active");
    return active.find((r) => r.code === code) ?? active[0];
  }
  async insertScanEvent(row: NewQrScanEvent) {
    this.scans.push(row);
    return { id: `0192f0c1-7a2b-7c3d-8e4f-0000000005${String(this.scans.length).padStart(2, "0")}` };
  }
  async insertEntryContext(row: NewEntryContext) {
    this.entries.push(row);
    return { id: `0192f0c1-7a2b-7c3d-8e4f-0000000006${String(this.entries.length).padStart(2, "0")}` };
  }
  async insertAttributionTouch(row: NewAttributionTouch) {
    this.touches.push(row);
    return {};
  }
}

/** Принципал из заголовка X-Test-User (вместо сессии T1-26). */
class TestPrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RbacRequest & { headers: Record<string, string> }>();
    const user = req.headers["x-test-user"];
    if (user) req.principal = { userId: user };
    return true;
  }
}

const DEFAULT_POINTS = [
  point({}),
  point({ id: "0192f0c1-7a2b-7c3d-8e4f-000000000102", code: "demoHotelOff1", active: false }),
  point({
    id: "0192f0c1-7a2b-7c3d-8e4f-000000000103",
    code: "demoCampaign1",
    type: "campaign",
    campaign: "summer-2026",
    venue_name_i18n: null,
    venue_description_i18n: null,
    venue_address_i18n: null,
    venue_phone: null,
    venue_website: null,
    venue_telegram: null,
  }),
  point({
    id: "0192f0c1-7a2b-7c3d-8e4f-000000000104",
    code: "suspendedQr1",
    region_id: REGION_SUSPENDED,
    region_status: "suspended",
  }),
];
const DEFAULT_REGIONS = [
  region(REGION_DEFAULT, "test-region"),
  region(REGION_A, "region-a"),
  region(REGION_SUSPENDED, "region-c", "suspended"),
];

async function start({
  points = DEFAULT_POINTS,
  regions = DEFAULT_REGIONS,
  sinkError,
}: { points?: ResolvedQrPoint[]; regions?: ContextRegion[]; sinkError?: Error } = {}) {
  const repo = new FakeRepo(points, regions);
  const events: AnalyticsEvent[] = [];
  const sink = {
    write: vi.fn(async (batch: readonly AnalyticsEvent[]) => {
      if (sinkError) throw sinkError;
      events.push(...batch);
    }),
  };
  const { db, queries } = recordingDb();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      AnalyticsModule.forRoot({ mode: "direct" }),
      QrContextModule,
    ],
    providers: [{ provide: APP_GUARD, useClass: TestPrincipalGuard }],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(ANALYTICS_SINK)
    .useValue(sink)
    .overrideProvider(QrContextRepository)
    .useValue(repo)
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "prod" });
  await app.init();
  return { app, repo, events, queries };
}

describe("GET /context/{start_param}", () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("активный QR отеля — регион, точка и «Про заклад»; скан, контекст, касание и qr_scanned", async () => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer()).get("/context/demoHotel01").expect(200);
    expect(res.body).toEqual({
      status: "ok",
      entryType: "hotel",
      region: {
        id: REGION_A,
        code: "region-a",
        name: { uk: "Регіон region-a" },
        timezone: "Europe/Kyiv",
        defaultLanguage: "uk",
      },
      qrPoint: { id: DEFAULT_POINTS[0]!.id, type: "hotel", placeId: null, campaign: null },
      venue: {
        name: { uk: "Тестовий готель", en: "Test hotel" },
        description: { uk: "Опис" },
        address: { uk: "вул. Тестова, 1" },
        phone: "+380000000001",
        website: "https://hotel.example",
        telegram: "test_hotel_demo",
      },
      entryContextId: expect.stringMatching(UUID),
      anonymousId: expect.stringMatching(UUID),
    });
    const anonymousId = res.body.anonymousId as string;
    expect(s.repo.scans).toEqual([
      {
        region_id: REGION_A,
        qr_point_id: DEFAULT_POINTS[0]!.id,
        raw_start_param: "demoHotel01",
        result: "ok",
        user_id: null,
        anonymous_id: anonymousId,
      },
    ]);
    expect(s.repo.entries).toEqual([
      expect.objectContaining({
        region_id: REGION_A,
        qr_point_id: DEFAULT_POINTS[0]!.id,
        entry_type: "hotel",
        source: "qr",
        anonymous_id: anonymousId,
      }),
    ]);
    expect(s.repo.touches).toEqual([
      expect.objectContaining({
        region_id: REGION_A,
        qr_point_id: DEFAULT_POINTS[0]!.id,
        source: "qr",
        campaign: null,
        entry_context_id: res.body.entryContextId,
      }),
    ]);
    expect(s.events).toEqual([
      expect.objectContaining({
        event: "qr_scanned",
        regionId: REGION_A,
        anonymousId,
        source: "qr",
        entryContextId: res.body.entryContextId,
        props: { qrPointId: DEFAULT_POINTS[0]!.id, result: "ok" },
      }),
    ]);
    // Всё — одной транзакцией SYSTEM (поиск кода кросс-tenant).
    expect(s.queries[0]!.sql).toContain("set_config('app.region_id'");
    expect(s.queries[0]!.parameters).toEqual(["", "system"]);
  });

  it("QR кампании — campaign в точке и в касании атрибуции, venue нет", async () => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer()).get("/context/demoCampaign1").expect(200);
    expect(res.body).toMatchObject({
      status: "ok",
      entryType: "campaign",
      qrPoint: { type: "campaign", campaign: "summer-2026" },
      venue: null,
    });
    expect(s.repo.touches[0]).toMatchObject({ campaign: "summer-2026", qr_point_id: DEFAULT_POINTS[2]!.id });
  });

  it("деактивированный QR — нейтральный контекст региона точки, точка не подставляется, скан inactive", async () => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer()).get("/context/demoHotelOff1").expect(200);
    expect(res.body).toMatchObject({
      status: "inactive",
      entryType: "default",
      region: { id: REGION_A },
      qrPoint: null,
      venue: null,
    });
    expect(s.repo.scans[0]).toMatchObject({
      result: "inactive",
      qr_point_id: DEFAULT_POINTS[1]!.id,
      region_id: REGION_A,
      raw_start_param: "demoHotelOff1",
    });
    expect(s.repo.entries[0]).toMatchObject({
      entry_type: "default",
      qr_point_id: null,
      region_id: REGION_A,
    });
    expect(s.repo.touches[0]).toMatchObject({ qr_point_id: DEFAULT_POINTS[1]!.id, campaign: null });
    expect(s.events[0]!.props).toEqual({ qrPointId: DEFAULT_POINTS[1]!.id, result: "inactive" });
  });

  it("точка в приостановленном регионе — inactive, контекст региона по умолчанию, журнал — в регионе точки", async () => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer()).get("/context/suspendedQr1").expect(200);
    expect(res.body).toMatchObject({ status: "inactive", region: { id: REGION_DEFAULT }, qrPoint: null });
    expect(s.repo.scans[0]).toMatchObject({
      region_id: REGION_SUSPENDED,
      qr_point_id: DEFAULT_POINTS[3]!.id,
    });
    expect(s.repo.entries[0]).toMatchObject({ region_id: REGION_DEFAULT, qr_point_id: null });
  });

  it("неизвестный код — not_found, регион по умолчанию, код сохраняется (он по формату)", async () => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer()).get("/context/unknownCode42").expect(200);
    expect(res.body).toMatchObject({
      status: "not_found",
      entryType: "default",
      region: { id: REGION_DEFAULT, code: "test-region" },
      qrPoint: null,
      venue: null,
    });
    expect(s.repo.scans[0]).toMatchObject({
      result: "not_found",
      qr_point_id: null,
      region_id: REGION_DEFAULT,
      raw_start_param: "unknownCode42",
    });
    expect(s.events[0]!.props).toEqual({ result: "not_found" });
  });

  it.each([
    ["короткий", "abc"],
    ["длинный", "a".repeat(65)],
    ["очень длинный", "b".repeat(2000)],
    ["с недопустимыми символами", encodeURIComponent("<script>alert(1)</script>")],
    ["с пробелом", "demo%20Hotel01"],
    ["кириллица", encodeURIComponent("Тестовий готель")],
  ])("мусорный параметр (%s) — 200 invalid, не ищется и не сохраняется", async (_name, param) => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer()).get(`/context/${param}`).expect(200);
    expect(res.body).toMatchObject({
      status: "invalid",
      entryType: "default",
      region: { id: REGION_DEFAULT },
    });
    expect(s.repo.lookups).toEqual([]);
    expect(s.repo.scans).toEqual([expect.objectContaining({ result: "invalid", raw_start_param: null })]);
    expect(s.repo.touches).toHaveLength(1);
    expect(s.events[0]!.props).toEqual({ result: "invalid" });
  });

  it.each([
    ["телефон", "380501234567"],
    ["телефон с +", encodeURIComponent("+380501234567")],
    ["e-mail", encodeURIComponent("tourist@mail.example")],
    ["номер карты", "4111111111111111"],
  ])("ПДн-подобное значение (%s) — invalid, значение нигде не сохраняется", async (_name, param) => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer()).get(`/context/${param}`).expect(200);
    expect(res.body.status).toBe("invalid");
    const raw = decodeURIComponent(param);
    const written = JSON.stringify([s.repo.scans, s.repo.entries, s.repo.touches, s.events, s.queries]);
    expect(written).not.toContain(raw);
    expect(s.repo.lookups).toEqual([]);
  });

  it("с сессией — скан, контекст и касание привязаны к пользователю; присланный anonymousId сохраняется", async () => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer())
      .get(`/context/demoHotel01?anonymousId=${ANON.toUpperCase()}`)
      .set("X-Test-User", USER)
      .expect(200);
    expect(res.body.anonymousId).toBe(ANON);
    expect(s.repo.scans[0]).toMatchObject({ user_id: USER, anonymous_id: ANON });
    expect(s.repo.entries[0]).toMatchObject({ user_id: USER, anonymous_id: ANON });
    expect(s.repo.touches[0]).toMatchObject({ user_id: USER, anonymous_id: ANON });
  });

  it("anonymousId не uuid — игнорируется, выдаётся новый", async () => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer())
      .get("/context/demoHotel01?anonymousId=+380501234567")
      .expect(200);
    expect(res.body.anonymousId).toMatch(UUID);
    expect(z.uuid().safeParse(res.body.anonymousId).success).toBe(true);
    expect(s.repo.scans[0]!.anonymous_id).toBe(res.body.anonymousId);
  });

  it.each([
    ["версия 0", "0192f0c1-7a2b-0c3d-8e4f-000000000001"],
    ["вариант не RFC", "0192f0c1-7a2b-7c3d-0e4f-000000000001"],
  ])("anonymousId — uuid, который не примет аналитика (%s), — заменяется новым", async (_name, bad) => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer()).get(`/context/demoHotel01?anonymousId=${bad}`).expect(200);
    expect(res.body.anonymousId).not.toBe(bad);
    expect(z.uuid().safeParse(res.body.anonymousId).success).toBe(true);
    expect(s.events[0]!.anonymousId).toBe(res.body.anonymousId);
  });

  it("битое percent-encoding пути — 400 (до обработчика), скан не пишется", async () => {
    const s = await start();
    app = s.app;
    await request(app.getHttpServer()).get("/context/demo%E0%A4%AHotel").expect(400);
    expect(s.repo.scans).toEqual([]);
  });

  it("ответ не кешируется (Cache-Control: no-store)", async () => {
    const s = await start();
    app = s.app;
    const res = await request(app.getHttpServer()).get("/context/demoHotel01").expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("в платформе нет активного региона — region null, EntryContext не создаётся, скан и касание пишутся", async () => {
    const s = await start({ points: [], regions: [] });
    app = s.app;
    const res = await request(app.getHttpServer()).get("/context/unknownCode42").expect(200);
    expect(res.body).toMatchObject({ status: "not_found", region: null, entryContextId: null });
    expect(s.repo.scans[0]).toMatchObject({ region_id: null });
    expect(s.repo.entries).toEqual([]);
    expect(s.repo.touches[0]).toMatchObject({ region_id: null, entry_context_id: null });
  });

  it("сбой аналитики не ломает вход — 200", async () => {
    const s = await start({ sinkError: new Error("redis down") });
    app = s.app;
    await request(app.getHttpServer()).get("/context/demoHotel01").expect(200);
    expect(s.repo.scans).toHaveLength(1);
  });

  it("у эндпоинта свой rate limit", () => {
    const rule = new Reflector().get<unknown>("rateLimit:rule", QrContextController.prototype.get);
    expect(rule).toEqual(QR_CONTEXT_RATE_LIMIT);
  });
});
