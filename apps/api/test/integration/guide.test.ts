// Блок 4 (ADR-0019): публичный каталог туриста на реальной PostgreSQL 17 + PostGIS под ролью приложения —
// расстояние PostGIS против эталона (геодезическая задача Винсенти на эллипсоиде WGS 84, погрешность ≤ 1%), радиус,
// категория с подкатегориями, текст, порядок (BR-10, C-02: реклама помечена и порядок не меняет, бейдж не даёт),
// неопубликованные (черновик, приостановленное, архив) и чужой регион не видны ни в поиске, ни по id,
// «Відкрито зараз» по графику в таймзоне региона, избранное (миграция 0014, RLS). Без Docker — пропуск (CI).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, regionContext, withTenant, type Db } from "../../src/db/index.js";
import { EmergencyContactsRepository } from "../../src/modules/emergency-contacts/index.js";
import { GuideRepository, GuideService } from "../../src/modules/guide/index.js";
import { coverEtag } from "../../src/modules/guide/guide.service.js";
import { GoogleQuota } from "../../src/places-enrich/quota.js";
import type { MediaService } from "../../src/modules/media/index.js";
import { RegionsRepository } from "../../src/modules/regions/index.js";
import { seedCatalog } from "../../src/seed/seed-catalog.js";
import { seedBase, type SeedBaseResult } from "../../src/seed/seed.js";
import { seedUuid } from "../../src/seed/ids.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const APP_LOGIN = "tg_api_guide_test";
const APP_PASSWORD = "tg_api_guide_test";

/** Геодезическое расстояние на эллипсоиде WGS 84 (обратная задача Винсенти), м — эталон для PostGIS. */
function vincenty(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const A = 6378137;
  const f = 1 / 298.257223563;
  const B = (1 - f) * A;
  const rad = Math.PI / 180;
  const L = (b.lon - a.lon) * rad;
  const U1 = Math.atan((1 - f) * Math.tan(a.lat * rad));
  const U2 = Math.atan((1 - f) * Math.tan(b.lat * rad));
  const [sinU1, cosU1, sinU2, cosU2] = [Math.sin(U1), Math.cos(U1), Math.sin(U2), Math.cos(U2)];
  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2Alpha = 0;
  let cos2SigmaM = 0;
  for (let i = 0; i < 200; i++) {
    const sinL = Math.sin(lambda);
    const cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
    cos2Alpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const prev = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - prev) < 1e-12) break;
  }
  const u2 = (cos2Alpha * (A ** 2 - B ** 2)) / B ** 2;
  const k1 = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const k2 = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSigma =
    k2 *
    sinSigma *
    (cos2SigmaM +
      (k2 / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (k2 / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return B * k1 * (sigma - dSigma);
}

// Точка туриста — далеко от демо-мест seed (Карпаты), чтобы радиус их не захватывал.
const ORIGIN = { lon: 30.5234, lat: 50.4501 };
/** Сдвиг на dn метров на север и de на восток (приближённо; точное расстояние — эталон). */
const shift = (dn: number, de: number) => ({
  lon: ORIGIN.lon + de / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  lat: ORIGIN.lat + dn / 110_574,
});

type TestPlace = {
  key: string;
  name: string;
  category: string;
  at: { lon: number; lat: number };
  status: "draft" | "published" | "suspended" | "archived";
  recommended?: boolean;
  region?: "a" | "b";
};

const PLACES: readonly TestPlace[] = [
  { key: "north", name: "Тест-Гід Кава Північ", category: "cafes", at: shift(120, 0), status: "published" },
  {
    key: "east",
    name: "Тест-Гід Ресторан Схід",
    category: "restaurants",
    at: shift(0, 350),
    status: "published",
    recommended: true,
  },
  { key: "far", name: "Тест-Гід Кава Далеко", category: "cafes", at: shift(1400, 1400), status: "published" },
  // Одинаковая точка: рекомендованное раньше рекламного (BR-10: реклама не обходит рекомендацию).
  {
    key: "west-rec",
    name: "Тест-Гід Захід Б",
    category: "cafes",
    at: shift(0, -200),
    status: "published",
    recommended: true,
  },
  { key: "west-ad", name: "Тест-Гід Захід А", category: "cafes", at: shift(0, -200), status: "published" },
  { key: "draft", name: "Тест-Гід Чернетка", category: "cafes", at: shift(50, 0), status: "draft" },
  {
    key: "suspended",
    name: "Тест-Гід Призупинено",
    category: "cafes",
    at: shift(60, 0),
    status: "suspended",
  },
  { key: "archived", name: "Тест-Гід Архів", category: "cafes", at: shift(70, 0), status: "archived" },
  {
    key: "other-region",
    name: "Тест-Гід Чужий",
    category: "eat",
    at: shift(120, 0),
    status: "published",
    region: "b",
  },
];

const placeId = (key: string) => seedUuid(`guide-test:place:${key}`);

describe.skipIf(!dockerAvailable)(`Публичный каталог туриста (блок 4, миграция 0014)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let appUrl: string;
  let base: SeedBaseResult;
  let service: GuideService;
  let user: string;

  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);
  const categoryId = (code: string, region: "a" | "b" = "a") =>
    seedUuid(`catalog:${region}:category:${code}`);

  beforeAll(async () => {
    tdb = await startDatabase();
    await tdb.client.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    user = base.users["admin-a"];
    for (const p of PLACES) {
      const region = base.regions[p.region ?? "a"];
      await sql(
        `INSERT INTO places (id, region_id, category_id, name_i18n, description_i18n, address_i18n, location, status,
           recommended, first_published_at, phone)
         VALUES ($1, $2, $3, $4, '{"uk":"Опис"}', '{"uk":"Адреса"}', ST_SetSRID(ST_MakePoint($5, $6), 4326), $7, $8,
           CASE WHEN $7 = 'draft' THEN NULL ELSE now() END, '+380000000999')`,
        [
          placeId(p.key),
          region,
          categoryId(p.category, p.region ?? "a"),
          JSON.stringify({ uk: p.name }),
          p.at.lon,
          p.at.lat,
          p.status,
          p.recommended ?? false,
        ],
      );
    }
    // Платное размещение «west-ad» — действующее.
    await sql(
      `INSERT INTO promotions (region_id, place_id, title_i18n, ad_label, starts_at, ends_at, status)
       VALUES ($1, $2, '{"uk":"Промо"}', 'advertising', now() - interval '1 day', now() + interval '1 day', 'active')`,
      [base.regions.a, placeId("west-ad")],
    );
    // График «north»: щодня 09:00–18:00.
    for (let d = 1; d <= 7; d++)
      await sql(
        `INSERT INTO place_schedules (region_id, place_id, day_of_week, opens_at, closes_at) VALUES ($1, $2, $3, '09:00', '18:00')`,
        [base.regions.a, placeId("north"), d],
      );
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appUrl = url.toString();
    appDb = createDatabase({ connectionString: appUrl, maxConnections: 2 });
    const media = {
      links: (a: { id: string }) =>
        Promise.resolve([
          { name: "w320", url: `https://cdn.test/${a.id}`, width: 320, height: 240, expiresAt: null },
        ]),
    } as unknown as MediaService;
    service = new GuideService(
      appDb,
      new GuideRepository(appDb),
      new RegionsRepository(appDb),
      new EmergencyContactsRepository(appDb),
      media,
    );
    // Понедельник 2026-11-02, 12:00 по Киеву.
    service.now = () => new Date("2026-11-02T10:00:00Z");
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  const keysOf = (items: { id: string }[]) =>
    items.map((i) => PLACES.find((p) => placeId(p.key) === i.id)?.key ?? `seed:${i.id}`);

  it("миграция 0014: favorites под RLS (ENABLE + FORCE), у app — только SELECT, INSERT, DELETE", async () => {
    const { rows } = await sql(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'favorites'`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const { rows: grants } = await sql(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'favorites' AND grantee = 'app' ORDER BY privilege_type`,
    );
    expect(grants.map((g) => g.privilege_type)).toEqual(["DELETE", "INSERT", "SELECT"]);
  });

  it("расстояние PostGIS совпадает с эталоном Винсенти (погрешность ≤ 1%)", async () => {
    const res = await service.search(base.regions.a, {
      origin: ORIGIN,
      radius: 5000,
      limit: 50,
      offset: 0,
    });
    const ours = res.items.filter((i) => PLACES.some((p) => placeId(p.key) === i.id));
    expect(ours.length).toBe(5);
    for (const item of ours) {
      const p = PLACES.find((x) => placeId(x.key) === item.id)!;
      const reference = vincenty(ORIGIN, p.at);
      expect(Math.abs(item.distanceMeters! - reference) / reference).toBeLessThanOrEqual(0.01);
    }
    expect(res.radiusMeters).toBe(5000);
  });

  it("«Що поруч» 500 м: только опубликованные в радиусе, по расстоянию; реклама помечена, не обходит рекомендованное", async () => {
    const res = await service.search(base.regions.a, { origin: ORIGIN, radius: 500, limit: 20, offset: 0 });
    expect(keysOf(res.items)).toEqual(["north", "west-rec", "west-ad", "east"]);
    const ad = res.items.find((i) => i.id === placeId("west-ad"))!;
    expect(ad).toMatchObject({ adLabel: "advertising", recommended: false });
    expect(res.items.find((i) => i.id === placeId("west-rec"))!.adLabel).toBeNull();
    expect(res.items.find((i) => i.id === placeId("north"))).toMatchObject({
      openNow: true,
      phone: "+380000000999",
      cover: null,
    });
    expect(res.items.find((i) => i.id === placeId("east"))!.openNow).toBeNull();
    expect(res.nextOffset).toBeNull();
  });

  it("страницы: limit + nextOffset", async () => {
    const first = await service.search(base.regions.a, { origin: ORIGIN, radius: 500, limit: 3, offset: 0 });
    expect(first.items).toHaveLength(3);
    expect(first.nextOffset).toBe(3);
    const second = await service.search(base.regions.a, { origin: ORIGIN, radius: 500, limit: 3, offset: 3 });
    expect(keysOf(second.items)).toEqual(["east"]);
    expect(second.nextOffset).toBeNull();
  });

  it("категория: раздел включает подкатегории, подкатегория — только себя", async () => {
    const eat = await service.search(base.regions.a, {
      origin: ORIGIN,
      radius: 5000,
      categoryId: categoryId("eat"),
      limit: 50,
      offset: 0,
    });
    expect(new Set(keysOf(eat.items))).toEqual(new Set(["north", "west-rec", "west-ad", "east", "far"]));
    const restaurants = await service.search(base.regions.a, {
      origin: ORIGIN,
      radius: 5000,
      categoryId: categoryId("restaurants"),
      limit: 50,
      offset: 0,
    });
    expect(keysOf(restaurants.items)).toEqual(["east"]);
  });

  it("excludeSections: места раздела (и его подкатегорий) не попадают, остальные — да; по умолчанию — все", async () => {
    const all = await service.search(base.regions.a, { origin: ORIGIN, radius: 5000, limit: 50, offset: 0 });
    expect(keysOf(all.items)).toContain("east");
    const noEat = await service.search(base.regions.a, {
      origin: ORIGIN,
      radius: 5000,
      excludeSections: ["eat"],
      limit: 50,
      offset: 0,
    });
    for (const k of ["north", "west-rec", "west-ad", "east", "far"])
      expect(keysOf(noEat.items)).not.toContain(k);
    // Место подкатегории stay («Готелі») исключается, остальные остаются; без параметра — находится.
    await sql(`UPDATE places SET category_id = $1 WHERE id = $2`, [categoryId("hotels"), placeId("east")]);
    try {
      const noStay = await service.search(base.regions.a, {
        origin: ORIGIN,
        radius: 5000,
        excludeSections: ["stay"],
        limit: 50,
        offset: 0,
      });
      expect(keysOf(noStay.items)).not.toContain("east");
      expect(keysOf(noStay.items)).toContain("north");
      const withStay = await service.search(base.regions.a, {
        origin: ORIGIN,
        radius: 5000,
        limit: 50,
        offset: 0,
      });
      expect(keysOf(withStay.items)).toContain("east");
    } finally {
      await sql(`UPDATE places SET category_id = $1 WHERE id = $2`, [
        categoryId("restaurants"),
        placeId("east"),
      ]);
    }
  });

  it("текст без координат: весь регион, без неопубликованных и чужого региона; рекомендованные выше", async () => {
    const res = await service.search(base.regions.a, { text: "тест-гід", limit: 50, offset: 0 });
    expect(keysOf(res.items)).toEqual(["west-rec", "east", "west-ad", "far", "north"]);
    expect(res.items.every((i) => i.distanceMeters === null)).toBe(true);
    expect(res.radiusMeters).toBeNull();
    const kava = await service.search(base.regions.a, { text: "Кава", limit: 50, offset: 0 });
    expect(keysOf(kava.items).filter((k) => !k.startsWith("seed:"))).toEqual(["far", "north"]);
    // Спецсимволы ILIKE — буквально.
    expect((await service.search(base.regions.a, { text: "%%", limit: 5, offset: 0 })).items).toEqual([]);
  });

  it("по id: опубликованное — карточка; черновик, приостановленное, архив, чужой регион — нет", async () => {
    const card = await service.place(base.regions.a, placeId("north"), { origin: ORIGIN, userId: user });
    expect(card).toMatchObject({
      id: placeId("north"),
      regionId: base.regions.a,
      category: { id: categoryId("cafes"), parentId: categoryId("eat") },
      openNow: true,
      openUntil: "18:00",
      favorite: false,
      photos: [],
      tags: [],
    });
    expect(card!.schedule.timezone).toBe("Europe/Kyiv");
    expect(card!.schedule.weekly).toHaveLength(7);
    expect(card!.location.lat).toBeCloseTo(PLACES[0]!.at.lat, 6);
    for (const key of ["draft", "suspended", "archived", "other-region"])
      expect(await service.place(base.regions.a, placeId(key), {})).toBeUndefined();
    expect(await service.place(base.regions.b, placeId("north"), {})).toBeUndefined();
    const anonymous = await service.place(base.regions.a, placeId("north"), {});
    expect(anonymous!.favorite).toBeNull();
    expect(anonymous!.distanceMeters).toBeNull();
  });

  it("«Відкрито зараз» — по таймзоне региона: 19:00 по Киеву закрыто", async () => {
    const evening = new GuideService(
      appDb,
      new GuideRepository(appDb),
      new RegionsRepository(appDb),
      new EmergencyContactsRepository(appDb),
      { links: () => Promise.resolve([]) } as unknown as MediaService,
    );
    evening.now = () => new Date("2026-11-02T17:00:00Z");
    const card = await evening.place(base.regions.a, placeId("north"), {});
    expect(card).toMatchObject({ openNow: false, openUntil: null });
  });

  it("ночной интервал вчера + исключение «закрыто» сегодня: до конца ночной смены открыто, потом закрыто", async () => {
    // «far»: пн 20:00–03:00 (через полночь), вт 09:00–18:00; вторник 2026-11-03 — закрыто весь день.
    await sql(
      `INSERT INTO place_schedules (region_id, place_id, day_of_week, opens_at, closes_at)
       VALUES ($1, $2, 1, '20:00', '03:00'), ($1, $2, 2, '09:00', '18:00')`,
      [base.regions.a, placeId("far")],
    );
    await sql(
      `INSERT INTO place_schedule_exceptions (region_id, place_id, date, closed) VALUES ($1, $2, '2026-11-03', true)`,
      [base.regions.a, placeId("far")],
    );
    const at = (iso: string) => {
      const s = new GuideService(
        appDb,
        new GuideRepository(appDb),
        new RegionsRepository(appDb),
        new EmergencyContactsRepository(appDb),
        { links: () => Promise.resolve([]) } as unknown as MediaService,
      );
      s.now = () => new Date(iso);
      return s;
    };
    const inSearch = async (s: GuideService) =>
      (await s.search(base.regions.a, { text: "Кава Далеко", limit: 5, offset: 0 })).items.find(
        (i) => i.id === placeId("far"),
      )!.openNow;
    // Вт 01:30 по Киеву (UTC+2): смена понедельника ещё идёт — выборка исключений берёт вчера и сегодня.
    const night = at("2026-11-02T23:30:00Z");
    expect(await night.place(base.regions.a, placeId("far"), {})).toMatchObject({
      openNow: true,
      openUntil: "03:00",
    });
    expect(await inSearch(night)).toBe(true);
    // Вт 10:00: по недельному графику открыто, но исключение даты закрывает весь день.
    const morning = at("2026-11-03T08:00:00Z");
    expect(await morning.place(base.regions.a, placeId("far"), {})).toMatchObject({ openNow: false });
    expect(await inSearch(morning)).toBe(false);
    // Карточка отдаёт исключение со вчерашней даты (to_char даты, без сдвига часового пояса процесса).
    const card = await morning.place(base.regions.a, placeId("far"), {});
    expect(card!.schedule.exceptions).toEqual([
      { date: "2026-11-03", closed: true, opensAt: null, closesAt: null, note: null },
    ]);
  });

  it("категории: активные с числом мест; выключенная не видна; регион без статуса active — 404", async () => {
    await sql(
      `INSERT INTO categories (region_id, code, name_i18n, active) VALUES ($1, 'guide-off', '{"uk":"Вимкнено"}', false)`,
      [base.regions.a],
    );
    const { items } = await service.categories(base.regions.a);
    expect(items.some((c) => c.code === "guide-off")).toBe(false);
    const eat = items.find((c) => c.code === "eat")!;
    const children = items.filter((c) => c.parentId === eat.id);
    expect(eat.homeSection).toBe("eat");
    expect(eat.placeCount).toBe(children.reduce((n, c) => n + c.placeCount, 0));
    expect(items.find((c) => c.code === "restaurants")!.placeCount).toBeGreaterThanOrEqual(1);
    const { rows } = await sql(
      `INSERT INTO regions (code, name_i18n, status) VALUES ('guide-suspended', '{"uk":"Призупинений"}', 'suspended') RETURNING id`,
    );
    await expect(service.categories(rows[0].id as string)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("избранное: только опубликованное; повтор — без дубля; снятое с публикации пропадает из списка; RLS по региону", async () => {
    expect(await service.addFavorite(base.regions.a, user, placeId("draft"))).toBeUndefined();
    expect(await service.addFavorite(base.regions.a, user, placeId("other-region"))).toBeUndefined();
    const first = await service.addFavorite(base.regions.a, user, placeId("east"));
    const again = await service.addFavorite(base.regions.a, user, placeId("east"));
    expect(again).toEqual(first);
    await service.addFavorite(base.regions.a, user, placeId("north"));
    expect(keysOf((await service.favorites(base.regions.a, user)).items)).toEqual(["north", "east"]);
    expect((await service.favorites(base.regions.b, user)).items).toEqual([]);
    expect((await service.favorites(base.regions.a, base.users["admin-b"])).items).toEqual([]);
    // RLS: под ролью app в контексте региона B строк A не видно, без контекста — пусто.
    const count = async (regionId: string | null) => {
      const client = new pg.Client({ connectionString: appUrl });
      await client.connect();
      try {
        await client.query("BEGIN");
        if (regionId) await client.query("SELECT set_config('app.region_id', $1, true)", [regionId]);
        return (await client.query(`SELECT count(*)::int AS n FROM favorites`)).rows[0].n as number;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        await client.end();
      }
    };
    expect(await count(base.regions.a)).toBe(2);
    expect(await count(base.regions.b)).toBe(0);
    expect(await count(null)).toBe(0);
    // Снятое с публикации — не в списке, но убрать можно.
    await sql(`UPDATE places SET status = 'suspended' WHERE id = $1`, [placeId("north")]);
    expect(keysOf((await service.favorites(base.regions.a, user)).items)).toEqual(["east"]);
    // Лимит считает только видимые: скрытое место ещё в таблице, но в счёт не идёт.
    expect(await count(base.regions.a)).toBe(2);
    expect(
      await withTenant(appDb, regionContext(base.regions.a), () =>
        new GuideRepository(appDb).countFavorites(user),
      ),
    ).toBe(1);
    await service.removeFavorite(base.regions.a, user, placeId("north"));
    await service.removeFavorite(base.regions.a, user, placeId("north"));
    expect(await count(base.regions.a)).toBe(1);
    await sql(`UPDATE places SET status = 'published' WHERE id = $1`, [placeId("north")]);
  });
  it("google_api_usage: параллельные take() не превышают предел (INSERT … ON CONFLICT … WHERE count < предел)", async () => {
    const quota = new GoogleQuota(appDb, () => new Date("2026-11-20T10:00:00Z"));
    const taken = await Promise.all(
      Array.from({ length: 25 }, () => quota.take("place_photos", { daily: 8, monthly: 10 })),
    );
    expect(taken.filter(Boolean)).toHaveLength(8);
    const { rows } = await sql(`SELECT day::text AS day, kind, count FROM google_api_usage ORDER BY kind`);
    // Сутки исчерпаны — месячный запрос возвращается: оба счётчика 8.
    expect(rows).toEqual([
      { day: "2026-11-20", kind: "place_photos", count: 8 },
      { day: "2026-11-01", kind: "place_photos_month", count: 8 },
    ]);
    expect(await quota.used("place_photos")).toEqual({ month: 8, today: 8 });
  });

  it("place_cover_photos под RLS: обложка видна только в своём регионе; 304-путь без байтов", async () => {
    const { rows: rls } = await sql(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'place_cover_photos'`,
    );
    expect(rls).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const fetchedAt = new Date("2026-11-03T00:00:00Z");
    await sql(
      `INSERT INTO place_cover_photos (region_id, place_id, bytes, mime, width, height, author_attributions,
         license, source_url, source, photo_name, fetched_at)
       VALUES ($1, $2, $3, 'image/webp', 400, 300, '[{"name":"MSha","uri":null,"photoUri":null}]', 'CC BY-SA 3.0',
         'https://commons.wikimedia.org/wiki/File:P.jpg', 'wikimedia', 'https://upload.wikimedia.org/p.jpg', $4)`,
      [base.regions.a, placeId("east"), Buffer.from("RIFFwebp"), fetchedAt],
    );
    const etag = coverEtag("https://upload.wikimedia.org/p.jpg", fetchedAt);
    const c = await service.cover(base.regions.a, placeId("east"));
    expect(c?.bytes?.toString()).toBe("RIFFwebp");
    expect(c?.etag).toBe(etag);
    expect(await service.cover(base.regions.a, placeId("east"), (v) => v === etag)).toEqual({
      bytes: null,
      mime: "image/webp",
      etag,
    });
    // Чужой регион — 404 (место не найдено в контексте B).
    expect(await service.cover(base.regions.b, placeId("east"))).toBeUndefined();
    const count = async (regionId: string | null) => {
      const client = new pg.Client({ connectionString: appUrl });
      await client.connect();
      try {
        await client.query("BEGIN");
        if (regionId) await client.query("SELECT set_config('app.region_id', $1, true)", [regionId]);
        return (await client.query(`SELECT count(*)::int AS n FROM place_cover_photos`)).rows[0].n as number;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        await client.end();
      }
    };
    expect(await count(base.regions.a)).toBe(1);
    expect(await count(base.regions.b)).toBe(0);
    expect(await count(null)).toBe(0);
    // Запись под app в контексте B строки региона A не создаёт (WITH CHECK).
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.region_id', $1, true)", [base.regions.b]);
      await expect(
        client.query(
          `INSERT INTO place_cover_photos (region_id, place_id, bytes, mime, width, height, author_attributions,
             source, photo_name, fetched_at)
           VALUES ($1, $2, $3, 'image/webp', 1, 1, '[]', 'google', 'x', now())`,
          [base.regions.a, placeId("north"), Buffer.from([0])],
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  });
});
