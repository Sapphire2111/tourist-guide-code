// Unit (без БД): /admin/qr-points — права (REGION_ADMIN, SUPERADMIN; MODERATOR — 403), изоляция региона (чужая
// точка: список пуст, чтение/правка/деактивация/печать — 404, в SQL — фильтр region_id контекста), генерация кода
// сервером, правила типа, аудит изменений, печать (deep link + SVG; без имени бота — 409). Таблица — в памяти по
// SQL (sql-table-fake). RLS и гранты — test/integration/admin-core.test.ts.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { ErrorEnvelope } from "@tg/shared";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { SqlTableFake } from "../../../test/support/sql-table-fake.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { encodeIdCursor } from "../../common/http/index.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import { checkStartParam } from "../qr-context/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
  type Grant,
} from "../rbac/index.js";
import { QrPointsModule } from "./qr-points.module.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const grant = (role: string, regionId: string | null): Grant => ({
  id: "0190f5c2-7d3e-7000-8000-0000000001aa",
  role,
  scopeType: regionId ? "REGION" : "PLATFORM",
  scopeId: regionId,
  regionId,
  validUntil: null,
});
const ADMIN_A = grant("REGION_ADMIN", A);

const defaults = () => ({
  active: true,
  campaign: null,
  source: null,
  place_id: null,
  venue_name_i18n: null,
  venue_description_i18n: null,
  venue_address_i18n: null,
  venue_phone: null,
  venue_website: null,
  venue_telegram: null,
});

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(opts: { grants?: Grant[]; botUsername?: string; authenticated?: boolean } = {}) {
  const fake = new SqlTableFake({ table: "qr_points", defaults, unique: "code" });
  const { db } = recordingDb({}, fake.respond);
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      QrPointsModule.forRoot({ botUsername: opts.botUsername }),
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => (opts.authenticated === false ? undefined : { userId: USER }) })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve(opts.grants ?? [ADMIN_A]) })
    .compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  const pointB = fake.put({
    region_id: B,
    code: "regionBcode01",
    type: "region",
    label: "Точка Б",
    created_at: new Date(),
    updated_at: new Date(),
  });
  return { http: () => request(app!.getHttpServer()), fake, pointB };
}

type Point = { id: string; code: string; regionId: string; active: boolean; venue: unknown; label: string };
type Page = { items: Point[]; nextCursor: string | null };

describe("/admin/qr-points", () => {
  it("без сессии — 401; MODERATOR и роль без права — 403; в БД ничего не уходит", async () => {
    let s = await start({ authenticated: false });
    expect((await s.http().get("/admin/qr-points").expect(401)).body).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
    await app!.close();
    for (const role of ["MODERATOR", "TECH_AUDITOR"]) {
      s = await start({ grants: [grant(role, A)] });
      const res = await s.http().post("/admin/qr-points").send({ type: "region", label: "x" }).expect(403);
      expect((res.body as ErrorEnvelope).error.code).toBe("FORBIDDEN");
      expect(s.fake.tableQueries()).toEqual([]);
      await app!.close();
    }
    app = undefined;
  });

  it("создание: код генерирует сервер (формат start_param), регион — из контекста, аудит qr_point.create", async () => {
    const { http, fake } = await start();
    const res = await http()
      .post("/admin/qr-points")
      .send({
        type: "hotel",
        label: " Ресепшн ",
        source: "sticker",
        venue: { name: { uk: "Готель" }, phone: "+380501234567", website: "https://hotel.example" },
      })
      .expect(201);
    const point = res.body as Point;
    expect(checkStartParam(point.code)).toEqual({ valid: true, code: point.code });
    expect(point).toMatchObject({
      regionId: A,
      label: "Ресепшн",
      active: true,
      venue: { name: { uk: "Готель" }, phone: "+380501234567", website: "https://hotel.example" },
    });
    const insert = fake.tableQueries().find((q) => q.sql.startsWith("insert"))!;
    expect(insert.sql).toContain('on conflict ("code") do nothing');
    expect(insert.parameters).toContain(A);
    expect(fake.audit).toHaveLength(1);
    expect(fake.audit[0]).toMatchObject({
      action: "qr_point.create",
      entity_type: "qr_point",
      entity_id: point.id,
      region_id: A,
      actor_user_id: USER,
      role_assignment_id: ADMIN_A.id,
    });
  });

  it("правила типа: «Про заклад» не у hotel, campaign без метки — 422; лишнее поле и битый телефон — 400", async () => {
    const { http, fake } = await start();
    for (const [body, reason] of [
      [{ type: "region", label: "x", venue: { name: { uk: "Н" } } }, "venue_hotel_only"],
      [{ type: "campaign", label: "x" }, "campaign_required"],
    ] as const) {
      const res = await http().post("/admin/qr-points").send(body).expect(422);
      expect((res.body as ErrorEnvelope).error).toMatchObject({ code: "UNPROCESSABLE", details: { reason } });
    }
    for (const body of [
      { type: "hotel", label: "x", code: "myOwnCode123" },
      { type: "hotel", label: "x", venue: { name: { uk: "Н" }, phone: "050123" } },
      { type: "nope", label: "x" },
      { type: "hotel", label: "" },
    ])
      await http().post("/admin/qr-points").send(body).expect(400);
    expect(fake.tableQueries().filter((q) => q.sql.startsWith("insert"))).toEqual([]);
  });

  it("изоляция: точка региона Б не видна админу A — список без неё, чтение/правка/вкл-выкл/печать — 404", async () => {
    const { http, fake, pointB } = await start({ botUsername: "tourist_guide_bot" });
    const id = pointB.id as string;
    const list = (await http().get("/admin/qr-points").expect(200)).body as Page;
    expect(list.items).toEqual([]);
    await http().get(`/admin/qr-points/${id}`).expect(404);
    await http().patch(`/admin/qr-points/${id}`).send({ label: "чужая" }).expect(404);
    await http().post(`/admin/qr-points/${id}/deactivate`).expect(404);
    await http().post(`/admin/qr-points/${id}/activate`).expect(404);
    await http().get(`/admin/qr-points/${id}/print`).expect(404);
    expect(fake.rows.get(id)).toMatchObject({ label: "Точка Б", active: true });
    // Каждый запрос к таблице ограничен регионом контекста (TenantGuardPlugin).
    for (const q of fake.tableQueries()) {
      expect(q.sql, q.sql).toContain('"qr_points"."region_id" = $');
      expect(q.parameters, q.sql).toContain(A);
    }
    expect(fake.audit).toEqual([]);
  });

  it("SUPERADMIN без выбранного региона: видит все регионы, создать нельзя (region_context_required)", async () => {
    const { http, pointB } = await start({ grants: [grant("SUPERADMIN", null)] });
    const list = (await http().get("/admin/qr-points").expect(200)).body as Page;
    expect(list.items.map((p) => p.id)).toEqual([pointB.id]);
    const res = await http().post("/admin/qr-points").send({ type: "region", label: "x" }).expect(403);
    expect((res.body as ErrorEnvelope).error.details).toEqual({ reason: "region_context_required" });
  });

  it("правка, фильтры, курсор; деактивация и повтор (без второго аудита); активация", async () => {
    const { http, fake } = await start();
    const created = (
      await http()
        .post("/admin/qr-points")
        .send({ type: "campaign", label: "Листівка", campaign: "summer-2026" })
        .expect(201)
    ).body as Point;
    await http().post("/admin/qr-points").send({ type: "region", label: "Стенд" }).expect(201);
    const patched = (
      await http()
        .patch(`/admin/qr-points/${created.id}`)
        .send({ label: "Листівка 2", source: "flyer" })
        .expect(200)
    ).body as Point;
    expect(patched).toMatchObject({ label: "Листівка 2", code: created.code });
    expect(fake.audit.at(-1)).toMatchObject({
      action: "qr_point.update",
      old_values: { label: "Листівка", source: null },
      new_values: { label: "Листівка 2", source: "flyer" },
    });
    await http().patch(`/admin/qr-points/${created.id}`).send({ campaign: null }).expect(422);
    await http().patch(`/admin/qr-points/${created.id}`).send({ type: "region" }).expect(400);

    const filtered = (await http().get("/admin/qr-points").query({ type: "campaign" }).expect(200))
      .body as Page;
    expect(filtered.items.map((p) => p.id)).toEqual([created.id]);
    const page1 = (await http().get("/admin/qr-points").query({ limit: 1 }).expect(200)).body as Page;
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBe(encodeIdCursor(page1.items[0]!.id));
    const page2 = (
      await http().get("/admin/qr-points").query({ limit: 1, cursor: page1.nextCursor }).expect(200)
    ).body as Page;
    expect(page2.items.map((p) => p.id)).not.toContain(page1.items[0]!.id);
    await http().get("/admin/qr-points").query({ active: "maybe" }).expect(400);

    const auditBefore = fake.audit.length;
    expect((await http().post(`/admin/qr-points/${created.id}/deactivate`).expect(200)).body).toMatchObject({
      active: false,
    });
    await http().post(`/admin/qr-points/${created.id}/deactivate`).expect(200);
    expect(fake.audit.length).toBe(auditBefore + 1);
    expect(fake.audit.at(-1)).toMatchObject({ action: "qr_point.deactivate", new_values: { active: false } });
    const inactive = (await http().get("/admin/qr-points").query({ active: "false" }).expect(200))
      .body as Page;
    expect(inactive.items.map((p) => p.id)).toEqual([created.id]);
    await http().post(`/admin/qr-points/${created.id}/activate`).expect(200);
    expect(fake.audit.at(-1)).toMatchObject({ action: "qr_point.activate" });
  });

  it("печать: deep link на бота и SVG; без TELEGRAM_BOT_USERNAME и у неактивной точки — 409", async () => {
    let s = await start({ botUsername: "tourist_guide_bot" });
    const p = (await s.http().post("/admin/qr-points").send({ type: "region", label: "Стенд" }).expect(201))
      .body as Point;
    const print = (await s.http().get(`/admin/qr-points/${p.id}/print`).expect(200)).body as {
      deepLink: string;
      svg: string;
      code: string;
    };
    expect(print.deepLink).toBe(`https://t.me/tourist_guide_bot?startapp=${p.code}`);
    expect(print.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    await s.http().post(`/admin/qr-points/${p.id}/deactivate`).expect(200);
    const inactive = await s.http().get(`/admin/qr-points/${p.id}/print`).expect(409);
    expect((inactive.body as ErrorEnvelope).error).toMatchObject({
      messageKey: "errors.qr.inactive",
      details: { reason: "qr_point_inactive" },
    });
    await app!.close();

    s = await start();
    const q = (await s.http().post("/admin/qr-points").send({ type: "region", label: "Стенд" }).expect(201))
      .body as Point;
    const res = await s.http().get(`/admin/qr-points/${q.id}/print`).expect(409);
    expect((res.body as ErrorEnvelope).error).toMatchObject({
      code: "CONFLICT",
      messageKey: "errors.qr.botUsernameMissing",
      details: { reason: "bot_username_not_configured" },
    });
  });

  it("неверный id — 400; несуществующий — 404", async () => {
    const { http } = await start();
    await http().get("/admin/qr-points/not-a-uuid").expect(400);
    await http().get(`/admin/qr-points/${USER}`).expect(404);
  });
});
