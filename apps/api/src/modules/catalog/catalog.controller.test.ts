// Unit (без БД): админка каталога (блок 3, ADR-0017). Главное — изоляция регионов (ТЗ §16.2, приёмка блока 3):
// регион-админ региона A не видит и не меняет данные региона B ни через один admin-эндпоинт (список, чтение по id,
// изменение). Запросы строят настоящие репозитории и TenantGuardPlugin (фильтр region_id), отвечают таблицы в памяти
// (test/support/memory-sql.ts): если бы фильтр не добавился, строки B попали бы в ответ. RLS — integration
// (test/integration/catalog.test.ts). Плюс права ролей, публикация (422 с причинами), бейдж и аудит.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { ErrorEnvelope } from "@tg/shared";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { memorySql, type MemTables } from "../../../test/support/memory-sql.js";
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
} from "../rbac/index.js";
import { CatalogModule } from "./catalog.module.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const id = (region: "a" | "b", n: number) =>
  `0190f5c2-7d3e-7000-8${region === "a" ? "00a" : "00b"}-${String(n).padStart(12, "0")}`;

const grant = (role: string, scopeType: Grant["scopeType"], regionId: string | null): Grant => ({
  id: "0190f5c2-7d3e-7000-8000-0000000001aa",
  role,
  scopeType,
  scopeId: regionId,
  regionId,
  validUntil: null,
});
const REGION_ADMIN_A = grant("REGION_ADMIN", "REGION", A);
const MODERATOR_A = grant("MODERATOR", "REGION", A);
const SUPERADMIN = grant("SUPERADMIN", "PLATFORM", null);

const NAME = (uk: string) => ({ uk });
const T0 = new Date("2026-11-01T10:00:00Z");

/** Данные двух регионов: по населённому пункту, категории, тегу, месту (с фото и историей бейджа). */
function tables(): MemTables {
  const rows: MemTables = {
    regions: [],
    localities: [],
    categories: [],
    tags: [],
    places: [],
    place_tags: [],
    place_media: [],
    media_assets: [],
    place_badge_events: [],
    place_schedules: [],
    place_schedule_exceptions: [],
    audit_logs: [],
  };
  for (const [key, region] of [
    ["a", A],
    ["b", B],
  ] as const) {
    const base = { region_id: region, created_at: T0, updated_at: T0 };
    rows.regions!.push({
      id: region,
      code: `region-${key}`,
      name_i18n: NAME(`Регіон ${key}`),
      status: "active",
      timezone: "Europe/Kyiv",
      default_language: "uk",
      created_at: T0,
      updated_at: T0,
    });
    rows.localities!.push({
      ...base,
      id: id(key, 1),
      code: `town-${key}`,
      kind: "settlement",
      name_i18n: NAME(`Село ${key}`),
      location: null,
      sort_order: 0,
      active: true,
    });
    rows.categories!.push({
      ...base,
      id: id(key, 2),
      parent_id: null,
      code: `eat-${key}`,
      name_i18n: NAME(`Де поїсти ${key}`),
      icon: null,
      home_section: "eat",
      sort_order: 0,
      active: true,
    });
    rows.tags!.push({
      ...base,
      id: id(key, 3),
      code: `kids-${key}`,
      name_i18n: NAME(`З дітьми ${key}`),
      tag_group: "audience",
      sort_order: 0,
      active: true,
    });
    rows.places!.push({
      ...base,
      id: id(key, 4),
      category_id: id(key, 2),
      locality_id: id(key, 1),
      name_i18n: NAME(`Кафе ${key}`),
      description_i18n: NAME("Опис"),
      address_i18n: NAME("Адреса"),
      location: { lon: 24.5, lat: 48.4 },
      phone: null,
      website: null,
      telegram: null,
      status: "draft",
      recommended: false,
      verified_at: null,
      first_published_at: null,
      created_by: null,
    });
    rows.media_assets!.push({
      ...base,
      id: id(key, 5),
      kind: "image",
      status: "ready",
      owner_type: "place",
      owner_id: id(key, 4),
      mime: "image/jpeg",
      alt_i18n: null,
    });
    rows.place_media!.push({
      ...base,
      id: id(key, 6),
      place_id: id(key, 4),
      media_asset_id: id(key, 5),
      sort_order: 0,
      is_cover: true,
    });
  }
  return rows;
}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(grants: Grant[], selectedRegion: string | null = null) {
  const data = tables();
  const { db, queries } = recordingDb({}, memorySql(data));
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      CatalogModule,
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => ({ userId: USER, sessionId: "s1", regionId: selectedRegion }) })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve(grants) })
    .compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  return { server: app.getHttpServer(), data, queries };
}

const errorOf = (res: request.Response) => (res.body as ErrorEnvelope).error;

/** Снимок строк региона B — после попыток админа A он не должен измениться. */
const snapshotB = (data: MemTables) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(data).map(([t, rows]) => [t, rows.filter((r) => r.region_id === B || r.id === B)]),
    ),
  );

describe("изоляция регионов: регион-админ A и данные региона B", () => {
  // Эндпоинты с объектом региона B в пути: каждый — 404 (объекта нет в контексте A), данные B не меняются.
  const P = id("b", 4);
  const M = id("b", 5);
  const byIdOfB: [string, string, Record<string, unknown>?][] = [
    ["get", `/admin/localities/${id("b", 1)}`],
    ["patch", `/admin/localities/${id("b", 1)}`, { name: NAME("Чуже") }],
    ["delete", `/admin/localities/${id("b", 1)}`],
    ["get", `/admin/categories/${id("b", 2)}`],
    ["patch", `/admin/categories/${id("b", 2)}`, { active: false }],
    ["delete", `/admin/categories/${id("b", 2)}`],
    ["get", `/admin/tags/${id("b", 3)}`],
    ["patch", `/admin/tags/${id("b", 3)}`, { active: false }],
    ["delete", `/admin/tags/${id("b", 3)}`],
    ["get", `/admin/places/${P}`],
    ["patch", `/admin/places/${P}`, { name: NAME("Чуже") }],
    ["delete", `/admin/places/${P}`],
    ["get", `/admin/places/${P}/publish-check`],
    ["post", `/admin/places/${P}/publish`, {}],
    ["post", `/admin/places/${P}/suspend`, {}],
    ["post", `/admin/places/${P}/archive`, {}],
    ["get", `/admin/places/${P}/schedule`],
    ["put", `/admin/places/${P}/schedule`, { weekly: [], exceptions: [] }],
    ["get", `/admin/places/${P}/media`],
    ["post", `/admin/places/${P}/media`, { mediaAssetId: M }],
    ["patch", `/admin/places/${P}/media/${M}`, { alt: NAME("Чуже") }],
    ["delete", `/admin/places/${P}/media/${M}`],
    ["post", `/admin/places/${P}/badge`, { reason: "чужий" }],
    ["delete", `/admin/places/${P}/badge`, { reason: "чужий" }],
    ["get", `/admin/places/${P}/badge/history`],
  ];

  it.each(byIdOfB)("%s %s → 404, данные B не изменились", async (method, path, body) => {
    const { server, data } = await start([REGION_ADMIN_A]);
    const before = snapshotB(data);
    const req = request(server)[method as "get"](path);
    const res = await (body ? req.send(body) : req);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(snapshotB(data)).toBe(before);
    // Аудит не пишется: изменения не было.
    expect(data.audit_logs).toEqual([]);
  });

  it.each([
    ["/admin/localities", id("a", 1)],
    ["/admin/categories", id("a", 2)],
    ["/admin/tags", id("a", 3)],
    ["/admin/places", id("a", 4)],
  ])("список %s — только записи региона A", async (path, own) => {
    const { server, queries } = await start([REGION_ADMIN_A]);
    const res = await request(server).get(path);
    expect(res.status).toBe(200);
    expect((res.body as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([own]);
    // Фильтр поставил TenantGuardPlugin: регион A параметром, B — нигде.
    const list = queries.find((q) => /^select/.test(q.sql) && q.sql.includes(`from "${path.split("/")[2]}"`));
    expect(list?.parameters).toContain(A);
    expect(queries.flatMap((q) => q.parameters)).not.toContain(B);
  });

  it("свои записи A читаются по id (контроль: 404 выше — не из-за сломанного маршрута)", async () => {
    const { server } = await start([REGION_ADMIN_A]);
    for (const path of [
      `/admin/localities/${id("a", 1)}`,
      `/admin/categories/${id("a", 2)}`,
      `/admin/tags/${id("a", 3)}`,
      `/admin/places/${id("a", 4)}`,
      `/admin/places/${id("a", 4)}/media`,
      `/admin/places/${id("a", 4)}/schedule`,
    ])
      expect((await request(server).get(path)).status, path).toBe(200);
  });

  it("регионы: список — только свой; чужой регион по id и его правка — 403; создание и статус — 403", async () => {
    const { server, data } = await start([REGION_ADMIN_A]);
    const list = await request(server).get("/admin/regions");
    expect(list.status).toBe(200);
    expect((list.body as { items: { id: string }[] }).items.map((r) => r.id)).toEqual([A]);
    expect((await request(server).get(`/admin/regions/${B}`)).status).toBe(403);
    expect(
      (
        await request(server)
          .patch(`/admin/regions/${B}`)
          .send({ name: NAME("Чужий") })
      ).status,
    ).toBe(403);
    expect(
      (await request(server).put(`/admin/regions/${B}/status`).send({ status: "suspended" })).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .post("/admin/regions")
          .send({ code: "new-region", name: NAME("Новий") })
      ).status,
    ).toBe(403);
    expect(data.regions!.find((r) => r.id === B)!.name_i18n).toEqual(NAME("Регіон b"));
    // Свой регион правится, аудит — с регионом A.
    const own = await request(server).patch(`/admin/regions/${A}`).send({ timezone: "Europe/Warsaw" });
    expect(own.status).toBe(200);
    expect(data.audit_logs!.map((l) => [l.action, l.region_id])).toEqual([["region.settings.edit", A]]);
  });

  it("место в A со ссылкой на категорию, населённый пункт или тег региона B — 422", async () => {
    const { server, data } = await start([REGION_ADMIN_A]);
    for (const body of [
      { categoryId: id("b", 2), name: NAME("Х") },
      { categoryId: id("a", 2), localityId: id("b", 1), name: NAME("Х") },
      { categoryId: id("a", 2), tagIds: [id("b", 3)], name: NAME("Х") },
    ]) {
      const res = await request(server).post("/admin/places").send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(errorOf(res).messageKey).toBe("errors.catalog.invalidReference");
    }
    expect(data.places).toHaveLength(2);
  });

  it("фото региона B не привязывается к месту региона A", async () => {
    const { server } = await start([REGION_ADMIN_A]);
    const res = await request(server)
      .post(`/admin/places/${id("a", 4)}/media`)
      .send({ mediaAssetId: id("b", 5) });
    expect(res.status).toBe(422);
    expect(errorOf(res).details).toMatchObject({ reason: "media_not_found" });
  });
});

describe("права ролей", () => {
  it("без назначения — 403; MODERATOR читает и приостанавливает, но не создаёт, не публикует и не даёт бейдж", async () => {
    const none = await start([]);
    expect((await request(none.server).get("/admin/places")).status).toBe(403);
    await app!.close();
    app = undefined;

    const { server, data } = await start([MODERATOR_A]);
    expect((await request(server).get("/admin/places")).status).toBe(200);
    expect(
      (
        await request(server)
          .post("/admin/places")
          .send({ categoryId: id("a", 2), name: NAME("Х") })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .post(`/admin/places/${id("a", 4)}/publish`)
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .post(`/admin/places/${id("a", 4)}/badge`)
          .send({ reason: "добре" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .post("/admin/categories")
          .send({ code: "x", name: NAME("Х") })
      ).status,
    ).toBe(403);
    data.places!.find((p) => p.id === id("a", 4))!.status = "published";
    data.places!.find((p) => p.id === id("a", 4))!.first_published_at = T0;
    const res = await request(server)
      .post(`/admin/places/${id("a", 4)}/suspend`)
      .send({ reason: "скарга" });
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("suspended");
  });

  it("SUPERADMIN: без выбранного региона каталог — 403 (нужен регион), с выбранным — работает; создаёт регион", async () => {
    const platform = await start([SUPERADMIN]);
    const res = await request(platform.server).get("/admin/places");
    expect(res.status).toBe(403);
    expect(errorOf(res).messageKey).toBe("errors.catalog.regionRequired");
    const regions = await request(platform.server).get("/admin/regions");
    expect((regions.body as { items: unknown[] }).items).toHaveLength(2);
    const created = await request(platform.server)
      .post("/admin/regions")
      .send({ code: "new-region", name: NAME("Новий регіон"), timezone: "Europe/Kyiv" });
    expect(created.status).toBe(201);
    expect(platform.data.audit_logs!.map((l) => l.action)).toEqual(["region.create"]);
    expect(
      (
        await request(platform.server)
          .post("/admin/regions")
          .send({ code: "bad-tz", name: NAME("Х"), timezone: "Mars/Base" })
      ).status,
    ).toBe(422);
    await app!.close();
    app = undefined;

    const inA = await start([SUPERADMIN], A);
    const list = await request(inA.server).get("/admin/places");
    expect((list.body as { items: { id: string }[] }).items.map((p) => p.id)).toEqual([id("a", 4)]);
  });
});

describe("места: валидация, публикация, бейдж, аудит", () => {
  it("POST без обязательного name — 400; PATCH name: null — 400", async () => {
    const { server } = await start([REGION_ADMIN_A]);
    const created = await request(server)
      .post("/admin/places")
      .send({ categoryId: id("a", 2) });
    expect(created.status).toBe(400);
    expect(errorOf(created).details?.fields?.map((f) => f.field)).toContain("name");
    const patched = await request(server)
      .patch(`/admin/places/${id("a", 4)}`)
      .send({ name: null });
    expect(patched.status).toBe(400);
    const phone = await request(server)
      .patch(`/admin/places/${id("a", 4)}`)
      .send({ phone: "0501234567" });
    expect(phone.status).toBe(400);
  });

  it("доп. категории: подкатегории активных разделов, не основная, лимит; запись manual + аудит; чужой регион и права — отказ", async () => {
    const { server, data } = await start([REGION_ADMIN_A]);
    const place = id("a", 4);
    const sub = (n: number, active = true, parent: string | null = id("a", 2)) => ({
      ...data.categories![0]!,
      id: id("a", 40 + n),
      parent_id: parent,
      code: `sub-${n}`,
      home_section: null,
      active,
    });
    data.categories!.push(sub(1), sub(2), sub(3, false), sub(4, true, null));
    data.place_extra_categories = [
      { region_id: A, place_id: place, category_id: id("a", 41), source: "import", created_at: T0 },
    ];
    const patch = (body: Record<string, unknown>) =>
      request(server).patch(`/admin/places/${place}`).send(body);
    // основная, неактивная, подкатегория чужого региона, неизвестная — 422; больше лимита — 400; список не изменился
    data.categories!.push({ ...sub(5), id: id("b", 45), region_id: B, parent_id: id("b", 2) });
    for (const extraCategoryIds of [[id("a", 2)], [id("a", 43)], [id("b", 45)], [id("a", 99)]]) {
      const res = await patch({ extraCategoryIds });
      expect(res.status, JSON.stringify(extraCategoryIds)).toBe(422);
      expect(errorOf(res).messageKey).toBe("errors.catalog.invalidReference");
    }
    const tooMany = await patch({ extraCategoryIds: [1, 2, 3, 4, 5, 6].map((n) => id("a", 60 + n)) });
    expect(tooMany.status).toBe(400);
    expect(data.place_extra_categories!.map((r) => r.category_id)).toEqual([id("a", 41)]);
    // тот же набор не перезаписывает строки (import остаётся import) и не пишет аудит
    expect((await patch({ extraCategoryIds: [id("a", 41)] })).status).toBe(200);
    expect(data.place_extra_categories!.map((r) => r.source)).toEqual(["import"]);
    expect(data.audit_logs!.filter((l) => l.action === "place.extra_categories.edit")).toHaveLength(0);
    // корневой активный раздел (импорт ставит «Халепа?») — допустим
    expect((await patch({ extraCategoryIds: [id("a", 44)] })).status).toBe(200);
    const ok = await patch({ extraCategoryIds: [id("a", 42)] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as { extraCategoryIds: string[] }).extraCategoryIds).toEqual([id("a", 42)]);
    expect(data.place_extra_categories!.map((r) => [r.category_id, r.source])).toEqual([
      [id("a", 42), "manual"],
    ]);
    const log = data.audit_logs!.filter((l) => l.action === "place.edit").at(-1)!;
    expect(log.old_values).toMatchObject({ extraCategoryIds: [id("a", 44)] });
    expect(log.new_values).toMatchObject({ extraCategoryIds: [id("a", 42)] });
    // без поля список не трогается; пустой массив очищает
    expect((await patch({ phone: null })).status).toBe(200);
    expect(data.place_extra_categories).toHaveLength(1);
    expect((await patch({ extraCategoryIds: [] })).status).toBe(200);
    expect(data.place_extra_categories).toHaveLength(0);
    // Каждое изменение набора оставляет отдельную запись аудита (по ней импорт не трогает набор); без изменений — нет.
    expect(data.audit_logs!.filter((l) => l.action === "place.extra_categories.edit")).toHaveLength(3);
  });

  it("доп. категории: модератор без place.edit — 403", async () => {
    const { server } = await start([MODERATOR_A]);
    const res = await request(server)
      .patch(`/admin/places/${id("a", 4)}`)
      .send({ extraCategoryIds: [] });
    expect(res.status).toBe(403);
  });

  it("публикация без alt text у фото — 422 errors.place.notPublishable с причиной; с alt — published и аудит", async () => {
    const { server, data } = await start([REGION_ADMIN_A]);
    const place = id("a", 4);
    const denied = await request(server).post(`/admin/places/${place}/publish`).send({});
    expect(denied.status).toBe(422);
    expect(errorOf(denied).messageKey).toBe("errors.place.notPublishable");
    expect(errorOf(denied).details).toMatchObject({
      reason: "not_publishable",
      problems: ["media_alt_missing"],
    });
    expect(data.places!.find((p) => p.id === place)!.status).toBe("draft");

    const check = await request(server).get(`/admin/places/${place}/publish-check`);
    expect(check.body).toEqual({ problems: ["media_alt_missing"] });

    const alt = await request(server)
      .patch(`/admin/places/${place}/media/${id("a", 5)}`)
      .send({ alt: { uk: "Зала кафе" } });
    expect(alt.status).toBe(200);
    const ok = await request(server).post(`/admin/places/${place}/publish`).send({ reason: "перевірено" });
    expect(ok.status).toBe(200);
    expect((ok.body as { status: string }).status).toBe("published");
    expect(data.audit_logs!.map((l) => [l.action, l.region_id, l.actor_user_id])).toEqual([
      ["media.update", A, USER],
      ["place.publish", A, USER],
    ]);
    // Повторная публикация — 409.
    expect((await request(server).post(`/admin/places/${place}/publish`).send({})).status).toBe(409);
  });

  it("опубликованное место: правка, убирающая обязательное поле, — 422 и без изменений", async () => {
    const { server, data } = await start([REGION_ADMIN_A]);
    const place = data.places!.find((p) => p.id === id("a", 4))!;
    Object.assign(place, { status: "published", first_published_at: T0 });
    data.media_assets!.find((m) => m.id === id("a", 5))!.alt_i18n = { uk: "Фото" };
    const res = await request(server).patch(`/admin/places/${place.id}`).send({ address: null });
    expect(res.status).toBe(422);
    expect(errorOf(res).details).toMatchObject({ problems: ["address_missing"] });
    expect(place.address_i18n).toEqual(NAME("Адреса"));
  });

  it("правка опубликованного места не блокируется неактивной категорией и отклонённым фото (их ловит публикация)", async () => {
    const { server, data } = await start([REGION_ADMIN_A]);
    const place = data.places!.find((p) => p.id === id("a", 4))!;
    Object.assign(place, { status: "published", first_published_at: T0 });
    data.categories!.find((c) => c.id === id("a", 2))!.active = false;
    Object.assign(data.media_assets!.find((m) => m.id === id("a", 5))!, {
      alt_i18n: { uk: "Фото" },
      status: "rejected",
    });
    const res = await request(server)
      .patch(`/admin/places/${place.id}`)
      .send({ name: NAME("Нова назва") });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(place.name_i18n).toEqual(NAME("Нова назва"));
    place.status = "suspended";
    const publish = await request(server).post(`/admin/places/${place.id}/publish`).send({});
    expect(publish.status).toBe(422);
    expect(errorOf(publish).details).toMatchObject({ problems: ["category_inactive", "media_rejected"] });
  });

  it("перенос опубликованного места в неактивную категорию — 422 category_inactive, место не изменилось", async () => {
    const { server, data } = await start([REGION_ADMIN_A]);
    const place = data.places!.find((p) => p.id === id("a", 4))!;
    Object.assign(place, { status: "published", first_published_at: T0 });
    data.media_assets!.find((m) => m.id === id("a", 5))!.alt_i18n = { uk: "Фото" };
    data.categories!.push({
      ...data.categories![0]!,
      id: id("a", 8),
      code: "off",
      home_section: null,
      active: false,
    });
    const res = await request(server)
      .patch(`/admin/places/${place.id}`)
      .send({ categoryId: id("a", 8) });
    expect(res.status).toBe(422);
    expect(errorOf(res).details).toMatchObject({ problems: ["category_inactive"] });
    expect(place.category_id).toBe(id("a", 2));
  });

  it("смена родителя категории блокирует строки категории и родителя FOR UPDATE по возрастанию id", async () => {
    const { server, data, queries } = await start([REGION_ADMIN_A]);
    data.categories!.push({
      ...data.categories![0]!,
      id: id("a", 9),
      code: "sub",
      home_section: null,
    });
    const res = await request(server)
      .patch(`/admin/categories/${id("a", 9)}`)
      .send({ parentId: id("a", 2) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lock = queries.find((q) => /for update/i.test(q.sql) && q.sql.includes('from "categories"'));
    expect(lock?.sql).toMatch(/"id" in \(\$1, \$2\).* order by "id" for update$/);
    expect(lock?.parameters.slice(0, 2)).toEqual([id("a", 2), id("a", 9)].sort());
    // Блокировка — до проверок родителя.
    const lockAt = queries.indexOf(lock!);
    const parentRead = queries.findIndex(
      (q, i) =>
        i > lockAt && q.sql.startsWith('select * from "categories"') && q.parameters[0] === id("a", 2),
    );
    expect(parentRead).toBeGreaterThan(lockAt);
  });

  it("бейдж «Ми рекомендуємо»: выдача и снятие с причиной, история и аудит; повтор — 409; без причины — 400", async () => {
    const { server, data } = await start([REGION_ADMIN_A]);
    const place = id("a", 4);
    expect((await request(server).post(`/admin/places/${place}/badge`).send({})).status).toBe(400);
    const granted = await request(server)
      .post(`/admin/places/${place}/badge`)
      .send({ reason: "Критерії 1–3" });
    expect(granted.status).toBe(200);
    expect((granted.body as { recommended: boolean }).recommended).toBe(true);
    expect(
      (await request(server).post(`/admin/places/${place}/badge`).send({ reason: "ще раз" })).status,
    ).toBe(409);
    const revoked = await request(server).delete(`/admin/places/${place}/badge`).send({ reason: "Скарги" });
    expect(revoked.status).toBe(200);
    expect(data.place_badge_events!.map((e) => [e.action, e.reason, e.region_id, e.actor_user_id])).toEqual([
      ["grant", "Критерії 1–3", A, USER],
      ["revoke", "Скарги", A, USER],
    ]);
    expect(data.audit_logs!.map((l) => [l.action, l.reason])).toEqual([
      ["badge.recommend.grant", "Критерії 1–3"],
      ["badge.recommend.revoke", "Скарги"],
    ]);
  });

  it("график: пересечение интервалов — 422 errors.place.scheduleInvalid", async () => {
    const { server } = await start([REGION_ADMIN_A]);
    const res = await request(server)
      .put(`/admin/places/${id("a", 4)}/schedule`)
      .send({
        weekly: [
          { dayOfWeek: 1, opensAt: "09:00", closesAt: "14:00" },
          { dayOfWeek: 1, opensAt: "13:00", closesAt: "18:00" },
        ],
        exceptions: [],
      });
    expect(res.status).toBe(422);
    expect(errorOf(res).details).toMatchObject({ problems: ["interval_overlap"] });
    const bad = await request(server)
      .put(`/admin/places/${id("a", 4)}/schedule`)
      .send({ weekly: [{ dayOfWeek: 8, opensAt: "25:00", closesAt: "18:00" }], exceptions: [] });
    expect(bad.status).toBe(400);
  });

  it("удаление: черновик без публикаций — 204; когда-то опубликованное — 409", async () => {
    const { server, data } = await start([REGION_ADMIN_A]);
    data.places!.find((p) => p.id === id("a", 4))!.first_published_at = T0;
    const denied = await request(server).delete(`/admin/places/${id("a", 4)}`);
    expect(denied.status).toBe(409);
    expect(errorOf(denied).messageKey).toBe("errors.place.notDeletable");
    data.places!.find((p) => p.id === id("a", 4))!.first_published_at = null;
    expect((await request(server).delete(`/admin/places/${id("a", 4)}`)).status).toBe(204);
    expect(data.places!.map((p) => p.id)).toEqual([id("b", 4)]);
  });
});
