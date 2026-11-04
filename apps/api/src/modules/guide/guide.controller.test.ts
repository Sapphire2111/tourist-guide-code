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
import { RATE_LIMIT_RULE, RateLimitModule } from "../rate-limit/index.js";
import { GuidePlacesController, SEARCH_RATE_LIMIT } from "./guide.controller.js";
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
    localities: vi.fn(() => Promise.resolve({ items: [] })),
    search: vi.fn(() => Promise.resolve({ items: [], nextOffset: null, radiusMeters: null })),
    tagCounts: vi.fn(() => Promise.resolve({ items: [] })),
    place: vi.fn((_r: string, id: string) => Promise.resolve(id === PLACE ? { id } : undefined)),
    favorites: vi.fn(() => Promise.resolve({ items: [] })),
    addFavorite: vi.fn((_r: string, _u: string, placeId: string) =>
      Promise.resolve(placeId === PLACE ? { placeId, createdAt: "2026-11-02T10:00:00.000Z" } : undefined),
    ),
    removeFavorite: vi.fn(() => Promise.resolve()),
    emergencyContacts: vi.fn(() => Promise.resolve([])),
    cover: vi.fn((_r: string, id: string, notModified?: (etag: string) => boolean) =>
      Promise.resolve(
        id === PLACE
          ? {
              bytes: notModified?.("abc123") ? null : Buffer.from("RIFFwebp"),
              mime: "image/webp",
              etag: "abc123",
            }
          : undefined,
      ),
    ),
    googlePhoto: vi.fn((_r: string, id: string, index: number) =>
      Promise.resolve(
        id === PLACE && index === 0 ? "https://lh3.googleusercontent.com/p/abc=w400" : undefined,
      ),
    ),
  };
}

async function start(opts: { authenticated?: boolean; perEndpoint?: number } = {}) {
  const service = fakeService();
  const { db, queries } = recordingDb({});
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      ...(opts.perEndpoint
        ? [RateLimitModule.forRoot({ perEndpoint: { limit: opts.perEndpoint, windowSec: 60 } })]
        : []),
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
    // Публичный кеш — только успешному ответу: ошибка не кешируется.
    expect(res.headers["cache-control"]).toBe("no-store");
    const bad = await http().get("/emergency-contacts?regionId=nope").expect(400);
    expect(bad.headers["cache-control"]).toBe("no-store");
  });

  it("429 (rate limit) — без публичного кеша", async () => {
    const { http } = await start({ perEndpoint: 1 });
    await http().get(`/categories?regionId=${REGION}`).expect(200);
    const res = await http().get(`/categories?regionId=${REGION}`).expect(429);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("GET /places/search", () => {
  it("tags (удобства «Де жити», И): через запятую и повтором; пусто — без фильтра; не код тега или больше 10 — 400", async () => {
    const { http, service } = await start();
    await http().get(`/places/search?regionId=${REGION}&tags=pool,hot-tub&tags=sauna`).expect(200);
    expect(service.search).toHaveBeenLastCalledWith(
      REGION,
      expect.objectContaining({ tagCodes: ["pool", "hot-tub", "sauna"] }),
    );
    await http().get(`/places/search?regionId=${REGION}`).expect(200);
    expect(service.search).toHaveBeenLastCalledWith(REGION, expect.objectContaining({ tagCodes: undefined }));
    await http().get(`/places/search?regionId=${REGION}&tags=Pool`).expect(400);
    await http().get(`/places/search?regionId=${REGION}&tags=pool%27--`).expect(400);
    const many = Array.from({ length: 11 }, (_, i) => `t${i}`).join(",");
    await http().get(`/places/search?regionId=${REGION}&tags=${many}`).expect(400);
  });

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

  it("радиус 15 км и лимит 300 доходят до сервиса без клэмпа (карта «Що поруч» на всём круге)", async () => {
    const { http, service } = await start();
    await http().get(`/places/search?regionId=${REGION}&lat=48&lng=24&radius=15000&limit=300`).expect(200);
    expect(service.search).toHaveBeenLastCalledWith(
      REGION,
      expect.objectContaining({ radius: 15_000, limit: 300 }),
    );
  });

  it("exclude_section: список через запятую и повтором; пустое — как без него; чужое значение и лишние — 400", async () => {
    const { http, service } = await start();
    await http().get(`/places/search?regionId=${REGION}&exclude_section=stay,help`).expect(200);
    expect(service.search).toHaveBeenLastCalledWith(
      REGION,
      expect.objectContaining({ excludeSections: ["stay", "help"] }),
    );
    await http()
      .get(`/places/search?regionId=${REGION}&exclude_section=stay&exclude_section=eat`)
      .expect(200);
    expect(service.search).toHaveBeenLastCalledWith(
      REGION,
      expect.objectContaining({ excludeSections: ["stay", "eat"] }),
    );
    await http().get(`/places/search?regionId=${REGION}&exclude_section=`).expect(200);
    expect(service.search).toHaveBeenLastCalledWith(
      REGION,
      expect.objectContaining({ excludeSections: undefined }),
    );
    await http().get(`/places/search?regionId=${REGION}&exclude_section=hotels`).expect(400);
    const many = Array.from({ length: 20 }, () => "stay").join(",");
    await http().get(`/places/search?regionId=${REGION}&exclude_section=${many}`).expect(400);
  });

  it("localityIds — повтор параметра и через запятую; пусто — без фильтра; больше 10 или не uuid — 400", async () => {
    const { http, service } = await start();
    const A = "0190f5c2-7d3e-7000-8000-0000000000c1";
    const B = "0190f5c2-7d3e-7000-8000-0000000000c2";
    await http().get(`/places/search?regionId=${REGION}&localityIds=${A}&localityIds=${B}`).expect(200);
    expect(service.search).toHaveBeenLastCalledWith(REGION, expect.objectContaining({ localityIds: [A, B] }));
    // С локациями точка — без радиуса по умолчанию; явный радиус — применяется.
    await http().get(`/places/search?regionId=${REGION}&lat=48&lng=24&localityIds=${A}`).expect(200);
    expect(service.search).toHaveBeenLastCalledWith(
      REGION,
      expect.objectContaining({ origin: { lon: 24, lat: 48 }, radius: undefined, localityIds: [A] }),
    );
    await http()
      .get(`/places/search?regionId=${REGION}&lat=48&lng=24&radius=900&localityIds=${A}`)
      .expect(200);
    expect(service.search).toHaveBeenLastCalledWith(REGION, expect.objectContaining({ radius: 900 }));
    await http().get(`/places/search?regionId=${REGION}&localityIds=${A},${B}`).expect(200);
    expect(service.search).toHaveBeenLastCalledWith(REGION, expect.objectContaining({ localityIds: [A, B] }));
    await http().get(`/places/search?regionId=${REGION}&localityIds=`).expect(200);
    expect((service.search.mock.lastCall as unknown[] | undefined)?.[1]).toMatchObject({
      localityIds: undefined,
    });
    service.search.mockClear();
    await http().get(`/places/search?regionId=${REGION}&localityIds=nope`).expect(400);
    await http()
      .get(`/places/search?regionId=${REGION}&localityIds=${Array.from({ length: 11 }, () => A).join(",")}`)
      .expect(400);
    expect(service.search).not.toHaveBeenCalled();
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
      "limit=301",
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

describe("GET /localities", () => {
  it("регион обязателен; список — из сервиса", async () => {
    const { http, service } = await start();
    await http().get(`/localities`).expect(400);
    await http().get(`/localities?regionId=${REGION}`).expect(200);
    expect(service.localities).toHaveBeenCalledWith(REGION);
  });
});

it("поиск — свой rate limit 60/мин (ILIKE без индекса)", () => {
  expect(SEARCH_RATE_LIMIT).toEqual({ limit: 60, windowSec: 60 });
  expect(Reflect.getMetadata(RATE_LIMIT_RULE, GuidePlacesController.prototype.search)).toBe(
    SEARCH_RATE_LIMIT,
  );
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

describe("GET /places/{id}/cover", () => {
  it("WebP с ETag и долгим публичным кэшем; If-None-Match — 304; нет обложки — 404", async () => {
    const { http } = await start();
    const res = await http().get(`/places/${PLACE}/cover?regionId=${REGION}&v=abc123`).expect(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers.etag).toBe('"abc123"');
    expect(res.headers["cache-control"]).toBe("public, max-age=604800");
    expect(Buffer.from(res.body as Buffer).toString()).toBe("RIFFwebp");
    await http()
      .get(`/places/${PLACE}/cover?regionId=${REGION}`)
      .set("If-None-Match", '"abc123"')
      .expect(304);
    for (const h of ['W/"abc123"', '"old", W/"abc123"', "*"])
      await http().get(`/places/${PLACE}/cover?regionId=${REGION}`).set("If-None-Match", h).expect(304);
    await http().get(`/places/${PLACE}/cover?regionId=${REGION}`).set("If-None-Match", '"old"').expect(200);
    const missing = await http()
      .get(`/places/0190f5c2-7d3e-7000-8000-0000000000b2/cover?regionId=${REGION}`)
      .expect(404);
    expect(missing.headers["cache-control"]).not.toContain("public");
  });
});

describe("GET /places/{id}/google-photos/{index}", () => {
  it("302 на файл Google с публичным кешем; ширина по умолчанию 400, 1200 — по запросу", async () => {
    const { http, service } = await start();
    const res = await http().get(`/places/${PLACE}/google-photos/0?regionId=${REGION}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://lh3.googleusercontent.com/p/abc=w400");
    expect(res.headers["cache-control"]).toBe("public, max-age=21600");
    expect(service.googlePhoto).toHaveBeenCalledWith(REGION, PLACE, 0, 400);
    await http().get(`/places/${PLACE}/google-photos/0?regionId=${REGION}&w=1200`).expect(302);
    expect(service.googlePhoto).toHaveBeenLastCalledWith(REGION, PLACE, 0, 1200);
  });

  it("нет фото — 404 без публичного кеша; неверные w/index/id — 400", async () => {
    const { http } = await start();
    const missing = await http().get(`/places/${PLACE}/google-photos/1?regionId=${REGION}`).expect(404);
    expect(missing.headers["cache-control"]).not.toContain("public");
    await http().get(`/places/${PLACE}/google-photos/9?regionId=${REGION}`).expect(404);
    await http().get(`/places/${PLACE}/google-photos/0?regionId=${REGION}&w=800`).expect(400);
    await http().get(`/places/${PLACE}/google-photos/x?regionId=${REGION}`).expect(400);
    await http().get(`/places/not-a-uuid/google-photos/0?regionId=${REGION}`).expect(400);
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
    service.addFavorite.mockRejectedValueOnce(
      new ApiError("CONFLICT", {
        messageKey: "errors.favorites.limitReached",
        details: { reason: "favorites_limit" },
      }),
    );
    const full = await http().post("/favorites").send({ regionId: REGION, placeId: PLACE }).expect(409);
    expect((full.body as ErrorEnvelope).error.messageKey).toBe("errors.favorites.limitReached");
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

describe("GET /places/tag-counts", () => {
  it("категория и пункты доходят до сервиса; маршрут не путается с /places/:id; regionId обязателен", async () => {
    const { http, service } = await start();
    const A = "0190f5c2-7d3e-7000-8000-0000000000c1";
    await http().get(`/places/tag-counts?regionId=${REGION}&category=${PLACE}&localityIds=${A}`).expect(200);
    expect(service.tagCounts).toHaveBeenLastCalledWith(REGION, { categoryId: PLACE, localityIds: [A] });
    await http().get(`/places/tag-counts?regionId=${REGION}`).expect(200);
    expect(service.tagCounts).toHaveBeenLastCalledWith(REGION, {
      categoryId: undefined,
      localityIds: undefined,
    });
    expect(service.place).not.toHaveBeenCalled();
    await http().get(`/places/tag-counts`).expect(400);
    await http().get(`/places/tag-counts?regionId=${REGION}&category=x`).expect(400);
  });
});
