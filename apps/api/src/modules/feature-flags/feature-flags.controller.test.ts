// Unit (без БД): API фича-флагов (T1-22) — публичные эффективные значения, управление по праву feature_flag.manage
// на PLATFORM с записью в аудит, финансовый гейт finance.live в prod (SUPERADMIN + отметки ⚖-решений), guard
// @RequireFeature (выключенный модуль — 404). БД — заглушка в памяти по SQL; на реальной PostgreSQL —
// test/integration/feature-flags.test.ts.
import { Controller, Get, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CompiledQuery } from "kysely";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { ErrorEnvelope } from "@tg/shared";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
  type Grant,
  type Principal,
} from "../rbac/index.js";
import type { AppEnv } from "./catalog.js";
import { FeatureFlagsModule } from "./feature-flags.module.js";
import { regionFromParam, RequireFeature } from "./feature.guard.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const TECH_GRANT = "0190f5c2-7d3e-7000-8000-0000000001aa";
const SA_GRANT = "0190f5c2-7d3e-7000-8000-0000000001bb";

function grant(id: string, role: string, scopeType: Grant["scopeType"], regionId: string | null): Grant {
  return { id, role, scopeType, scopeId: regionId, regionId, validUntil: null };
}

const SUPERUSER = grant(TECH_GRANT, "TECH_SUPERUSER", "PLATFORM", null);
/** Бизнес-роль SUPERADMIN (реестр ролей, блок 3); для гейта finance.live проверяется по коду роли. */
const SUPERADMIN = grant(SA_GRANT, "SUPERADMIN", "PLATFORM", null);
const REGION_ADMIN_A = grant(TECH_GRANT, "TECH_REGION_ADMIN", "REGION", A);

type FlagRow = { key: string; target_region_id: string | null; enabled: boolean; updated_by: string | null };
type MarkRow = { decision: string; document_ref: string; marked_by: string | null; marked_at: Date };

/** Таблицы feature_flags, feature_flag_gate_marks, regions в памяти; отвечает на запросы репозиториев по SQL. */
function fakeDb(init: { flags?: FlagRow[]; marks?: string[] } = {}) {
  const flags: FlagRow[] = [...(init.flags ?? [])];
  const marks: MarkRow[] = (init.marks ?? []).map((d) => ({
    decision: d,
    document_ref: `doc ${d}`,
    marked_by: USER,
    marked_at: new Date("2026-11-01T10:00:00Z"),
  }));
  const row = (f: FlagRow) => ({
    id: "0190f5c2-7d3e-7000-8000-000000000f00",
    ...f,
    created_at: new Date(),
    updated_at: new Date(),
  });
  const same = (f: FlagRow, key: unknown, region: unknown) =>
    f.key === key && f.target_region_id === (region ?? null);
  const { db, queries } = recordingDb({}, (q: CompiledQuery) => {
    const p = q.parameters;
    if (q.sql.startsWith('select * from "regions"')) return p[0] === A || p[0] === B ? [{ id: p[0] }] : [];
    if (q.sql.startsWith('select * from "feature_flags"')) {
      if (q.sql.includes("for update")) {
        const region = q.sql.includes('"target_region_id" is null') ? null : p[1];
        return flags.filter((f) => same(f, p[0], region)).map(row);
      }
      if (q.sql.includes("where")) {
        const region = p[0] as string | undefined;
        return flags.filter((f) => f.target_region_id === null || f.target_region_id === region).map(row);
      }
      return flags.map(row);
    }
    if (q.sql.startsWith('insert into "feature_flags"')) {
      const [key, region, enabled, by] = p as [string, string | null, boolean, string | null];
      const existing = flags.find((f) => same(f, key, region));
      if (existing) Object.assign(existing, { enabled, updated_by: by });
      else flags.push({ key, target_region_id: region, enabled, updated_by: by });
      return [row(flags.find((f) => same(f, key, region))!)];
    }
    if (q.sql.startsWith('delete from "feature_flags"')) {
      const region = q.sql.includes('"target_region_id" is null') ? null : p[1];
      const i = flags.findIndex((f) => same(f, p[0], region));
      return i < 0 ? [] : flags.splice(i, 1).map(row);
    }
    if (q.sql.startsWith('select * from "feature_flag_gate_marks"')) return marks;
    if (q.sql.startsWith('insert into "feature_flag_gate_marks"')) {
      const [decision, document_ref, marked_by] = p as [string, string, string | null];
      if (marks.some((m) => m.decision === decision)) return [];
      const m = { decision, document_ref, marked_by, marked_at: new Date("2026-11-02T10:00:00Z") };
      marks.push(m);
      return [m];
    }
    if (q.sql.startsWith('insert into "audit_logs"')) return [{ id: "log-1", region_id: null }];
    if (q.sql.startsWith('insert into "audit_log_pii"')) return [{ audit_log_id: "log-1" }];
    return [];
  });
  return { db, queries, flags, marks };
}

@Controller("t122/bookings")
@RequireFeature("module.bookings")
class BookingsProbeController {
  @Get()
  list() {
    return { ok: true };
  }
}

@Controller("t122/regions/:regionId/reviews")
@RequireFeature("module.reviews", { region: regionFromParam("regionId") })
class ReviewsProbeController {
  @Get()
  list() {
    return { ok: true };
  }
}

async function start(
  opts: {
    appEnv?: AppEnv;
    principal?: Principal;
    grants?: Grant[];
    flags?: FlagRow[];
    marks?: string[];
  } = {},
) {
  const fake = fakeDb(opts);
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      FeatureFlagsModule.forRoot({ appEnv: opts.appEnv ?? "staging" }),
    ],
    controllers: [BookingsProbeController, ReviewsProbeController],
  })
    .overrideProvider(DATABASE)
    .useValue(fake.db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => opts.principal })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve(opts.grants ?? []) })
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "prod" });
  await app.init();
  return { app, ...fake };
}

const audits = (queries: CompiledQuery[]) =>
  queries.filter((q) => q.sql.startsWith('insert into "audit_logs"'));
const enabledOf = (body: { items: { key: string; enabled: boolean }[] }, key: string) =>
  body.items.find((i) => i.key === key)?.enabled;

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /feature-flags", () => {
  it("prod без переопределений — всё выключено, finance.live выключен; без аутентификации", async () => {
    const s = await start({ appEnv: "prod" });
    app = s.app;
    const res = await request(app.getHttpServer()).get("/feature-flags").expect(200);
    expect(res.body.regionId).toBeNull();
    expect(res.body.items).toHaveLength(10);
    expect(res.body.items.every((i: { enabled: boolean }) => !i.enabled)).toBe(true);
    expect(enabledOf(res.body, "finance.live")).toBe(false);
  });

  it("переопределение региона действует только в нём; окружение — для всех", async () => {
    const s = await start({
      appEnv: "staging",
      flags: [
        { key: "module.reviews", target_region_id: A, enabled: false, updated_by: null },
        { key: "module.ambassadors", target_region_id: null, enabled: false, updated_by: null },
      ],
    });
    app = s.app;
    const inA = await request(app.getHttpServer()).get(`/feature-flags?regionId=${A}`).expect(200);
    expect(inA.body.regionId).toBe(A);
    expect(enabledOf(inA.body, "module.reviews")).toBe(false);
    expect(enabledOf(inA.body, "module.ambassadors")).toBe(false);
    const inB = await request(app.getHttpServer()).get(`/feature-flags?regionId=${B}`).expect(200);
    expect(enabledOf(inB.body, "module.reviews")).toBe(true);
    expect(enabledOf(inB.body, "module.ambassadors")).toBe(false);
  });

  it("некорректный regionId — 400", async () => {
    const s = await start();
    app = s.app;
    await request(app.getHttpServer()).get("/feature-flags?regionId=x").expect(400);
  });
});

describe("@RequireFeature: выключенный модуль недоступен через API", () => {
  it("prod по умолчанию (release.mvp выключен) — 404 NOT_FOUND; staging — 200", async () => {
    let s = await start({ appEnv: "prod" });
    app = s.app;
    const res = await request(app.getHttpServer()).get("/t122/bookings").expect(404);
    expect((res.body as ErrorEnvelope).error.code).toBe("NOT_FOUND");
    await app.close();
    s = await start({ appEnv: "staging" });
    app = s.app;
    await request(app.getHttpServer()).get("/t122/bookings").expect(200);
  });

  it("модуль выключен в регионе — 404 для запроса в контексте этого региона, в другом — 200", async () => {
    const flags = [{ key: "module.bookings", target_region_id: A, enabled: false, updated_by: null }];
    let s = await start({ principal: { userId: USER }, grants: [REGION_ADMIN_A], flags });
    app = s.app;
    await request(app.getHttpServer()).get("/t122/bookings").expect(404);
    await app.close();
    s = await start({
      principal: { userId: USER },
      grants: [grant(TECH_GRANT, "TECH_REGION_ADMIN", "REGION", B)],
      flags,
    });
    app = s.app;
    await request(app.getHttpServer()).get("/t122/bookings").expect(200);
  });
});

describe("@RequireFeature: регион без tenant-контекста (гость, турист)", () => {
  const flags = [
    { key: "module.reviews", target_region_id: A, enabled: false, updated_by: null },
    { key: "module.bookings", target_region_id: A, enabled: false, updated_by: null },
  ];

  it("резолвер региона: региональный off — 404 в этом регионе, в другом — 200; не uuid — значение окружения", async () => {
    const s = await start({ flags });
    app = s.app;
    const res = await request(app.getHttpServer()).get(`/t122/regions/${A}/reviews`).expect(404);
    expect((res.body as ErrorEnvelope).error.code).toBe("NOT_FOUND");
    await request(app.getHttpServer()).get(`/t122/regions/${B}/reviews`).expect(200);
    await request(app.getHttpServer()).get("/t122/regions/x/reviews").expect(200);
  });

  it("без резолвера и без контекста региона — значение окружения (региональное переопределение не действует)", async () => {
    const s = await start({ flags });
    app = s.app;
    await request(app.getHttpServer()).get("/t122/bookings").expect(200);
  });

  it("tenant-контекст региона важнее резолвера", async () => {
    const s = await start({
      flags,
      principal: { userId: USER },
      grants: [grant(TECH_GRANT, "TECH_REGION_ADMIN", "REGION", B)],
    });
    app = s.app;
    await request(app.getHttpServer()).get(`/t122/regions/${A}/reviews`).expect(200);
  });
});

describe("управление флагами /admin/feature-flags", () => {
  it("без принципала — 401; без права feature_flag.manage на PLATFORM — 403; изменений и аудита нет", async () => {
    let s = await start();
    app = s.app;
    await request(app.getHttpServer()).get("/admin/feature-flags").expect(401);
    await request(app.getHttpServer())
      .put("/admin/feature-flags/release.r1")
      .send({ enabled: false })
      .expect(401);
    await app.close();
    s = await start({ principal: { userId: USER }, grants: [REGION_ADMIN_A] });
    app = s.app;
    await request(app.getHttpServer())
      .put("/admin/feature-flags/release.r1")
      .send({ enabled: false })
      .expect(403);
    expect(s.flags).toEqual([]);
    expect(audits(s.queries)).toEqual([]);
  });

  it("список: значение по умолчанию окружения, переопределения, эффективное значение", async () => {
    const s = await start({
      appEnv: "prod",
      principal: { userId: USER },
      grants: [SUPERUSER],
      flags: [
        { key: "release.r1", target_region_id: null, enabled: true, updated_by: USER },
        { key: "release.r1", target_region_id: A, enabled: false, updated_by: USER },
      ],
    });
    app = s.app;
    const res = await request(app.getHttpServer()).get("/admin/feature-flags").expect(200);
    expect(res.body.appEnv).toBe("prod");
    const r1 = res.body.items.find((i: { key: string }) => i.key === "release.r1");
    expect(r1).toEqual({
      key: "release.r1",
      description: expect.any(String),
      requires: [],
      financeGate: false,
      default: false,
      override: true,
      regionOverrides: [{ regionId: A, enabled: false }],
      effective: true,
    });
  });

  it("PUT: переопределение на окружение, аудит feature_flag.set с old/new, актором и назначением", async () => {
    const s = await start({ principal: { userId: USER }, grants: [SUPERUSER] });
    app = s.app;
    const res = await request(app.getHttpServer())
      .put("/admin/feature-flags/module.reviews")
      .set("X-Request-Id", "req-1")
      .send({ enabled: false, reason: "инцидент" })
      .expect(200);
    expect(res.body).toMatchObject({ key: "module.reviews", override: false, effective: false });
    expect(s.flags).toEqual([
      { key: "module.reviews", target_region_id: null, enabled: false, updated_by: USER },
    ]);
    const [audit] = audits(s.queries);
    expect(audit!.parameters).toEqual([
      "user",
      USER,
      null,
      "feature_flag.set",
      "feature_flag",
      "module.reviews",
      { enabled: null },
      { enabled: false, appEnv: "staging" },
      "инцидент",
      "req-1",
      TECH_GRANT,
    ]);
    // Advisory-блокировка пары (флаг, регион) до чтения старого значения: oldValues верен и при гонке.
    const order = s.queries.map((q) => q.sql);
    const lock = order.findIndex((q) => q.includes("pg_advisory_xact_lock(hashtext($1))"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(order.findIndex((q) => q.includes("for update")));
    expect(s.queries[lock]!.parameters).toEqual(["feature_flag:module.reviews:"]);
    // ПДн запроса (IP, user agent) — в audit_log_pii (auditFromRequest).
    expect(s.queries.some((q) => q.sql.startsWith('insert into "audit_log_pii"'))).toBe(true);
  });

  it("PUT с регионом: регион в аудите; несуществующий регион — 422; null — сброс к значению по умолчанию", async () => {
    const s = await start({ principal: { userId: USER }, grants: [SUPERUSER] });
    app = s.app;
    await request(app.getHttpServer())
      .put("/admin/feature-flags/module.bookings")
      .send({ enabled: false, regionId: A })
      .expect(200);
    expect(audits(s.queries)[0]!.parameters[2]).toBe(A);
    const missing = await request(app.getHttpServer())
      .put("/admin/feature-flags/module.bookings")
      .send({ enabled: false, regionId: "0190f5c2-7d3e-7000-8000-0000000000ff" })
      .expect(422);
    expect((missing.body as ErrorEnvelope).error.details).toEqual({ reason: "region_not_found" });
    const reset = await request(app.getHttpServer())
      .put("/admin/feature-flags/module.bookings")
      .send({ enabled: null, regionId: A })
      .expect(200);
    expect(reset.body.regionOverrides).toEqual([]);
    expect(s.flags).toEqual([]);
    expect(audits(s.queries)).toHaveLength(2);
    // Сброс несуществующего переопределения — без аудита.
    await request(app.getHttpServer())
      .put("/admin/feature-flags/module.bookings")
      .send({ enabled: null })
      .expect(200);
    expect(audits(s.queries)).toHaveLength(2);
  });

  it("неизвестный флаг — 404; тело без enabled или с лишним полем — 400", async () => {
    const s = await start({ principal: { userId: USER }, grants: [SUPERUSER] });
    app = s.app;
    await request(app.getHttpServer())
      .put("/admin/feature-flags/module.nope")
      .send({ enabled: true })
      .expect(404);
    await request(app.getHttpServer()).put("/admin/feature-flags/release.r1").send({}).expect(400);
    await request(app.getHttpServer())
      .put("/admin/feature-flags/release.r1")
      .send({ enabled: true, extra: 1 })
      .expect(400);
    expect(audits(s.queries)).toEqual([]);
  });

  it("выбранный в сессии регион (контекст региона) — 403: менять флаги можно только в контексте PLATFORM", async () => {
    const s = await start({ principal: { userId: USER, regionId: A }, grants: [SUPERUSER] });
    app = s.app;
    const res = await request(app.getHttpServer())
      .put("/admin/feature-flags/release.r1")
      .send({ enabled: true })
      .expect(403);
    expect((res.body as ErrorEnvelope).error.details).toEqual({ reason: "platform_context_required" });
    expect(s.flags).toEqual([]);
  });
});

describe("финансовый гейт finance.live (D-81)", () => {
  it("вне prod — по праву feature_flag.manage, как любой флаг", async () => {
    const s = await start({ appEnv: "staging", principal: { userId: USER }, grants: [SUPERUSER] });
    app = s.app;
    await request(app.getHttpServer())
      .put("/admin/feature-flags/finance.live")
      .send({ enabled: true })
      .expect(200);
  });

  it("prod: без назначения SUPERADMIN — 403 finance_gate_role, даже у TECH_SUPERUSER; ничего не записано", async () => {
    const s = await start({ appEnv: "prod", principal: { userId: USER }, grants: [SUPERUSER], marks: [] });
    app = s.app;
    const res = await request(app.getHttpServer())
      .put("/admin/feature-flags/finance.live")
      .send({ enabled: true })
      .expect(403);
    expect((res.body as ErrorEnvelope).error.details).toEqual({ reason: "finance_gate_role" });
    expect(s.flags).toEqual([]);
    expect(audits(s.queries)).toEqual([]);
  });

  it("prod: SUPERADMIN, но не все ⚖-решения отмечены — 409 со списком недостающих", async () => {
    const s = await start({
      appEnv: "prod",
      principal: { userId: USER },
      grants: [SUPERUSER, SUPERADMIN],
      marks: ["D-09", "D-10", "D-13"],
    });
    app = s.app;
    const res = await request(app.getHttpServer())
      .put("/admin/feature-flags/finance.live")
      .send({ enabled: true, regionId: A })
      .expect(409);
    expect((res.body as ErrorEnvelope).error.details).toEqual({
      reason: "finance_gate_open",
      missingDecisions: ["D-17", "D-20", "D-24"],
    });
    expect(s.flags).toEqual([]);
  });

  it("prod: SUPERADMIN и все отметки — включение; в аудите назначение SUPERADMIN", async () => {
    const s = await start({
      appEnv: "prod",
      principal: { userId: USER },
      grants: [SUPERUSER, SUPERADMIN],
      marks: ["D-09", "D-10", "D-13", "D-17", "D-20", "D-24"],
    });
    app = s.app;
    await request(app.getHttpServer())
      .put("/admin/feature-flags/finance.live")
      .send({ enabled: true })
      .expect(200);
    expect(s.flags).toEqual([
      { key: "finance.live", target_region_id: null, enabled: true, updated_by: USER },
    ]);
    expect(audits(s.queries)[0]!.parameters.at(-1)).toBe(SA_GRANT);
  });

  it("prod: выключить finance.live может любой с feature_flag.manage (аварийный выключатель)", async () => {
    const s = await start({
      appEnv: "prod",
      principal: { userId: USER },
      grants: [SUPERUSER],
      flags: [{ key: "finance.live", target_region_id: null, enabled: true, updated_by: USER }],
    });
    app = s.app;
    await request(app.getHttpServer())
      .put("/admin/feature-flags/finance.live")
      .send({ enabled: false })
      .expect(200);
    expect(s.flags[0]!.enabled).toBe(false);
  });

  it("prod: сброс регионального off при включённом на окружении — это включение, нужен гейт", async () => {
    const flags = [
      { key: "finance.live", target_region_id: null, enabled: true, updated_by: USER },
      { key: "finance.live", target_region_id: A, enabled: false, updated_by: USER },
    ];
    let s = await start({ appEnv: "prod", principal: { userId: USER }, grants: [SUPERUSER], flags });
    app = s.app;
    const res = await request(app.getHttpServer())
      .put("/admin/feature-flags/finance.live")
      .send({ enabled: null, regionId: A })
      .expect(403);
    expect((res.body as ErrorEnvelope).error.details).toEqual({ reason: "finance_gate_role" });
    expect(s.flags).toHaveLength(2);
    await app.close();
    s = await start({
      appEnv: "prod",
      principal: { userId: USER },
      grants: [SUPERUSER, SUPERADMIN],
      flags,
      marks: ["D-09", "D-10", "D-13", "D-17", "D-20", "D-24"],
    });
    app = s.app;
    await request(app.getHttpServer())
      .put("/admin/feature-flags/finance.live")
      .send({ enabled: null, regionId: A })
      .expect(200);
    expect(s.flags).toEqual([flags[0]]);
    // Сброс переопределения окружения (значение по умолчанию — off) — без гейта.
    await app.close();
    s = await start({ appEnv: "prod", principal: { userId: USER }, grants: [SUPERUSER], flags: [flags[0]!] });
    app = s.app;
    await request(app.getHttpServer())
      .put("/admin/feature-flags/finance.live")
      .send({ enabled: null })
      .expect(200);
  });

  it("отметки: список требуемых; отметка с аудитом; повтор — 409; решение не из гейта — 400", async () => {
    const s = await start({ appEnv: "prod", principal: { userId: USER }, grants: [SUPERUSER] });
    app = s.app;
    const created = await request(app.getHttpServer())
      .post("/admin/feature-flags/gate-marks")
      .send({ decision: "D-09", documentRef: "Заключение юриста №1, решение PO 02.11.2026" })
      .expect(201);
    expect(created.body).toMatchObject({ decision: "D-09", markedBy: USER });
    const [audit] = audits(s.queries);
    expect(audit!.parameters.slice(3, 6)).toEqual([
      "feature_flag.gate_mark",
      "feature_flag_gate_mark",
      "D-09",
    ]);
    await request(app.getHttpServer())
      .post("/admin/feature-flags/gate-marks")
      .send({ decision: "D-09", documentRef: "ещё раз" })
      .expect(409);
    await request(app.getHttpServer())
      .post("/admin/feature-flags/gate-marks")
      .send({ decision: "D-01", documentRef: "x" })
      .expect(400);
    await request(app.getHttpServer())
      .post("/admin/feature-flags/gate-marks")
      .send({ decision: "D-10", documentRef: "   " })
      .expect(400);
    const list = await request(app.getHttpServer()).get("/admin/feature-flags/gate-marks").expect(200);
    expect(list.body.required).toEqual(["D-09", "D-10", "D-13", "D-17", "D-20", "D-24"]);
    expect(list.body.items.map((m: { decision: string }) => m.decision)).toEqual(["D-09"]);
  });
});
