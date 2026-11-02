// Unit (без сети и БД): бесплатный режим places:enrich — месячный предел по SKU в google_api_usage (общий с api),
// продолжение в следующем месяце с непройденных, данные из кэша импорта без Place Details, приоритет категорий,
// обложки (Wikimedia бесплатно, Google — в пределе; уже сохранённые — пропуск).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { usageDb } from "../../test/support/usage-db.js";
import { GooglePlacesClient } from "../places-import/google-client.js";
import type { GooglePlace, MappedPlace } from "../places-import/mapping.js";
import { runCovers, type Resize } from "./covers.js";
import { fromSearch } from "./details.js";
import { DEFAULT_SKIP_DETAILS, enrich, prioritized } from "./enrich.js";
import { GoogleQuota } from "./quota.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "tg-free-"));
const MONTH = "2026-11-01";
const at = (iso: string) => () => new Date(iso);

const place = (id: string, over: Partial<MappedPlace> = {}): MappedPlace => ({
  googlePlaceId: id,
  categoryCode: "restaurants",
  localityCode: "yaremche",
  name: `Місце ${id}`,
  description: "",
  address: "Яремче",
  at: { lon: 24.55, lat: 48.45 },
  phone: null,
  website: null,
  week: null,
  photos: [],
  rating: null,
  ratingCount: null,
  ...over,
});

const raw = (id: string): GooglePlace => ({
  id,
  primaryTypeDisplayName: { text: "Ресторан" },
  editorialSummary: { text: "Ресторан з терасою." },
  rating: 4.6,
  userRatingCount: 120,
  photos: [{ name: `places/${id}/photos/p1` }],
});

const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });

describe("GoogleQuota — месячный предел по SKU", () => {
  it("SKU считаются раздельно; сверх предела — отказ; новый месяц — снова можно", async () => {
    const usage = new Map<string, number>();
    const { db } = usageDb(usage);
    const nov = new GoogleQuota(db, at("2026-11-15T10:00:00Z"));
    expect(await nov.take("place_details", { monthly: 2 })).toBe(true);
    expect(await nov.take("place_details", { monthly: 2 })).toBe(true);
    expect(await nov.take("place_details", { monthly: 2 })).toBe(false);
    expect(await nov.take("place_photos", { monthly: 2 })).toBe(true);
    expect(usage.get(`${MONTH}|place_details_month`)).toBe(2);
    expect(usage.get(`${MONTH}|place_photos_month`)).toBe(1);
    const dec = new GoogleQuota(db, at("2026-12-01T00:00:01Z"));
    expect(await dec.take("place_details", { monthly: 2 })).toBe(true);
    expect(usage.get("2026-12-01|place_details_month")).toBe(1);
  });

  it("суточный исчерпан — месячный запрос возвращается; предел 0 и ошибка БД — отказ", async () => {
    const usage = new Map<string, number>([["2026-11-15|place_photos", 3]]);
    const { db } = usageDb(usage);
    const q = new GoogleQuota(db, at("2026-11-15T10:00:00Z"));
    expect(await q.take("place_photos", { daily: 3, monthly: 100 })).toBe(false);
    expect(usage.get(`${MONTH}|place_photos_month`)).toBe(0);
    expect(await q.take("place_photos", { monthly: 0 })).toBe(false);
    const down = new GoogleQuota(usageDb(new Map(), { fails: true }).db, at("2026-11-15T10:00:00Z"));
    expect(await down.take("place_details", { monthly: 10 })).toBe(false);
  });
});

describe("бесплатный режим enrich", () => {
  it("--from-import-cache: тип, описание, рейтинг из кэша поиска, фото с авторами — бесплатным «id,photos»", async () => {
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      const mask = (init.headers as Record<string, string>)["X-Goog-FieldMask"];
      expect(mask).toBe("id,photos");
      return Promise.resolve(
        json({
          id: "a",
          photos: [{ name: "places/a/photos/p1", authorAttributions: [{ displayName: "Олена" }] }],
        }),
      );
    });
    const google = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: await tmp(),
      maxRequests: 0,
      fetch: fetchMock as unknown as typeof fetch,
      quota: () => Promise.resolve(false),
    });
    const r = await enrich([place("a")], google, undefined, {
      details: false,
      rawById: new Map([["a", raw("a")]]),
    });
    expect(r.places[0]!.google).toMatchObject({
      typeLabel: "Ресторан",
      summary: "Ресторан з терасою.",
      rating: 4.6,
      ratingCount: 120,
      reviews: [],
      amenities: [],
      photos: [{ name: "places/a/photos/p1", authors: [{ name: "Олена" }] }],
    });
    // Бесплатный запрос не упирается в --max-requests 0 и не спрашивает месячный предел.
    expect(google.requests).toMatchObject({ details: 0, detailsIds: 1 });
    expect(r.stats.fromImport).toBe(1);
    // Без ответа «id,photos» фото нет: подпись автора обязательна.
    expect(fromSearch(raw("b"), null).photos).toEqual([]);
  });

  it("месячный предел Details: остальные — из кэша импорта; следующий месяц продолжает с непройденных", async () => {
    const cacheDir = await tmp();
    const usage = new Map<string, number>();
    const { db } = usageDb(usage);
    const details = vi.fn((url: string) =>
      Promise.resolve(
        json(url.includes("/places/") ? { id: url.split("/places/")[1]!.split("?")[0], rating: 4 } : {}),
      ),
    );
    const run = async (now: string) => {
      const quota = new GoogleQuota(db, at(now));
      const google = new GooglePlacesClient({
        apiKey: "k",
        cacheDir,
        maxRequests: 100,
        fetch: details as unknown as typeof fetch,
        quota: (sku) => quota.take(sku, { monthly: 2 }),
      });
      const places = ["a", "b", "c", "atm1"].map((id) =>
        place(id, id === "atm1" ? { categoryCode: "atm" } : {}),
      );
      return enrich(places, google, undefined, {
        rawById: new Map(["a", "b", "c", "atm1"].map((id) => [id, raw(id)])),
        skipDetails: DEFAULT_SKIP_DETAILS,
        freePhotos: false,
      }).then((r) => ({ ...r, google }));
    };
    const nov = await run("2026-11-20T10:00:00Z");
    expect(nov.google.requests.details).toBe(2);
    expect(nov.stats).toMatchObject({
      details: 2,
      detailsDeferred: 1,
      monthlyLimitReached: true,
      fromImport: 2,
    });
    // АЗС/банкомат без Details, но с данными из кэша импорта.
    expect(nov.places.find((p) => p.googlePlaceId === "atm1")!.google?.typeLabel).toBe("Ресторан");

    const dec = await run("2026-12-02T10:00:00Z");
    // Пройденные — из кэша ответов; запрос только для непройденного.
    expect(dec.google.requests.details).toBe(1);
    expect(dec.stats).toMatchObject({ details: 3, detailsDeferred: 0 });
  });

  it("приоритет: рестораны/отели/природа и т. п. первыми, внутри — по числу оценок Google", () => {
    const order = prioritized([
      place("shop", { categoryCode: "stores", ratingCount: 9000 }),
      place("r1", { ratingCount: 10 }),
      place("w", { categoryCode: "nature", ratingCount: 30000 }),
      place("r2", { ratingCount: 500 }),
    ]).map((p) => p.googlePlaceId);
    expect(order).toEqual(["w", "r2", "r1", "shop"]);
  });
});

describe("обложки", () => {
  const resize: Resize = (input) =>
    Promise.resolve({ data: Buffer.concat([Buffer.from("webp:"), input]), width: 400, height: 300 });

  it("Wikimedia — бесплатно; Google — в пределе; уже есть — пропуск; предел — отложено", async () => {
    const coverRows: Record<string, unknown>[] = [];
    const usage = new Map<string, number>();
    const { db } = usageDb(usage, {
      extra: (q) => {
        if (q.sql.startsWith('select "id" from "places"')) return [{ id: `pid-${String(q.parameters[0])}` }];
        if (q.sql.startsWith('insert into "place_cover_photos"'))
          coverRows.push({ sql: q.sql, p: q.parameters });
        return [];
      },
    });
    const quota = new GoogleQuota(db, at("2026-11-20T10:00:00Z"));
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/media?"))
        return Promise.resolve(json({ photoUri: "https://lh3.googleusercontent.com/x" }));
      return Promise.resolve(new Response(Buffer.from("img"), { status: 200 }));
    });
    const google = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: await tmp(),
      maxRequests: 100,
      fetch: fetchMock as unknown as typeof fetch,
      quota: (sku) => quota.take(sku, { monthly: 1 }),
    });
    const g = (id: string) => ({
      typeLabel: null,
      summary: null,
      priceLevel: null,
      rating: null,
      ratingCount: null,
      mapsUri: null,
      amenities: [],
      reviews: [],
      photos: [
        {
          name: `places/${id}/photos/p1`,
          width: 800,
          height: 600,
          authors: [{ name: "Олена", uri: null, photoUri: null }],
        },
      ],
    });
    const item = (id: string, over = {}) => ({
      googlePlaceId: id,
      name: id,
      categoryCode: "restaurants",
      localityCode: "yaremche",
      address: null,
      google: g(id),
      wiki: undefined,
      ...over,
    });
    const wiki = {
      lang: "uk",
      title: "Пробій",
      url: "https://uk.wikipedia.org/wiki/Пробій",
      extract: "…",
      image: {
        url: "https://upload.wikimedia.org/p.jpg",
        width: 1200,
        height: 900,
        author: "MSha",
        license: "CC BY-SA 3.0",
        licenseUrl: null,
        sourceUrl: "https://commons.wikimedia.org/wiki/File:P.jpg",
      },
    };
    const stats = await runCovers(
      [item("old"), item("w", { wiki }), item("g1"), item("g2"), item("none", { google: null })],
      {
        google,
        db,
        regionId: "0190f5c2-7d3e-7000-8000-00000000000a",
        existing: new Set(["old"]),
        write: true,
        fetch: fetchMock as unknown as typeof fetch,
        resize,
      },
    );
    expect(stats).toMatchObject({
      existing: 1,
      needed: 3,
      written: 2,
      wikimedia: 1,
      google: 1,
      deferred: 1,
      failed: 0,
    });
    expect(usage.get(`${MONTH}|place_photos_month`)).toBe(1);
    expect(coverRows).toHaveLength(2);
    // Подпись автора сохраняется вместе с файлом.
    expect(JSON.stringify(coverRows)).toContain("MSha");
    expect(JSON.stringify(coverRows)).toContain("Олена");
  });

  it("без записи (план/dry-run) — только подсчёт, без запросов", async () => {
    const fetchMock = vi.fn();
    const google = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: await tmp(),
      maxRequests: 100,
      fetch: fetchMock,
    });
    const stats = await runCovers(
      [
        {
          googlePlaceId: "a",
          name: "a",
          categoryCode: "restaurants",
          localityCode: "yaremche",
          address: null,
          google: { ...fromSearch(raw("a"), { photos: [{ name: "places/a/photos/p1" }] }) },
          wiki: undefined,
        },
      ],
      { google, existing: new Set(), write: false },
    );
    expect(stats).toMatchObject({ needed: 1, written: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
