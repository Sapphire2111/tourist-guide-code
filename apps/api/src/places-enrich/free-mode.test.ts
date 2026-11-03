// Unit (без сети и БД): бесплатный режим places:enrich — месячный предел по SKU в google_api_usage (общий с api),
// продолжение в следующем месяце с непройденных, данные из кэша импорта без Place Details, приоритет категорий,
// обложки (Wikimedia бесплатно, Google — в пределе; уже сохранённые — пропуск).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../test/support/recording-db.js";
import { usageDb } from "../../test/support/usage-db.js";
import { GooglePlacesClient } from "../places-import/google-client.js";
import type { GooglePlace, MappedPlace } from "../places-import/mapping.js";
import { makeCover, runCovers, WikimediaUnavailableError, type Resize } from "./covers.js";
import { fromSearch } from "./details.js";
import { DEFAULT_SKIP_DETAILS, enrich, prioritized } from "./enrich.js";
import { dayOf, GoogleQuota, monthOf } from "./quota.js";
import { withSavedGoogle, writeEnrichment } from "./writer.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "tg-free-"));
const MONTH = "2026-11-01";
const at = (iso: string) => () => new Date(iso);

const place = (id: string, over: Partial<MappedPlace> = {}): MappedPlace => ({
  googlePlaceId: id,
  categoryCode: "restaurants",
  extraCategoryCodes: [],
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
    // 01.12 00:00 UTC — в Лос-Анджелесе ещё 30.11: месяц Google тот же.
    const lateNov = new GoogleQuota(db, at("2026-12-01T00:00:01Z"));
    expect(await lateNov.take("place_details", { monthly: 2 })).toBe(false);
    const dec = new GoogleQuota(db, at("2026-12-01T08:00:01Z"));
    expect(await dec.take("place_details", { monthly: 2 })).toBe(true);
    expect(usage.get("2026-12-01|place_details_month")).toBe(1);
  });

  it("сутки и месяц — по America/Los_Angeles (сброс бесплатного объёма Google)", () => {
    expect(dayOf(new Date("2026-11-16T07:59:59Z"))).toBe("2026-11-15");
    expect(dayOf(new Date("2026-11-16T08:00:00Z"))).toBe("2026-11-16");
    // Летнее время: UTC−7.
    expect(dayOf(new Date("2026-07-01T06:59:59Z"))).toBe("2026-06-30");
    expect(monthOf(new Date("2026-07-01T06:59:59Z"))).toBe("2026-06-01");
    expect(monthOf(new Date("2026-07-01T07:00:00Z"))).toBe("2026-07-01");
  });

  it("суточный исчерпан — месячный запрос возвращается; предел 0 и ошибка БД — отказ", async () => {
    const usage = new Map<string, number>([["2026-11-15|place_photos", 3]]);
    const { db } = usageDb(usage);
    const q = new GoogleQuota(db, at("2026-11-15T10:00:00Z"));
    expect(await q.take("place_photos", { daily: 3, monthly: 100 })).toBe(false);
    expect(usage.get(`${MONTH}|place_photos_month`)).toBe(0);
    expect(await q.take("place_photos", { monthly: 0 })).toBe(false);
    // Несколько единиц — разом или ни одной (погода: «сейчас» + «по дням»).
    const pair = new GoogleQuota(
      usageDb(new Map([[`${MONTH}|weather_month`, 9]])).db,
      at("2026-11-15T10:00:00Z"),
    );
    expect(await pair.take("weather", { monthly: 10 }, 2)).toBe(false);
    expect(await pair.take("weather", { monthly: 11 }, 2)).toBe(true);
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

  it("без GOOGLE_MAPS_API_KEY Details и фото не из кэша пропускаются с предупреждением — прогон не падает", async () => {
    const log = vi.fn();
    const google = new GooglePlacesClient({ apiKey: undefined, cacheDir: await tmp(), maxRequests: 10 });
    const r = await enrich([place("a"), place("b")], google, undefined, {
      rawById: new Map([
        ["a", raw("a")],
        ["b", raw("b")],
      ]),
      log,
    });
    expect(r.places.map((p) => p.google?.photos)).toEqual([[], []]);
    expect(r.places[0]!.googleFromImport).toBe(true);
    expect(r.stats.detailsDeferred).toBe(2);
    // По одному предупреждению: Details и фото.
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining("Place Details"),
      expect.stringContaining("фото"),
    ]);
  });

  it("--from-import-cache: запись не затирает богатые поля Google и не снимает текст ИИ", async () => {
    const rich = {
      ...fromSearch(raw("a"), null),
      priceLevel: 2,
      mapsUri: "https://maps.google.com/?cid=1",
      amenities: ["beer" as const],
      reviews: [
        { rating: 5, text: "Смачно", relativeTime: null, publishTime: null, uri: null, author: null },
      ],
    };
    const { db, queries } = recordingDb({}, (q) => {
      if (q.sql.startsWith('select "id", "google_place_id"')) return [{ id: "p-a", google_place_id: "a" }];
      if (q.sql.startsWith('select "place_id", "google"')) return [{ place_id: "p-a", google: rich }];
      return [];
    });
    const poor = fromSearch({ rating: 4.7, userRatingCount: 130 }, null);
    await writeEnrichment(
      db,
      "0190f5c2-7d3e-7000-8000-00000000000a",
      [
        {
          ...place("a"),
          address: null,
          google: poor,
          googleFromImport: true,
          wiki: undefined,
          ai: { hash: "c".repeat(32), result: null },
        },
      ],
      new Date(),
    );
    const upsert = queries.find((q) => q.sql.startsWith('insert into "place_enrichments"'))!;
    const written = upsert.parameters.find(
      (v): v is Record<string, unknown> => typeof v === "object" && v !== null && "rating" in v,
    )!;
    expect(written).toMatchObject({ rating: 4.7, priceLevel: 2, amenities: ["beer"], typeLabel: "Ресторан" });
    expect((written.reviews as unknown[]).length).toBe(1);
    // Текст ИИ не снимается.
    expect(queries.some((q) => q.sql.startsWith('update "place_enrichments"'))).toBe(false);
  });

  it("--from-import-cache --ai: факты по слитым данным; места с текстом ИИ — без пакета", async () => {
    const rich = { ...fromSearch(raw("a"), null), amenities: ["beer" as const], priceLevel: 2 };
    const { db } = recordingDb({}, (q) =>
      q.sql.startsWith('select "places"."google_place_id"')
        ? [
            { google_place_id: "a", google: rich, ai_summary_uk: "Текст." },
            { google_place_id: "b", google: rich, ai_summary_uk: null },
          ]
        : [],
    );
    const poor = fromSearch({ rating: 4.7, userRatingCount: 130 }, null);
    const item = (id: string, over = {}) => ({
      ...place(id),
      address: null,
      google: poor,
      googleFromImport: true,
      wiki: undefined,
      ...over,
    });
    const r = await withSavedGoogle(db, "0190f5c2-7d3e-7000-8000-00000000000a", [
      item("a"),
      item("b"),
      item("c", { googleFromImport: false }),
    ]);
    expect([...r.withAi]).toEqual(["a"]);
    expect(r.places[1]!.google).toMatchObject({ rating: 4.7, amenities: ["beer"], priceLevel: 2 });
    expect(r.places[2]!.google).toBe(poor);
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

  it("Wikimedia: постоянная ошибка (404) — Google-обложка; 429/5xx/сеть — отложить, Google не тратить", async () => {
    let wikiStatus = 404;
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/media?")
          ? json({ photoUri: "https://lh3.googleusercontent.com/x" })
          : url.includes("wikimedia")
            ? new Response("", { status: wikiStatus })
            : new Response(Buffer.from("img"), { status: 200 }),
      ),
    ) as unknown as typeof fetch;
    const google = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: await tmp(),
      maxRequests: 100,
      fetch: fetchImpl,
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
    const photos = [{ name: "places/a/photos/p1", width: 800, height: 600, authors: [] }];
    const g = { ...fromSearch(raw("a"), null), photos };
    const c = await makeCover({ google: g, wiki }, { google, fetch: fetchImpl, resize });
    expect(c?.source).toBe("google");
    await expect(makeCover({ google: null, wiki }, { google, fetch: fetchImpl, resize })).rejects.toThrow(
      /Wikimedia: HTTP 404/,
    );
    for (const status of [429, 503]) {
      wikiStatus = status;
      const calls = vi.mocked(fetchImpl).mock.calls.length;
      await expect(
        makeCover({ google: g, wiki }, { google, fetch: fetchImpl, resize }),
      ).rejects.toBeInstanceOf(WikimediaUnavailableError);
      // Только запрос к Wikimedia — к Google нет.
      expect(vi.mocked(fetchImpl).mock.calls.length).toBe(calls + 1);
    }
    const stats = await runCovers([{ ...place("w"), address: null, google: g, wiki }], {
      google,
      db: recordingDb({}).db,
      regionId: "0190f5c2-7d3e-7000-8000-00000000000a",
      existing: new Set(),
      write: true,
      fetch: fetchImpl,
      resize,
    });
    expect(stats).toMatchObject({ deferred: 0, wikiUnavailable: 1, failed: 0, written: 0 });
    // 429 — Wikimedia до конца прогона не запрашивается; обрыв тела — тоже временно.
    wikiStatus = 429;
    const before = vi.mocked(fetchImpl).mock.calls.length;
    const s429 = await runCovers(
      ["w1", "w2", "w3"].map((id) => ({ ...place(id), address: null, google: g, wiki })),
      {
        google,
        db: recordingDb({}).db,
        regionId: "0190f5c2-7d3e-7000-8000-00000000000a",
        existing: new Set(),
        write: true,
        fetch: fetchImpl,
        resize,
      },
    );
    expect(s429).toMatchObject({ wikiUnavailable: 3, written: 0, failed: 0 });
    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(before + 1);
    const broken = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.reject(new DOMException("timeout", "TimeoutError")),
      }),
    ) as unknown as typeof fetch;
    await expect(makeCover({ google: g, wiki }, { google, fetch: broken, resize })).rejects.toBeInstanceOf(
      WikimediaUnavailableError,
    );
  });

  it("только Wikimedia: Google не вызывается вовсе, 429 — пауза и повтор, без фото Commons — без обложки", async () => {
    let wikiCalls = 0;
    const fetchImpl = vi.fn((url: string) => {
      if (!url.includes("wikimedia"))
        return Promise.resolve(new Response(Buffer.from("img"), { status: 200 }));
      wikiCalls++;
      return Promise.resolve(
        wikiCalls === 1
          ? new Response("", { status: 429, headers: { "retry-after": "3" } })
          : wikiCalls === 3
            ? new Response("", { status: 404 })
            : new Response(Buffer.from("img"), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    const google = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: await tmp(),
      maxRequests: 100,
      fetch: fetchImpl,
    });
    const wiki = {
      lang: "uk",
      title: "Говерла",
      url: "https://uk.wikipedia.org/wiki/Говерла",
      extract: "…",
      image: {
        url: "https://upload.wikimedia.org/h.jpg",
        width: 1200,
        height: 900,
        author: "MSha",
        license: "CC BY-SA 4.0",
        licenseUrl: null,
        sourceUrl: "https://commons.wikimedia.org/wiki/File:H.jpg",
      },
    };
    const photos = [{ name: "places/a/photos/p1", width: 800, height: 600, authors: [] }];
    const g = { ...fromSearch(raw("a"), null), photos };
    const sleeps: number[] = [];
    const rows: unknown[][] = [];
    const stats = await runCovers(
      [
        { ...place("w1"), address: null, google: g, wiki },
        { ...place("w2"), address: null, google: g, wiki },
        { ...place("g"), address: null, google: g, wiki: null },
      ],
      {
        google,
        db: recordingDb({}, (q) => {
          if (q.sql.startsWith('select "id" from "places"')) return [{ id: "pid" }];
          if (q.sql.startsWith('insert into "place_cover_photos"')) rows.push([...q.parameters]);
          return [];
        }).db,
        regionId: "0190f5c2-7d3e-7000-8000-00000000000a",
        existing: new Set(),
        write: true,
        fetch: fetchImpl,
        resize,
        wikimediaOnly: true,
        retryDelaysMs: [1000],
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    // w1: 429 → пауза 3 с → записана; w2: 404 — без обложки (Google не подставляется); g: нет фото Commons.
    expect(stats).toMatchObject({ written: 1, wikimedia: 1, google: 0, failed: 1, noWikiImage: 1 });
    expect(sleeps).toEqual([3000]);
    expect(vi.mocked(fetchImpl).mock.calls.every((c) => String(c[0]).includes("wikimedia"))).toBe(true);
    expect(google.requests).toMatchObject({ photoMedia: 0, photoDownload: 0, details: 0, detailsIds: 0 });
    // Автор и лицензия Commons сохраняются с файлом.
    expect(JSON.stringify(rows)).toContain("MSha");
    expect(JSON.stringify(rows)).toContain("CC BY-SA 4.0");
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
