// Unit (без БД): планировщик (C09, S-04; ADR-0020) — HTTP-контракт (валидация, 401, 403, флаг) и правила сервиса
// (только опубликованные сценарии; пункт с неопубликованным местом — «Недоступно»; альтернативы — только
// опубликованные; «Замінити» — только на альтернативу). Репозиторий подменён; на БД — test/integration/host.test.ts.
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import {
  DATABASE,
  DatabaseModule,
  regionContext,
  currentTenant,
  withTenant,
  type IdempotencyKey,
  type Scenario,
  type ScenarioItem,
  type UserPlan,
} from "../../db/index.js";
import type { AuditService } from "../audit/index.js";
import { FeatureFlagsModule, FeatureFlagsService } from "../feature-flags/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
  type Grant,
} from "../rbac/index.js";
import type { RegionsRepository } from "../regions/index.js";
import type { Forecast, WeatherDay, WeatherService } from "../weather/index.js";
import { planItemsFromScenario } from "./plan-rules.js";
import type { PlannerAi } from "./plan-ai.service.js";
import { USER_PLANS_MAX } from "./planner.dto.js";
import { PlannerModule } from "./planner.module.js";
import { IDEMPOTENCY_STORE, IdempotencyModule, type IdempotencyStore } from "../idempotency/index.js";
import type { CatalogPlaceRow, PlannerRepository, PlanPlaceRow } from "./planner.repository.js";
import { PlannerService } from "./planner.service.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const SCEN = "0190f5c2-7d3e-7000-8000-0000000000c1";
const PLAN = "0190f5c2-7d3e-7000-8000-0000000000c2";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const P = (n: number) => `0190f5c2-7d3e-7000-8000-${String(n).padStart(12, "0")}`;

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Idempotency-Key в памяти (как IdempotencyKeysRepository): повтор с тем же ключом — сохранённый ответ. */
function memoryIdempotency(): IdempotencyStore {
  const rows = new Map<string, IdempotencyKey>();
  return {
    claim: (input) => {
      const id = `${input.scope}|${input.key}`;
      const row = rows.get(id);
      if (row) return Promise.resolve({ acquired: false, row: { ...row } });
      const now = new Date();
      const created: IdempotencyKey = {
        id,
        scope: input.scope,
        key: input.key,
        request_hash: input.requestHash,
        status: "in_progress",
        response_status: null,
        response_body: null,
        expires_at: new Date(now.getTime() + input.ttlSeconds * 1000),
        created_at: now,
        updated_at: now,
      };
      rows.set(id, created);
      return Promise.resolve({ acquired: true, row: { ...created } });
    },
    complete: (id, status, body) => {
      Object.assign(rows.get(id)!, { status: "completed", response_status: status, response_body: body });
      return Promise.resolve();
    },
    fail: (id) => {
      rows.get(id)!.status = "failed";
      return Promise.resolve();
    },
  };
}

const grant = (role: string, scopeType: Grant["scopeType"], regionId: string | null): Grant => ({
  id: "0190f5c2-7d3e-7000-8000-0000000001aa",
  role,
  scopeType,
  scopeId: regionId,
  regionId,
  validUntil: null,
});

async function start(authenticated = false, grants: Grant[] = [], selectedRegion: string | null = null) {
  /** Был ли tenant-контекст (транзакция запроса) при вызове сервиса создания/«Інший варіант». */
  const tenants: unknown[] = [];
  const service = {
    scenarios: vi.fn(() => Promise.resolve({ items: [] })),
    scenario: vi.fn(() => Promise.resolve({ id: SCEN })),
    plans: vi.fn(() => Promise.resolve({ items: [] })),
    plan: vi.fn(() => Promise.resolve({ id: PLAN })),
    createPlan: vi.fn(() => {
      tenants.push(currentTenant());
      return Promise.resolve({ id: PLAN });
    }),
    regeneratePlan: vi.fn(() => {
      tenants.push(currentTenant());
      return Promise.resolve({ id: PLAN });
    }),
    updatePlan: vi.fn(() => Promise.resolve({ id: PLAN })),
    deletePlan: vi.fn(() => Promise.resolve()),
    adminList: vi.fn(() => Promise.resolve({ items: [] })),
  };
  const { db } = recordingDb({});
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      // Раньше TenancyModule: захват ключа — до транзакции запроса (как в AppModule).
      IdempotencyModule,
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      FeatureFlagsModule.forRoot({ appEnv: "local" }),
      PlannerModule,
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({
      resolve: () =>
        authenticated ? { userId: USER, sessionId: "s1", regionId: selectedRegion } : undefined,
    })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve(grants) })
    .overrideProvider(IDEMPOTENCY_STORE)
    .useValue(memoryIdempotency())
    .overrideProvider(FeatureFlagsService)
    .useValue({ isEnabled: () => Promise.resolve(true) })
    .overrideProvider(PlannerService)
    .useValue(service)
    .compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  const server = app.getHttpServer();
  // POST — с Idempotency-Key (у создания и «Інший варіант» он обязателен), raw — без него.
  const http = () => {
    const r = request(server);
    return {
      get: (u: string) => r.get(u),
      patch: (u: string) => r.patch(u),
      delete: (u: string) => r.delete(u),
      post: (u: string) => r.post(u).set("Idempotency-Key", randomUUID()),
    };
  };
  return { http, raw: () => request(server), service, tenants };
}

describe("HTTP планировщика", () => {
  it("создание и «Інший варіант»: обязателен Idempotency-Key; повтор с тем же ключом — тот же ответ без вызова", async () => {
    const { raw, service } = await start(true);
    const missing = await raw().post("/me/plan").send({ regionId: REGION }).expect(400);
    expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    await raw().post(`/me/plan/${PLAN}/regenerate`).send({ regionId: REGION }).expect(400);
    const key = randomUUID();
    await raw().post("/me/plan").set("Idempotency-Key", key).send({ regionId: REGION, days: 2 }).expect(201);
    const again = await raw()
      .post("/me/plan")
      .set("Idempotency-Key", key)
      .send({ regionId: REGION, days: 2 })
      .expect(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(service.createPlan).toHaveBeenCalledTimes(1);
    await raw()
      .post(`/me/plan/${PLAN}/regenerate`)
      .set("Idempotency-Key", key)
      .send({ regionId: REGION })
      .expect(200);
    expect(service.regeneratePlan).toHaveBeenCalledTimes(1);
  });

  it("персонал и админы (ORG_OWNER, REGION_ADMIN, MODERATOR, SUPERADMIN): Claude — вне транзакции запроса", async () => {
    const roles: [Grant[], string | null][] = [
      [[grant("ORG_OWNER", "REGION", REGION)], null],
      [[grant("REGION_ADMIN", "REGION", REGION)], null],
      [[grant("MODERATOR", "REGION", REGION)], null],
      [[grant("SUPERADMIN", "PLATFORM", null)], REGION],
      [[grant("SUPERADMIN", "PLATFORM", null)], null],
    ];
    for (const [grants, selected] of roles) {
      const { http, service, tenants } = await start(true, grants, selected);
      await http().post("/me/plan").send({ regionId: REGION }).expect(201);
      await http().post(`/me/plan/${PLAN}/regenerate`).send({ regionId: REGION }).expect(200);
      expect(service.createPlan).toHaveBeenCalledTimes(1);
      expect(tenants).toEqual([undefined, undefined]);
      await app?.close();
      app = undefined;
    }
  });

  it("сценарии — без сессии, фильтр tag/days; неизвестный тег — 400", async () => {
    const { http, service } = await start();
    await http().get(`/scenarios?regionId=${REGION}&tag=kids&days=1`).expect(200);
    expect(service.scenarios).toHaveBeenCalledWith(REGION, { tag: "kids", days: 1 });
    await http().get(`/scenarios?regionId=${REGION}&season=winter`).expect(200);
    expect(service.scenarios).toHaveBeenLastCalledWith(REGION, { season: "winter" });
    await http().get(`/scenarios?regionId=${REGION}&season=monsoon`).expect(400);
    await http().get(`/scenarios?regionId=${REGION}&tag=space`).expect(400);
    await http().get(`/scenarios/${SCEN}?regionId=${REGION}`).expect(200);
    await http().get(`/me/plan?regionId=${REGION}`).expect(401);
  });

  it("«Мій план» — пользователь сессии; правка — replaceItem/removeItem/startDate", async () => {
    const { http, service } = await start(true);
    await http().post("/me/plan").send({ regionId: REGION, scenarioId: SCEN }).expect(201);
    expect(service.createPlan).toHaveBeenCalledWith(USER, { regionId: REGION, scenarioId: SCEN });
    const patch = { regionId: REGION, replaceItem: { itemId: P(1), placeId: P(2) }, startDate: "2026-11-10" };
    await http().patch(`/me/plan/${PLAN}`).send(patch).expect(200);
    expect(service.updatePlan).toHaveBeenCalledWith(USER, PLAN, expect.objectContaining(patch));
    await http().patch(`/me/plan/${PLAN}`).send({ regionId: REGION, startDate: "10.11.2026" }).expect(400);
    await http().delete(`/me/plan/${PLAN}?regionId=${REGION}`).expect(204);
    // Параметры поездки и галочка варианта; свой план — без scenarioId.
    await http()
      .post("/me/plan")
      .send({ regionId: REGION, days: 3, children: 1, withCar: false })
      .expect(201);
    await http().post("/me/plan").send({ regionId: REGION, adults: 0 }).expect(400);
    await http().post("/me/plan").send({ regionId: REGION, days: 15 }).expect(400);
    await http().post("/me/plan").send({ regionId: REGION, withCar: "так" }).expect(400);
    // null в параметрах — 400 (а не NOT NULL в БД → 500).
    for (const field of ["adults", "children", "withCar", "days"])
      await http()
        .patch(`/me/plan/${PLAN}`)
        .send({ regionId: REGION, [field]: null })
        .expect(400);
    const add = { regionId: REGION, addItem: { dayNo: 2, slot: "rain", placeId: P(3) } };
    await http().patch(`/me/plan/${PLAN}`).send(add).expect(200);
    expect(service.updatePlan).toHaveBeenLastCalledWith(USER, PLAN, expect.objectContaining(add));
    await http()
      .patch(`/me/plan/${PLAN}`)
      .send({ regionId: REGION, addItem: { dayNo: 1, slot: "night", placeId: P(3) } })
      .expect(400);
    // «Інший варіант» и интересы живого плана; неизвестный интерес — 400.
    await http()
      .post(`/me/plan/${PLAN}/regenerate`)
      .send({ regionId: REGION, interests: ["culture"] })
      .expect(200);
    expect(service.regeneratePlan).toHaveBeenCalledWith(USER, PLAN, {
      regionId: REGION,
      interests: ["culture"],
    });
    await http()
      .post(`/me/plan/${PLAN}/regenerate`)
      .send({ regionId: REGION, interests: ["space"] })
      .expect(400);
    await http().post("/me/plan/x/regenerate").send({ regionId: REGION }).expect(400);
    await http()
      .post("/me/plan")
      .send({ regionId: REGION, interests: ["gastro", "relax"] })
      .expect(201);
    await http().post("/me/plan").send({ regionId: REGION, interests: "gastro" }).expect(400);
    // Админка сценариев — только с правом scenario.manage.
    await http().get("/admin/scenarios").expect(403);
  });
});

// --- сервис ---

const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  id: SCEN,
  region_id: REGION,
  code: "one-day",
  title_i18n: { uk: "День" },
  description_i18n: null,
  days: 1,
  tags: ["one_day"],
  seasons: [],
  status: "published",
  version: 2,
  is_sponsored: false,
  ad_label: null,
  sort_order: 0,
  created_by: null,
  created_at: new Date(),
  updated_at: new Date(),
  ...over,
});

const item = (over: Partial<ScenarioItem>): ScenarioItem => ({
  id: P(500),
  region_id: REGION,
  scenario_id: SCEN,
  day_no: 1,
  position: 0,
  place_id: P(10),
  time_hint: "09:00:00",
  duration_min: 60,
  note_i18n: null,
  alternatives: [],
  created_at: new Date(),
  ...over,
});

const place = (n: number, status = "published"): PlanPlaceRow => ({
  id: P(n),
  category_id: P(99),
  name_i18n: { uk: `Місце ${n}` },
  address_i18n: null,
  location: { lon: 24 + n / 1000, lat: 48 },
  status,
});

function plannerService(
  repo: Partial<Record<keyof PlannerRepository, unknown>>,
  weather?: Pick<WeatherService, "snapshotAt" | "flushRefresh">,
) {
  const { db } = recordingDb({});
  const items = [
    item({ id: P(501), position: 0, place_id: P(10), alternatives: [P(11), P(12)] }),
    item({ id: P(502), position: 1, place_id: P(13) }),
  ];
  const places = [place(10), place(11), place(12, "unavailable"), place(13, "unavailable")];
  const full = {
    findScenario: vi.fn(() => Promise.resolve(scenario())),
    items: vi.fn(() => Promise.resolve(items)),
    places: vi.fn((ids: string[]) => Promise.resolve(places.filter((p) => ids.includes(p.id)))),
    scenarioVersions: vi.fn(() => Promise.resolve(new Map([[SCEN, 3]]))),
    catalogPlaces: vi.fn(() => Promise.resolve([])),
    firstLocality: vi.fn(() => Promise.resolve(undefined)),
    ...repo,
  };
  return {
    repo: full,
    service: new PlannerService(
      db,
      full as unknown as PlannerRepository,
      { findById: (id: string) => Promise.resolve({ id, status: "active" }) } as unknown as RegionsRepository,
      {} as AuditService,
      weather as WeatherService | undefined,
    ),
  };
}

describe("PlannerService", () => {
  it("список туриста — сезон из запроса или текущий по поясу региона; seasons в ответе", async () => {
    const listScenarios = vi.fn(() => Promise.resolve([scenario({ seasons: ["summer", "autumn"] })]));
    const { service } = plannerService({ listScenarios });
    const out = await service.scenarios(REGION, { season: "summer" });
    expect(listScenarios).toHaveBeenLastCalledWith({ status: "published", season: "summer" });
    expect(out.items[0]).toMatchObject({ seasons: ["summer", "autumn"] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
    try {
      await service.scenarios(REGION, { tag: "kids" });
    } finally {
      vi.useRealTimers();
    }
    expect(listScenarios).toHaveBeenLastCalledWith({ status: "published", tag: "kids", season: "winter" });
  });

  it("сценарий: недоступный пункт — place null; альтернативы — только опубликованные; черновик — 404", async () => {
    const { service } = plannerService({});
    const s = await service.scenario(REGION, SCEN);
    const [first, second] = s.plan[0]!.items;
    expect(first!.place?.id).toBe(P(10));
    expect(first!.alternatives.map((a) => a.id)).toEqual([P(11)]);
    expect(second).toMatchObject({ place: null, available: false, distanceFromPreviousMeters: null });
    expect(s.itemCount).toBe(1);
    expect(JSON.stringify(s)).not.toContain("source");
    const draft = plannerService({
      findScenario: vi.fn(() => Promise.resolve(scenario({ status: "draft" }))),
    });
    await expect(draft.service.scenario(REGION, SCEN)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("«Замінити»: на опубликованную альтернативу — да; на неопубликованную — 422; версия основы новее — scenarioUpdated", async () => {
    const planItems = planItemsFromScenario([
      item({ id: P(501), place_id: P(10), alternatives: [P(11), P(12)] }),
    ]);
    const row: UserPlan = {
      id: PLAN,
      region_id: REGION,
      user_id: USER,
      scenario_id: SCEN,
      scenario_version: 2,
      title_i18n: { uk: "День" },
      start_date: null,
      items: planItems,
      adults: 2,
      children: 0,
      with_car: true,
      days: null,
      base_place_id: null,
      interests: [],
      created_at: new Date(),
      updated_at: new Date(),
    };
    const updatePlan = vi.fn((_id: string, patch: { items?: unknown }) =>
      Promise.resolve({ ...row, items: patch.items ?? row.items }),
    );
    const { service } = plannerService({ findPlan: vi.fn(() => Promise.resolve(row)), updatePlan });
    const itemId = planItems[0]!.id;
    const dto = await service.updatePlan(USER, PLAN, {
      regionId: REGION,
      replaceItem: { itemId, placeId: P(11) },
    });
    expect(dto.plan[0]!.items[0]).toMatchObject({ replaced: true, place: { id: P(11) } });
    expect(dto.scenarioUpdated).toBe(true);
    await expect(
      service.updatePlan(USER, PLAN, { regionId: REGION, replaceItem: { itemId, placeId: P(12) } }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE" });
  });
});

const catalogRow = (n: number, category: string, over: Partial<CatalogPlaceRow> = {}): CatalogPlaceRow => ({
  id: P(n),
  category_id: P(90),
  category_code: category,
  category_name: { uk: category },
  name_i18n: { uk: `Місце ${n}` },
  address_i18n: null,
  location: { lon: 24 + n / 10000, lat: 48 },
  recommended: false,
  tags: [],
  extra_category_codes: [],
  ...over,
});

describe("PlannerService: параметри поїздки і варіанти на вибір", () => {
  const customRow = (over: Partial<UserPlan> = {}): UserPlan => ({
    id: PLAN,
    region_id: REGION,
    user_id: USER,
    scenario_id: null,
    scenario_version: null,
    title_i18n: { uk: "Мій план", en: "My plan" },
    start_date: null,
    items: [],
    adults: 2,
    children: 1,
    with_car: false,
    days: 2,
    base_place_id: null,
    interests: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  });
  const catalog = [
    catalogRow(1, "cafes", { name_i18n: { uk: "Кав'ярня" } }),
    catalogRow(2, "cafes", { name_i18n: { uk: "Бар «Гуцул»" } }),
    catalogRow(3, "museums"),
    catalogRow(4, "nature", { name_i18n: { uk: "Водоспад Пробій" } }),
    catalogRow(5, "restaurants"),
    catalogRow(6, "chany"),
  ];

  it("свой план: без сценария, дни 1…days пустые, варианты по частям дня; с детьми — без бара", async () => {
    const createPlan = vi.fn((row: Record<string, unknown>) =>
      Promise.resolve(customRow({ days: row.days as number })),
    );
    const { service, repo } = plannerService({
      createPlan,
      countPlans: vi.fn(() => Promise.resolve(0)),
      catalogPlaces: vi.fn(() => Promise.resolve(catalog)),
      firstLocality: vi.fn(() =>
        Promise.resolve({ name_i18n: { uk: "Яремче" }, location: { lon: 24, lat: 48 } }),
      ),
    });
    const dto = await service.createPlan(USER, { regionId: REGION, days: 2, children: 1, withCar: false });
    expect(repo.findScenario).not.toHaveBeenCalled();
    expect(createPlan).toHaveBeenCalledWith(
      expect.objectContaining({ scenario_id: null, title_i18n: { uk: "Мій план", en: "My plan" }, days: 2 }),
    );
    expect(dto.trip).toMatchObject({
      adults: 2,
      children: 1,
      withCar: false,
      days: 2,
      base: { kind: "locality" },
    });
    expect(dto.plan.map((d) => [d.dayNo, d.items.length])).toEqual([
      [1, 0],
      [2, 0],
    ]);
    expect(dto.options.map((d) => d.slots.map((s) => s.slot))).toEqual([
      ["morning", "afternoon", "evening", "rain"],
      ["morning", "afternoon", "evening", "rain"],
    ]);
    const all = dto.options.flatMap((d) => d.slots.flatMap((s) => s.options));
    expect(all.some((o) => o.place.id === P(2))).toBe(false);
    const waterfall = all.find((o) => o.place.id === P(4))!;
    expect(waterfall).toMatchObject({ kind: "waterfall", reason: "walk", travel: "walk" });
    expect(waterfall.place.categoryName).toEqual({ uk: "nature" });
  });

  it("галочка: место — в часть дня; повтор — 409; день вне плана и неопубликованное место — 422; меньше дней — пункты убираются", async () => {
    let row = customRow({ days: 2 });
    const updatePlan = vi.fn((_id: string, patch: Partial<UserPlan>) => {
      row = { ...row, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
      return Promise.resolve(row);
    });
    const { service } = plannerService({
      findPlan: vi.fn(() => Promise.resolve(row)),
      updatePlan,
      catalogPlaces: vi.fn(() => Promise.resolve(catalog)),
    });
    const dto = await service.updatePlan(USER, PLAN, {
      regionId: REGION,
      addItem: { dayNo: 2, slot: "evening", placeId: P(10) },
    });
    expect(dto.plan[1]!.items).toEqual([
      expect.objectContaining({ slot: "evening", place: expect.objectContaining({ id: P(10) }) }),
    ]);
    // Выбранное место больше не предлагается.
    expect(
      dto.options.flatMap((d) => d.slots.flatMap((s) => s.options)).some((o) => o.place.id === P(10)),
    ).toBe(false);
    await expect(
      service.updatePlan(USER, PLAN, {
        regionId: REGION,
        addItem: { dayNo: 2, slot: "morning", placeId: P(10) },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", messageKey: "errors.plan.alreadyInPlan" });
    await expect(
      service.updatePlan(USER, PLAN, {
        regionId: REGION,
        addItem: { dayNo: 3, slot: "morning", placeId: P(11) },
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE", messageKey: "errors.plan.dayOutOfRange" });
    await expect(
      service.updatePlan(USER, PLAN, {
        regionId: REGION,
        addItem: { dayNo: 1, slot: "morning", placeId: P(12) },
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE", messageKey: "errors.plan.placeUnavailable" });
    await expect(
      service.updatePlan(USER, PLAN, { regionId: REGION, basePlaceId: P(13) }),
    ).rejects.toMatchObject({ messageKey: "errors.plan.placeUnavailable" });
    const shorter = await service.updatePlan(USER, PLAN, {
      regionId: REGION,
      days: 1,
      withCar: true,
      adults: 4,
    });
    expect(shorter.plan).toHaveLength(1);
    expect(shorter.trip).toMatchObject({ days: 1, withCar: true, adults: 4 });
    expect(updatePlan).toHaveBeenLastCalledWith(
      PLAN,
      expect.objectContaining({ items: [], days: 1, with_car: true, adults: 4 }),
    );
  });

  it("создание: база из QR снята с публикации — план без базы (не 422); лимит пунктов — 422", async () => {
    const createPlan = vi.fn((row: Record<string, unknown>) =>
      Promise.resolve(customRow(row as Partial<UserPlan>)),
    );
    const { service } = plannerService({ createPlan, countPlans: vi.fn(() => Promise.resolve(0)) });
    await service.createPlan(USER, { regionId: REGION, basePlaceId: P(13) });
    expect(createPlan).toHaveBeenCalledWith(expect.objectContaining({ base_place_id: null }));
    const full = customRow({
      items: Array.from({ length: 10 }, (_, k) => ({
        id: P(700 + k),
        dayNo: 1,
        position: k,
        placeId: P(200 + k),
        timeHint: null,
        durationMin: null,
        note: null,
        alternatives: [],
        replacedPlaceId: null,
        slot: "morning" as const,
      })),
    });
    const limited = plannerService({ findPlan: vi.fn(() => Promise.resolve(full)) });
    await expect(
      limited.service.updatePlan(USER, PLAN, {
        regionId: REGION,
        addItem: { dayNo: 1, slot: "morning", placeId: P(10) },
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE", messageKey: "errors.plan.itemsLimit" });
  });

  it("сценарий со смешанным временем: порядок пунктов сохраняется, часть дня без времени — от предыдущего", async () => {
    const mixed = [
      item({ id: P(601), position: 0, place_id: P(10), time_hint: "18:00:00" }),
      item({ id: P(602), position: 1, place_id: P(11), time_hint: null }),
      item({ id: P(603), position: 2, place_id: P(10), time_hint: "09:00:00" }),
    ];
    const { service } = plannerService({ items: vi.fn(() => Promise.resolve(mixed)) });
    const s = await service.scenario(REGION, SCEN);
    expect(s.plan[0]!.items.map((i) => [i.id, i.slot])).toEqual([
      [P(601), "evening"],
      [P(602), "evening"],
      [P(603), "evening"],
    ]);
  });

  it("каталог региона кэшируется: два запроса плана — один запрос каталога", async () => {
    const row = customRow();
    const { service, repo } = plannerService({
      findPlan: vi.fn(() => Promise.resolve(row)),
      catalogPlaces: vi.fn(() => Promise.resolve(catalog)),
    });
    await service.plan(REGION, USER, PLAN);
    await service.plan(REGION, USER, PLAN);
    expect(repo.catalogPlaces).toHaveBeenCalledTimes(1);
  });

  it("погода: по датам дней; гроза — без горных походов в вариантах дня и предупреждение у выбранного похода", async () => {
    const wday = (date: string, over: Partial<WeatherDay> = {}): WeatherDay => ({
      date,
      condition: "clear",
      description: null,
      iconUrl: null,
      temperatureMax: 12,
      temperatureMin: 3,
      precipitationSum: 0,
      precipitationProbabilityMax: 5,
      snowfallSum: 0,
      windSpeedMax: 10,
      windGustsMax: 20,
      rainy: false,
      warnings: [],
      ...over,
    });
    const forecast: Forecast = {
      source: "google",
      latitude: 48,
      longitude: 24,
      elevation: null,
      timezone: "Europe/Kyiv",
      current: null,
      days: [
        wday("2026-11-10", { condition: "thunderstorm", rainy: true, warnings: ["thunderstorm"] }),
        wday("2026-11-11"),
      ],
    };
    const forecastAt = vi.fn(() => Promise.resolve(forecast));
    const flushRefresh = vi.fn();
    const hike = { ...planItemsFromScenario([item({ place_id: P(10), time_hint: "10:00:00" })])[0]! };
    const row = customRow({ start_date: "2026-11-10", days: 3, children: 0, items: [hike] });
    const mountains = [
      catalogRow(10, "nature", { name_i18n: { uk: "Гора Хом'як" } }),
      catalogRow(8, "nature", { name_i18n: { uk: "Вершина Петрос" } }),
    ];
    const { service } = plannerService(
      {
        findPlan: vi.fn(() => Promise.resolve(row)),
        catalogPlaces: vi.fn(() => Promise.resolve([...catalog, ...mountains])),
        firstLocality: vi.fn(() =>
          Promise.resolve({ name_i18n: { uk: "Яремче" }, location: { lon: 24, lat: 48 } }),
        ),
      },
      { snapshotAt: forecastAt, flushRefresh },
    );
    const dto = await service.plan(REGION, USER, PLAN);
    // Снимки — внутри транзакции, фоновое обновление — после неё.
    expect(flushRefresh).toHaveBeenCalledTimes(1);
    expect(dto.weatherSource).toBe("google");
    // День 3 (12.11) — вне прогноза: погоды нет.
    expect(dto.weather.map((w) => [w.dayNo, w.date, w.rainy, w.noMountains])).toEqual([
      [1, "2026-11-10", true, true],
      [2, "2026-11-11", false, false],
    ]);
    const ids = (day: number) =>
      dto.options.find((d) => d.dayNo === day)!.slots.flatMap((s) => s.options.map((o) => o.place.id));
    expect(ids(1)).not.toContain(P(8));
    expect(ids(2)).toContain(P(8));
    expect(dto.plan[0]!.items[0]).toMatchObject({ place: { id: P(10) }, weatherWarnings: ["thunderstorm"] });
    expect(forecastAt).toHaveBeenCalledWith(expect.anything(), { mountain: true });
    // Без даты начала — погоды нет и источник не спрашивается.
    forecastAt.mockClear();
    const noDate = plannerService(
      {
        findPlan: vi.fn(() => Promise.resolve({ ...row, start_date: null })),
        catalogPlaces: vi.fn(() => Promise.resolve(catalog)),
        firstLocality: vi.fn(() =>
          Promise.resolve({ name_i18n: { uk: "Яремче" }, location: { lon: 24, lat: 48 } }),
        ),
      },
      { snapshotAt: forecastAt, flushRefresh },
    );
    const plain = await noDate.service.plan(REGION, USER, PLAN);
    expect(plain).toMatchObject({ weather: [], weatherSource: null });
    expect(forecastAt).not.toHaveBeenCalled();
  });

  it("базовая точка — опубликованное место: отсчёт от него, в ответе — его название", async () => {
    const row = customRow({ base_place_id: P(10) });
    const { service } = plannerService({
      findPlan: vi.fn(() => Promise.resolve(row)),
      catalogPlaces: vi.fn(() => Promise.resolve(catalog)),
    });
    const dto = await service.plan(REGION, USER, PLAN);
    expect(dto.trip.base).toEqual({ kind: "place", placeId: P(10), name: { uk: "Місце 10" } });
    // Список планов — без вариантов (дорого и не нужно).
    const list = plannerService({ listPlans: vi.fn(() => Promise.resolve([row])) });
    expect((await list.service.plans(REGION, USER)).items[0]!.options).toEqual([]);
    expect(list.repo.catalogPlaces).not.toHaveBeenCalled();
  });
});

describe("PlannerService: админка без контекста региона", () => {
  it("SUPERADMIN без выбранного региона: правка и смена статуса — 403, а не 500", async () => {
    const { service } = plannerService({});
    const meta = { actor: { type: "system" as const } };
    const input = { code: "x", title: { uk: "X" }, days: 1, items: [{ dayNo: 1, placeId: P(10) }] };
    await expect(service.adminUpdate(SCEN, input, meta)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "region_context_required" },
    });
    await expect(service.adminSetStatus(SCEN, "published", meta)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const { db } = recordingDb({});
    await expect(
      withTenant(db, regionContext(REGION), () => service.adminCreate(P(77), input, meta)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("PlannerService: живой план через Claude (planner.ai)", () => {
  const customRow = (over: Partial<UserPlan> = {}): UserPlan => ({
    id: PLAN,
    region_id: REGION,
    user_id: USER,
    scenario_id: null,
    scenario_version: null,
    title_i18n: { uk: "Мій план", en: "My plan" },
    start_date: null,
    items: [],
    adults: 2,
    children: 2,
    with_car: true,
    days: 3,
    base_place_id: null,
    interests: [],
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  });
  const draft = {
    title: { uk: "Три дні з дітьми", en: "Three days with kids" },
    items: [
      {
        dayNo: 1,
        placeId: P(10),
        timeHint: "10:00",
        durationMin: 90,
        note: { uk: "Взуття." },
        alternatives: [P(11)],
      },
      { dayNo: 2, placeId: P(11), timeHint: "18:30", durationMin: 75, note: null, alternatives: [] },
    ],
  };
  function setup(opts: { flag?: boolean; ok?: boolean; enabled?: boolean; row?: UserPlan } = {}) {
    let row = opts.row ?? customRow();
    const generate = vi.fn(() =>
      Promise.resolve(
        opts.ok === false
          ? { ok: false, reason: "invalid" }
          : { ok: true, draft, attempts: 1, usage: {}, model: "m" },
      ),
    );
    const ai = { enabled: opts.enabled ?? true, generate } as unknown as PlannerAi;
    const flags = {
      isEnabled: vi.fn((key: string) => Promise.resolve(key === "planner.ai" ? (opts.flag ?? true) : true)),
    } as unknown as FeatureFlagsService;
    const createPlan = vi.fn((r: Record<string, unknown>) =>
      Promise.resolve(customRow(r as Partial<UserPlan>)),
    );
    const updatePlan = vi.fn((_id: string, patch: Partial<UserPlan>) => {
      row = { ...row, ...patch };
      return Promise.resolve(row);
    });
    const places = [place(10), place(11)];
    const repo = {
      findScenario: vi.fn(),
      items: vi.fn(() => Promise.resolve([])),
      places: vi.fn((ids: string[]) => Promise.resolve(places.filter((p) => ids.includes(p.id)))),
      scenarioVersions: vi.fn(() => Promise.resolve(new Map())),
      catalogPlaces: vi.fn(() => Promise.resolve([])),
      firstLocality: vi.fn(() =>
        Promise.resolve({ name_i18n: { uk: "Яремче" }, location: { lon: 24, lat: 48 } }),
      ),
      countPlans: vi.fn(() => Promise.resolve(0)),
      createPlan,
      findPlan: vi.fn(() => Promise.resolve(row)),
      updatePlan,
    };
    const { db } = recordingDb({});
    const regions = {
      findById: (id: string) => Promise.resolve({ id, status: "active", timezone: "Europe/Kyiv" }),
    } as unknown as RegionsRepository;
    const service = new PlannerService(
      db,
      repo as unknown as PlannerRepository,
      regions,
      {} as AuditService,
      undefined,
      flags,
      ai,
    );
    return { service, generate, createPlan, updatePlan, repo };
  }
  const input = {
    regionId: REGION,
    days: 3,
    children: 2,
    withCar: true,
    interests: ["waterfalls" as const],
  };

  it("флаг включён — пункты и назва от Claude, generation: ai; параметры туриста — в запрос", async () => {
    const { service, generate, createPlan } = setup();
    const dto = await service.createPlan(USER, { ...input, startDate: "2026-07-10" });
    expect(generate).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ id: REGION }),
      expect.objectContaining({
        days: 3,
        children: 2,
        withCar: true,
        season: "summer",
        interests: ["waterfalls"],
        centerName: "Яремче",
      }),
    );
    expect(createPlan).toHaveBeenCalledWith(
      expect.objectContaining({ title_i18n: draft.title, scenario_id: null }),
    );
    expect(dto.generation).toBe("ai");
    expect(dto.plan[0]!.items[0]).toMatchObject({ slot: "morning", place: { id: P(10) }, timeHint: "10:00" });
    expect(dto.plan[1]!.items[0]).toMatchObject({ slot: "evening", place: { id: P(11) } });
  });

  it("Claude не смог — правиловый план (пустой, с вариантами), generation: fallback; без ключа — тоже", async () => {
    const failed = setup({ ok: false });
    const dto = await failed.service.createPlan(USER, input);
    expect(dto.generation).toBe("fallback");
    expect(failed.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({ items: [], title_i18n: { uk: "Мій план", en: "My plan" } }),
    );
    const nokey = setup({ enabled: false });
    expect((await nokey.service.createPlan(USER, input)).generation).toBe("fallback");
    expect(nokey.generate).not.toHaveBeenCalled();
  });

  it("флаг выключен, сценарий или ai: false (ассистент) — без Claude, generation: null", async () => {
    const manual = setup();
    expect((await manual.service.createPlan(USER, { ...input, ai: false })).generation).toBeNull();
    expect(manual.generate).not.toHaveBeenCalled();
    const off = setup({ flag: false });
    expect((await off.service.createPlan(USER, input)).generation).toBeNull();
    expect(off.generate).not.toHaveBeenCalled();
    const ok = setup();
    ok.repo.findScenario.mockResolvedValue(scenario());
    expect((await ok.service.createPlan(USER, { regionId: REGION, scenarioId: SCEN })).generation).toBeNull();
    expect(ok.generate).not.toHaveBeenCalled();
  });

  it("планов уже максимум — 409 без запроса к Claude", async () => {
    const full = setup();
    full.repo.countPlans.mockResolvedValue(USER_PLANS_MAX);
    await expect(full.service.createPlan(USER, input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(full.generate).not.toHaveBeenCalled();
  });

  it("«Інший варіант»: параметры плана, места текущего — «уже були»; новые пункты и назва", async () => {
    const current = customRow({
      items: [
        {
          id: P(600),
          dayNo: 1,
          position: 0,
          placeId: P(11),
          timeHint: null,
          durationMin: null,
          note: null,
          alternatives: [],
          replacedPlaceId: null,
        },
      ],
    });
    const { service, generate, updatePlan } = setup({ row: current });
    const dto = await service.regeneratePlan(USER, PLAN, { regionId: REGION });
    expect(generate).toHaveBeenCalledWith(
      USER,
      expect.anything(),
      expect.objectContaining({ days: 3, children: 2, avoid: [P(11)] }),
    );
    expect(updatePlan).toHaveBeenCalledWith(PLAN, expect.objectContaining({ title_i18n: draft.title }));
    expect(dto).toMatchObject({ generation: "ai", title: draft.title });
  });

  it("«Інший варіант»: план изменили во время ожидания — 409, правки не перезаписаны; дни — по текущему плану", async () => {
    const t0 = new Date("2026-11-04T10:00:00Z");
    const row = customRow({ updated_at: t0, interests: ["culture"] });
    const changed = setup({ row });
    changed.repo.findPlan
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, updated_at: new Date(t0.getTime() + 1000) });
    await expect(changed.service.regeneratePlan(USER, PLAN, { regionId: REGION })).rejects.toMatchObject({
      code: "CONFLICT",
      messageKey: "errors.plan.changedMeanwhile",
    });
    expect(changed.updatePlan).not.toHaveBeenCalled();
    // Интересы — из плана; дней стало 1 — пункты второго дня не сохраняются.
    expect(changed.generate).toHaveBeenCalledWith(
      USER,
      expect.anything(),
      expect.objectContaining({ interests: ["culture"] }),
    );
    const shorter = setup({ row });
    shorter.repo.findPlan.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, days: 1 });
    await shorter.service.regeneratePlan(USER, PLAN, { regionId: REGION, interests: ["gastro", "gastro"] });
    const saved = shorter.updatePlan.mock.calls[0]![1] as Partial<UserPlan>;
    expect(saved.items!.map((i) => i.dayNo)).toEqual([1]);
    expect(saved.interests).toEqual(["gastro"]);
  });

  it("внутри tenant-транзакции — явная ошибка конфигурации, а не тихий правиловый план", async () => {
    const { service, generate } = setup();
    const { db } = recordingDb({});
    await expect(
      withTenant(db, regionContext(REGION), () => service.createPlan(USER, input)),
    ).rejects.toThrow(/WithoutTenantContext/);
    expect(generate).not.toHaveBeenCalled();
  });

  it("«Інший варіант»: Claude не смог — план без изменений; флаг выключен — 404; план сценария — 422", async () => {
    const failed = setup({ ok: false });
    expect((await failed.service.regeneratePlan(USER, PLAN, { regionId: REGION })).generation).toBe(
      "fallback",
    );
    expect(failed.updatePlan).not.toHaveBeenCalled();
    await expect(
      setup({ flag: false }).service.regeneratePlan(USER, PLAN, { regionId: REGION }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      setup({ row: customRow({ scenario_id: SCEN }) }).service.regeneratePlan(USER, PLAN, {
        regionId: REGION,
      }),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE", messageKey: "errors.plan.notCustom" });
  });
});
