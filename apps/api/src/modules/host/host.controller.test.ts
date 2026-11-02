// Unit (без БД): HTTP-контракт блока 5 (ADR-0020) — «Про заклад», заявки гостя, экран персонала, админка отеля:
// валидация, 401 без сессии, 403 без права, флаг module.host_requests (выключен — 404), передача параметров
// сервису. Сервис подменён; изоляция отелей и RLS — test/integration/host.test.ts.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { ErrorEnvelope } from "@tg/shared";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import { FeatureFlagsModule, FeatureFlagsService } from "../feature-flags/index.js";
import { RATE_LIMIT_RULE } from "../rate-limit/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
  type Grant,
} from "../rbac/index.js";
import { SERVICE_REQUEST_RATE_LIMIT, ServiceRequestsController } from "./host.controller.js";
import { HostRequestsModule } from "./host.module.js";
import { HostService } from "./host.service.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";
const REQ = "0190f5c2-7d3e-7000-8000-0000000000c1";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function fakeService() {
  return {
    guestModule: vi.fn(() => Promise.resolve({ placeId: PLACE })),
    createRequest: vi.fn(() => Promise.resolve({ id: REQ })),
    myRequests: vi.fn(() => Promise.resolve({ items: [] })),
    cancel: vi.fn(() => Promise.resolve({ id: REQ })),
    staffPlaces: vi.fn(() => Promise.resolve({ items: [] })),
    staffList: vi.fn(() => Promise.resolve({ items: [] })),
    staffUpdate: vi.fn(() => Promise.resolve({ id: REQ })),
    adminGetModule: vi.fn(() => Promise.resolve({ placeId: PLACE })),
    adminPutModule: vi.fn(() => Promise.resolve({ placeId: PLACE })),
    adminStaff: vi.fn(() => Promise.resolve({ items: [] })),
    adminAssignStaff: vi.fn(() => Promise.resolve({ assignmentId: REQ })),
    adminRevokeStaff: vi.fn(() => Promise.resolve()),
  };
}

const regionAdmin: Grant = {
  id: "0190f5c2-7d3e-7000-8000-0000000000a9",
  role: "REGION_ADMIN",
  scopeType: "REGION",
  scopeId: REGION,
  regionId: REGION,
  validUntil: null,
};

async function start(opts: { authenticated?: boolean; grants?: Grant[]; flagOn?: boolean } = {}) {
  const service = fakeService();
  const { db } = recordingDb({});
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      FeatureFlagsModule.forRoot({ appEnv: "local" }),
      HostRequestsModule.forRoot(),
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => (opts.authenticated ? { userId: USER } : undefined) })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve(opts.grants ?? []) })
    .overrideProvider(FeatureFlagsService)
    .useValue({ isEnabled: () => Promise.resolve(opts.flagOn ?? true) })
    .overrideProvider(HostService)
    .useValue(service)
    .compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  return { http: () => request(app!.getHttpServer()), service };
}

const fields = (body: unknown) =>
  ((body as ErrorEnvelope).error.details as { fields?: { field: string }[] } | undefined)?.fields?.map(
    (f) => f.field,
  );

describe("GET /host/{placeId}/module", () => {
  it("без сессии; regionId обязателен; entryContextId — uuid; параметры — сервису", async () => {
    const { http, service } = await start();
    expect(fields((await http().get(`/host/${PLACE}/module`).expect(400)).body)).toEqual(["regionId"]);
    await http().get(`/host/nope/module?regionId=${REGION}`).expect(400);
    await http().get(`/host/${PLACE}/module?regionId=${REGION}&entryContextId=x`).expect(400);
    await http().get(`/host/${PLACE}/module?regionId=${REGION}&entryContextId=${REQ}`).expect(200);
    expect(service.guestModule).toHaveBeenCalledWith(REGION, PLACE, REQ);
  });

  it("флаг module.host_requests выключен — 404", async () => {
    const { http, service } = await start({ flagOn: false });
    await http().get(`/host/${PLACE}/module?regionId=${REGION}`).expect(404);
    expect(service.guestModule).not.toHaveBeenCalled();
  });
});

describe("POST /service-requests, /me/service-requests", () => {
  const body = { regionId: REGION, placeId: PLACE, serviceCode: "cleaning", roomLabel: "204" };

  it("без сессии — 401", async () => {
    const { http, service } = await start();
    await http().post("/service-requests").send(body).expect(401);
    await http().get(`/me/service-requests?regionId=${REGION}`).expect(401);
    expect(service.createRequest).not.toHaveBeenCalled();
  });

  it("валидация: код услуги, длина комнаты и комментария, лишние поля", async () => {
    const { http } = await start({ authenticated: true });
    expect(
      fields(
        (
          await http()
            .post("/service-requests")
            .send({ ...body, serviceCode: "Bad Code" })
        ).body,
      ),
    ).toEqual(["serviceCode"]);
    await http()
      .post("/service-requests")
      .send({ ...body, roomLabel: "x".repeat(21) })
      .expect(400);
    await http()
      .post("/service-requests")
      .send({ ...body, comment: "x".repeat(501) })
      .expect(400);
    await http()
      .post("/service-requests")
      .send({ ...body, status: "done" })
      .expect(400);
  });

  it("создание и «Мої заявки» — от пользователя сессии; отмена — с регионом из тела", async () => {
    const { http, service } = await start({ authenticated: true });
    await http().post("/service-requests").send(body).expect(201, { id: REQ });
    expect(service.createRequest).toHaveBeenCalledWith(USER, expect.objectContaining(body));
    await http().get(`/me/service-requests?regionId=${REGION}`).expect(200);
    expect(service.myRequests).toHaveBeenCalledWith(REGION, USER);
    await http().post(`/me/service-requests/${REQ}/cancel`).send({ regionId: REGION }).expect(200);
    expect(service.cancel).toHaveBeenCalledWith(
      REGION,
      USER,
      REQ,
      expect.objectContaining({ actor: { type: "user", userId: USER } }),
    );
  });

  it("rate limit на создание — свой лимит эндпоинта", () => {
    expect(Reflect.getMetadata(RATE_LIMIT_RULE, ServiceRequestsController.prototype.create)).toEqual(
      SERVICE_REQUEST_RATE_LIMIT,
    );
  });
});

describe("/staff", () => {
  it("без сессии — 401; статус — только из списка персонала; фильтр — параметры сервису", async () => {
    const { http, service } = await start({ authenticated: true });
    await http().get(`/staff/service-requests?status=new&placeId=${PLACE}`).expect(200);
    expect(service.staffList).toHaveBeenCalledWith(USER, { status: "new", placeId: PLACE });
    await http().get("/staff/service-requests?status=bogus").expect(400);
    await http()
      .patch(`/staff/service-requests/${REQ}/status`)
      .send({ status: "cancelled_by_guest" })
      .expect(400);
    await http().patch(`/staff/service-requests/${REQ}/status`).send({ status: "new" }).expect(400);
    await http()
      .patch(`/staff/service-requests/${REQ}/status`)
      .send({ status: "rejected", reason: "Немає вільного персоналу" })
      .expect(200);
    expect(service.staffUpdate).toHaveBeenCalledWith(
      USER,
      REQ,
      { status: "rejected", reason: "Немає вільного персоналу" },
      expect.anything(),
    );
    await http().get("/staff/places").expect(200);

    const anon = await start();
    await anon.http().get("/staff/service-requests").expect(401);
  });
});

describe("админка отеля", () => {
  const put = {
    hours: { from: "08:00", to: "22:00" },
    sections: [{ kind: "rules", title: { uk: "Правила" }, content: { uk: "Тиша з 22:00" } }],
    services: [{ code: "towels", title: { uk: "Рушники" }, slaMinutes: 30 }],
  };

  it("без права — 403; турист с сессией без назначений — 403", async () => {
    const { http, service } = await start({ authenticated: true });
    await http().get(`/admin/places/${PLACE}/host-module`).expect(403);
    await http().get(`/admin/places/${PLACE}/staff`).expect(403);
    expect(service.adminGetModule).not.toHaveBeenCalled();
  });

  it("REGION_ADMIN: PUT настроек с валидацией часов и SLA; назначение — telegramUserId или username", async () => {
    const { http, service } = await start({ authenticated: true, grants: [regionAdmin] });
    await http().get(`/admin/places/${PLACE}/host-module`).expect(200);
    await http().put(`/admin/places/${PLACE}/host-module`).send(put).expect(200);
    expect(service.adminPutModule).toHaveBeenCalledWith(
      PLACE,
      expect.objectContaining(put),
      expect.anything(),
    );
    await http()
      .put(`/admin/places/${PLACE}/host-module`)
      .send({ ...put, hours: { from: "8:00", to: "22:00" } })
      .expect(400);
    await http()
      .put(`/admin/places/${PLACE}/host-module`)
      .send({ ...put, services: [{ code: "towels", title: { uk: "Рушники" }, slaMinutes: 1 }] })
      .expect(400);
    await http().post(`/admin/places/${PLACE}/staff`).send({}).expect(400);
    await http().post(`/admin/places/${PLACE}/staff`).send({ telegramUserId: "123456789" }).expect(201);
    await http()
      .post(`/admin/places/${PLACE}/staff`)
      .send({ username: "@hotel_staff", role: "ORG_OWNER" })
      .expect(201);
    await http()
      .post(`/admin/places/${PLACE}/staff`)
      .send({ username: "hotel_staff", role: "REGION_ADMIN" })
      .expect(400);
    await http().delete(`/admin/places/${PLACE}/staff/${REQ}`).expect(204);
    expect(service.adminRevokeStaff).toHaveBeenCalledWith(PLACE, REQ, expect.anything());
  });
});
