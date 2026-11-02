// Unit (без БД): HTTP-контракт публичного каталога туриста (блок 4, ADR-0019) — валидация query (регион, точка
// парой, радиус, лимиты), передача параметров сервису, 404 и избранное только с сессией. Сервис подменён; выборки
// PostGIS, RLS и «неопубликованные не видны» — test/integration/guide.test.ts.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { ErrorEnvelope } from "@tg/shared";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { ApiError } from "../../common/http/index.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
} from "../rbac/index.js";
import { likeContains } from "./guide.repository.js";
import { GuideModule } from "./guide.module.js";
import { GuideService } from "./guide.service.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function fakeService() {
  return {
    categories: vi.fn(() => Promise.resolve({ items: [] })),
    search: vi.fn(() => Promise.resolve({ items: [], nextOffset: null, radiusMeters: null })),
    place: vi.fn((_r: string, id: string) => Promise.resolve(id === PLACE ? { id } : undefined)),
    favorites: vi.fn(() => Promise.resolve({ items: [] })),
    addFavorite: vi.fn((_r: string, _u: string, placeId: string) =>
      Promise.resolve(placeId === PLACE ? { placeId, createdAt: "2026-11-02T10:00:00.000Z" } : undefined),
    ),
    removeFavorite: vi.fn(() => Promise.resolve()),
    emergencyContacts: vi.fn(() => Promise.resolve([])),
  };
}

async function start(opts: { authenticated?: boolean } = {}) {
  const service = fakeService();
  const { db, queries } = recordingDb({});
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      GuideModule,
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => (opts.authenticated ? { userId: USER } : undefined) })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve([]) })
    .overrideProvider(GuideService)
    .useValue(service)
    .compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  return { http: () => request(app!.getHttpServer()), service, queries };
}

const fields = (body: unknown) =>
  ((body as ErrorEnvelope).error.details as { fields?: { field: string }[] } | undefined)?.fields?.map(
    (f) => f.field,
  );

describe("GET /categories, /emergency-contacts", () => {
  it("regionId обязателен и uuid; ответ кешируется публично", async () => {
    const { http, service } = await start();
    expect(fields((await http().get("/categories").expect(400)).body)).toEqual(["regionId"]);
    await http().get("/categories?regionId=nope").expect(400);
    const res = await http().get(`/categories?regionId=${REGION}`).expect(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(service.categories).toHaveBeenCalledWith(REGION);
    await http().get(`/emergency-contacts?regionId=${REGION}`).expect(200, { items: [] });
  });

  it("404 сервиса (регион не активен) — конверт NOT_FOUND", async () => {
    const { http, service } = await start();
    service.categories.mockRejectedValueOnce(new ApiError("NOT_FOUND"));
    const res = await http().get(`/categories?regionId=${REGION}`).expect(404);
    expect((res.body as ErrorEnvelope).error.code).toBe("NOT_FOUND");
  });
});

describe("GET /places/search", () => {
  it("без точки — весь регион: радиус не применяется, лимит и сдвиг по умолчанию, q обрезан", async () => {
    const { http, service } = await start();
    await http().get(`/places/search?regionId=${REGION}&q=%20кава%20&radius=1000`).expect(200);
    expect(service.search).toHaveBeenCalledWith(REGION, {
      origin: undefined,
      radius: undefined,
      categoryId: undefined,
      text: "кава",
      limit: 20,
      offset: 0,
    });
  });

  it("с точкой — радиус 500 м по умолчанию; категория, лимит, offset, available_now принимается и игнорируется", async () => {
    const { http, service } = await start();
    await http()
      .get(
        `/places/search?regionId=${REGION}&lat=48.4475&lng=24.5626&category=${PLACE}&limit=5&offset=10&available_now=true`,
      )
      .expect(200);
    expect(service.search).toHaveBeenCalledWith(REGION, {
      origin: { lon: 24.5626, lat: 48.4475 },
      radius: 500,
      categoryId: PLACE,
      text: undefined,
      limit: 5,
      offset: 10,
    });
  });

  it("lat без lng (и наоборот) — 400 по недостающему полю; вне диапазонов — 400", async () => {
    const { http, service } = await start();
    expect(fields((await http().get(`/places/search?regionId=${REGION}&lat=48`).expect(400)).body)).toEqual([
      "lng",
    ]);
    expect(fields((await http().get(`/places/search?regionId=${REGION}&lng=24`).expect(400)).body)).toEqual([
      "lat",
    ]);
    for (const bad of [
      "lat=91&lng=0",
      "lat=0&lng=181",
      "lat=x&lng=1",
      "lat=1&lng=1&radius=5",
      "lat=1&lng=1&radius=20001",
      "limit=0",
      "limit=51",
      "offset=-1",
      "offset=1001",
      "q=a",
      "category=nope",
      "available_now=maybe",
      "unknown=1",
    ])
      await http().get(`/places/search?regionId=${REGION}&${bad}`).expect(400);
    expect(service.search).not.toHaveBeenCalled();
  });
});

describe("GET /places/{id}", () => {
  it("карточка; не найдено (в т. ч. неопубликованное) — 404; без сессии favorite не спрашивается", async () => {
    const { http, service } = await start();
    await http().get(`/places/${PLACE}?regionId=${REGION}&lat=48.1&lng=24.1`).expect(200, { id: PLACE });
    expect(service.place).toHaveBeenCalledWith(REGION, PLACE, {
      origin: { lon: 24.1, lat: 48.1 },
      userId: undefined,
    });
    await http().get(`/places/${REGION}?regionId=${REGION}`).expect(404);
    await http().get(`/places/nope?regionId=${REGION}`).expect(400);
  });

  it("с сессией — userId для признака favorite", async () => {
    const { http, service } = await start({ authenticated: true });
    await http().get(`/places/${PLACE}?regionId=${REGION}`).expect(200);
    expect(service.place).toHaveBeenCalledWith(REGION, PLACE, { origin: undefined, userId: USER });
  });
});

describe("/favorites", () => {
  it("без сессии — 401 на все методы", async () => {
    const { http, service } = await start();
    await http().get(`/favorites?regionId=${REGION}`).expect(401);
    await http().post("/favorites").send({ regionId: REGION, placeId: PLACE }).expect(401);
    await http().delete(`/favorites/${PLACE}?regionId=${REGION}`).expect(401);
    expect(service.favorites).not.toHaveBeenCalled();
    expect(service.addFavorite).not.toHaveBeenCalled();
  });

  it("список, добавление (201; места нет — 404), удаление (204)", async () => {
    const { http, service } = await start({ authenticated: true });
    await http().get(`/favorites?regionId=${REGION}`).expect(200, { items: [] });
    expect(service.favorites).toHaveBeenCalledWith(REGION, USER);
    await http()
      .post("/favorites")
      .send({ regionId: REGION, placeId: PLACE })
      .expect(201, { placeId: PLACE, createdAt: "2026-11-02T10:00:00.000Z" });
    await http().post("/favorites").send({ regionId: REGION, placeId: REGION }).expect(404);
    await http().post("/favorites").send({ placeId: PLACE }).expect(400);
    await http().delete(`/favorites/${PLACE}?regionId=${REGION}`).expect(204);
    expect(service.removeFavorite).toHaveBeenCalledWith(REGION, USER, PLACE);
  });
});

describe("likeContains", () => {
  it("экранирует % _ \\ — текст ищется буквально", () => {
    expect(likeContains("кава")).toBe("%кава%");
    expect(likeContains("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});
