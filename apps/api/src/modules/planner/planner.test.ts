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
import { DATABASE, DatabaseModule, type Scenario, type ScenarioItem, type UserPlan } from "../../db/index.js";
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
import type { PlannerRepository, PlanPlaceRow } from "./planner.repository.js";
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
