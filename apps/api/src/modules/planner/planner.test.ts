// Unit (без БД): планировщик (C09, S-04; ADR-0020) — HTTP-контракт (валидация, 401, 403, флаг) и правила сервиса
// (только опубликованные сценарии; пункт с неопубликованным местом — «Недоступно»; альтернативы — только
// опубликованные; «Замінити» — только на альтернативу). Репозиторий подменён; на БД — test/integration/host.test.ts.
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
  withTenant,
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
} from "../rbac/index.js";
import type { RegionsRepository } from "../regions/index.js";
import { planItemsFromScenario } from "./plan-rules.js";
import { PlannerModule } from "./planner.module.js";
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

async function start(authenticated = false) {
  const service = {
    scenarios: vi.fn(() => Promise.resolve({ items: [] })),
    scenario: vi.fn(() => Promise.resolve({ id: SCEN })),
    plans: vi.fn(() => Promise.resolve({ items: [] })),
    plan: vi.fn(() => Promise.resolve({ id: PLAN })),
    createPlan: vi.fn(() => Promise.resolve({ id: PLAN })),
    updatePlan: vi.fn(() => Promise.resolve({ id: PLAN })),
    deletePlan: vi.fn(() => Promise.resolve()),
    adminList: vi.fn(() => Promise.resolve({ items: [] })),
  };
  const { db } = recordingDb({});
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      FeatureFlagsModule.forRoot({ appEnv: "local" }),
      PlannerModule,
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => (authenticated ? { userId: USER } : undefined) })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve([]) })
    .overrideProvider(FeatureFlagsService)
    .useValue({ isEnabled: () => Promise.resolve(true) })
    .overrideProvider(PlannerService)
    .useValue(service)
    .compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  return { http: () => request(app!.getHttpServer()), service };
}

describe("HTTP планировщика", () => {
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

function plannerService(repo: Partial<Record<keyof PlannerRepository, unknown>>) {
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
