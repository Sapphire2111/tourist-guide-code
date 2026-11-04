// Ассистент на реальной PostgreSQL + PostGIS под ролью приложения: поиск блюда по ключевым словам (регулярки Postgres
// по целым словам с кириллицей, суші/суши/sushi, названия слитно, отзывы — только тексты, а не имена авторов, «\n»
// перед словом), раздел и радиус, черновик и чужой регион не видны; рейтинг и график мест для плана.
// Без Docker — пропуск (CI).
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/index.js";
import { AssistantRepository } from "../../src/modules/assistant/assistant.repository.js";
import { expandKeywords, keywordPattern } from "../../src/modules/assistant/keywords.js";
import { seedCatalog } from "../../src/seed/seed-catalog.js";
import { seedBase, type SeedBaseResult } from "../../src/seed/seed.js";
import { seedUuid } from "../../src/seed/ids.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const APP_LOGIN = "tg_api_assistant_test";
const APP_PASSWORD = "tg_api_assistant_test";

// Далеко от демо-мест seed (Карпаты).
const ORIGIN = { lon: 30.5234, lat: 50.4501 };
const shift = (dn: number) => ({ lon: ORIGIN.lon, lat: ORIGIN.lat + dn / 110_574 });

type TestPlace = {
  key: string;
  name: string;
  category: string;
  north: number;
  status?: "draft" | "published";
  region?: "a" | "b";
  google?: Record<string, unknown>;
  ai?: string;
};

const review = (text: string, author = "Гість") => ({ text, author: { name: author }, language: "uk" });

const PLACES: readonly TestPlace[] = [
  { key: "barberri", name: "Суши Кафе Барберрі", category: "restaurants", north: 300 },
  { key: "kitsune", name: "KitsuneSushi", category: "cafes", north: 600 },
  {
    key: "kuma",
    name: "Тест KUMA",
    category: "restaurants",
    north: 100,
    ai: "Азійський ресторан. Відвідувачі хвалять суші та роли.",
    google: {
      typeLabel: "Ресторан азійської кухні",
      rating: 4.6,
      ratingCount: 120,
      priceLevel: 2,
      amenities: ["kids_menu"],
      reviews: [],
    },
  },
  {
    key: "review",
    name: "Тест Сімейне",
    category: "cafes",
    north: 200,
    google: { reviews: [review("Замовляли піцу.\nСуші теж смачні")] },
  },
  {
    key: "author",
    name: "Тест Автор",
    category: "restaurants",
    north: 250,
    google: { reviews: [review("Чудово", "Суші Майстер")], typeLabel: null },
  },
  {
    key: "drying",
    name: "Тест Сушарка",
    category: "cafes",
    north: 260,
    google: { reviews: [review("Ніде сушити рушники, немає сушилки")] },
  },
  { key: "hotel", name: "Тест Готель", category: "hotels", north: 150, ai: "Поруч є суші-бар." },
  { key: "far", name: "Суші Далеко", category: "cafes", north: 30_000 },
  { key: "draft", name: "Суші Чернетка", category: "cafes", north: 100, status: "draft" },
  { key: "other", name: "Суші Чужий", category: "eat", north: 100, region: "b" },
];

const placeId = (key: string) => seedUuid(`assistant-test:place:${key}`);

describe.skipIf(!dockerAvailable)(`Ассистент: ключевые слова, рейтинг и график (0018)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let base: SeedBaseResult;
  let repo: AssistantRepository;
  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);
  const categoryId = (code: string, region: "a" | "b" = "a") =>
    seedUuid(`catalog:${region}:category:${code}`);

  beforeAll(async () => {
    tdb = await startDatabase();
    await tdb.client.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    for (const p of PLACES) {
      const region = base.regions[p.region ?? "a"];
      const at = shift(p.north);
      await sql(
        // Опубликованному месту нужны описание и адрес (places_published_complete); в них нет ключевых слов.
        `INSERT INTO places (id, region_id, category_id, name_i18n, description_i18n, address_i18n, location, status,
           first_published_at)
         VALUES ($1, $2, $3, $4, '{"uk":"Опис"}', '{"uk":"Адреса"}', ST_SetSRID(ST_MakePoint($5, $6), 4326), $7,
           CASE WHEN $7 = 'draft' THEN NULL ELSE now() END)`,
        [
          placeId(p.key),
          region,
          categoryId(p.category, p.region ?? "a"),
          JSON.stringify({ uk: p.name }),
          at.lon,
          at.lat,
          p.status ?? "published",
        ],
      );
      if (p.google || p.ai)
        await sql(
          `INSERT INTO place_enrichments (region_id, place_id, google, ai_summary_uk, ai_model, ai_generated_at)
           VALUES ($1, $2, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE 'test-model' END,
             CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)`,
          [region, placeId(p.key), p.google ? JSON.stringify(p.google) : null, p.ai ?? null],
        );
    }
    await sql(
      `INSERT INTO place_schedules (region_id, place_id, day_of_week, opens_at, closes_at) VALUES ($1, $2, 6, '10:00', '22:00')`,
      [base.regions.a, placeId("barberri")],
    );
    await sql(
      `INSERT INTO place_schedule_exceptions (region_id, place_id, date, closed) VALUES ($1, $2, '2026-11-07', true)`,
      [base.regions.a, placeId("barberri")],
    );
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    repo = new AssistantRepository(appDb);
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  const keysOf = (rows: { id: string }[]) =>
    rows.map((r) => PLACES.find((p) => placeId(p.key) === r.id)?.key ?? `seed:${r.id}`);
  const sushi = () => {
    const terms = expandKeywords(["суші"]);
    return { pattern: keywordPattern(terms)!, namePattern: keywordPattern(terms, false)! };
  };

  it("«суші» в разделе «Де поїсти» рядом: название (суши, слитно sushi), ИИ-текст, отзыв после «\\n»; не автор и не «сушити»", async () => {
    const rows = await repo.keywordMatches(base.regions.a, {
      ...sushi(),
      categoryIds: [categoryId("eat")],
      origin: ORIGIN,
      radius: 5000,
      minScore: 1,
      limit: 60,
    });
    expect(keysOf(rows)).toEqual(["barberri", "kitsune", "kuma", "review"]);
    expect(rows.map((r) => r.score)).toEqual([4, 4, 2, 1]);
  });

  it("order distance: LIMIT отбирает ближайших из прошедших minScore (слабое совпадение рядом не отсекается)", async () => {
    const q = { ...sushi(), categoryIds: [categoryId("eat")], origin: ORIGIN, radius: 5000, minScore: 1 };
    expect(keysOf(await repo.keywordMatches(base.regions.a, { ...q, limit: 2 }))).toEqual([
      "barberri",
      "kitsune",
    ]);
    expect(keysOf(await repo.keywordMatches(base.regions.a, { ...q, limit: 2, order: "distance" }))).toEqual([
      "kuma",
      "review",
    ]);
  });

  it("без раздела и радиуса: весь регион, отели с ИИ-текстом тоже; минимальный вес отсекает одни отзывы", async () => {
    const rows = await repo.keywordMatches(base.regions.a, {
      ...sushi(),
      categoryIds: [],
      minScore: 2,
      limit: 60,
    });
    const keys = keysOf(rows);
    expect(keys).toEqual(expect.arrayContaining(["barberri", "kitsune", "kuma", "hotel", "far"]));
    for (const k of ["review", "author", "drying", "draft", "other"]) expect(keys).not.toContain(k);
  });

  it("ratings: рейтинг, цена, удобства и тип Google; schedules: недельный график и исключение даты", async () => {
    const ratings = await repo.ratings(base.regions.a, [placeId("kuma"), placeId("barberri")]);
    expect(ratings.get(placeId("kuma"))).toEqual({
      rating: 4.6,
      ratingCount: 120,
      priceLevel: 2,
      amenities: ["kids_menu"],
      typeLabel: "Ресторан азійської кухні",
    });
    expect(ratings.has(placeId("barberri"))).toBe(false);
    const schedules = await repo.schedules(
      base.regions.a,
      [placeId("barberri"), placeId("kuma")],
      ["2026-11-07"],
    );
    expect(schedules.get(placeId("barberri"))).toEqual({
      weekly: [{ dayOfWeek: 6, opensAt: "10:00:00", closesAt: "22:00:00" }],
      exceptions: [{ date: "2026-11-07", closed: true, opensAt: null, closesAt: null }],
    });
    expect(schedules.has(placeId("kuma"))).toBe(false);
    // Чужой регион — не видно.
    expect((await repo.ratings(base.regions.b, [placeId("kuma")])).size).toBe(0);
  });

  it("topRated: раздел — с подкатегориями (parent_id), порядок по рейтингу и отзывам; черновик и чужой регион не видны", async () => {
    const ours = (ids: string[]) =>
      ids.flatMap((id) => {
        const p = PLACES.find((x) => placeId(x.key) === id);
        return p ? [p.key] : [];
      });
    // Корень «Де поїсти» — места подкатегорий (restaurants, cafes) через parent_id; отели — нет.
    const eat = ours(await repo.topRated(base.regions.a, { categoryIds: [categoryId("eat")], limit: 500 }));
    // KUMA: 4.6 и 120 отзывов — выше мест без рейтинга (по умолчанию 4); дальше — по id.
    expect(eat[0]).toBe("kuma");
    expect([...eat].sort()).toEqual(["author", "barberri", "drying", "far", "kitsune", "kuma", "review"]);
    // Сама подкатегория (c.id): только кафе.
    const cafes = ours(
      await repo.topRated(base.regions.a, { categoryIds: [categoryId("cafes")], limit: 500 }),
    );
    expect([...cafes].sort()).toEqual(["drying", "far", "kitsune", "review"]);
    // Чужой регион: своё место не видно в регионе a и наоборот.
    const other = ours(
      await repo.topRated(base.regions.b, { categoryIds: [categoryId("eat", "b")], limit: 500 }),
    );
    expect(other).toEqual(["other"]);
    expect(await repo.topRated(base.regions.a, { categoryIds: [], limit: 10 })).toEqual([]);
  });
});
