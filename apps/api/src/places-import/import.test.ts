// Unit: аргументы CLI, кэш и лимит клиента Google, выгрузка с пагинацией и дедупом (без сети и БД).
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseImportArgs } from "./args.js";
import { collect } from "./collect.js";
import { IMPORT_LOCALITIES } from "./config.js";
import { GoogleApiError, GooglePlacesClient, RequestLimitError, SEARCH_FIELD_MASK } from "./google-client.js";
import type { GooglePlace } from "./mapping.js";
import { photosToAdd } from "./photos.js";

describe("аргументы", () => {
  it("по умолчанию — запись в test-region, кэш во временном каталоге, лимит 1000", () => {
    const a = parseImportArgs([]);
    expect(a).toMatchObject({ region: "test-region", dryRun: false, photos: false, maxRequests: 1000 });
    expect(a.cacheDir.startsWith(tmpdir())).toBe(true);
  });

  it("--dry-run, --region, --cache, --max-requests=, --report; разделитель pnpm `--`", () => {
    const a = parseImportArgs([
      "--",
      "--dry-run",
      "--region",
      "r1",
      "--cache=/tmp/c",
      "--max-requests=5",
      "--report",
      "x.json",
    ]);
    expect(a).toMatchObject({ region: "r1", dryRun: true, maxRequests: 5 });
    expect(a.cacheDir).toBe(path.resolve("/tmp/c"));
    expect(a.report).toBe(path.resolve("x.json"));
  });

  it("ошибки: неизвестный аргумент, нет значения, плохой лимит, --photos с --dry-run", () => {
    expect(() => parseImportArgs(["--nope"])).toThrow(/неизвестный/);
    expect(() => parseImportArgs(["--region"])).toThrow(/нет значения/);
    expect(() => parseImportArgs(["--region", "--dry-run"])).toThrow(/нет значения/);
    expect(() => parseImportArgs(["--max-requests", "-1"])).toThrow(/целое/);
    expect(() => parseImportArgs(["--dry-run", "--photos"])).toThrow(/несовместим/);
  });
});

describe("фото: сколько догрузить", () => {
  it("до двух, с учётом уже загруженных и доступных у Google", () => {
    expect(photosToAdd(5, 0)).toBe(2);
    expect(photosToAdd(1, 0)).toBe(1);
    expect(photosToAdd(5, 1)).toBe(1);
    expect(photosToAdd(5, 2)).toBe(0);
    expect(photosToAdd(0, 0)).toBe(0);
    expect(photosToAdd(1, 3)).toBe(0);
  });
});

const place = (id: string, over: Partial<GooglePlace> = {}): GooglePlace => ({
  id,
  displayName: { text: `Місце ${id}` },
  location: { latitude: IMPORT_LOCALITIES[0]!.at.lat, longitude: IMPORT_LOCALITIES[0]!.at.lon },
  primaryType: "cafe",
  ...over,
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("клиент Google: кэш, лимит, ключ", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gp-cache-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const body = {
    textQuery: "кафе",
    languageCode: "uk",
    regionCode: "UA",
    pageSize: 20,
    locationRestriction: {
      rectangle: { low: { latitude: 1, longitude: 1 }, high: { latitude: 2, longitude: 2 } },
    },
  };

  it("второй такой же запрос — из кэша; ключ — только в заголовке, в кэш-файл не попадает", async () => {
    const fetch = vi.fn(async () => ok({ places: [place("a")] }));
    const c1 = new GooglePlacesClient({ apiKey: "SECRET-KEY", cacheDir: dir, maxRequests: 10, fetch });
    expect((await c1.searchText(body)).places).toHaveLength(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("SECRET-KEY");
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe(SEARCH_FIELD_MASK);
    const c2 = new GooglePlacesClient({ apiKey: undefined, cacheDir: dir, maxRequests: 0, fetch });
    expect((await c2.searchText(body)).places).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(c2.totalRequests).toBe(0);
    expect(c2.cacheHits).toBe(1);
    for (const f of await readdir(dir))
      expect(await readFile(path.join(dir, f), "utf8")).not.toContain("SECRET");
  });

  it("лимит запросов — RequestLimitError; без ключа и без кэша — ошибка", async () => {
    const fetch = vi.fn(async () => ok({}));
    const c = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 1, fetch });
    await c.searchText(body);
    await expect(c.searchText({ ...body, textQuery: "інше" })).rejects.toBeInstanceOf(RequestLimitError);
    const noKey = new GooglePlacesClient({ apiKey: undefined, cacheDir: dir, maxRequests: 9, fetch });
    await expect(noKey.searchText({ ...body, textQuery: "третє" })).rejects.toBeInstanceOf(GoogleApiError);
  });

  it("ошибка HTTP Google — GoogleApiError, в кэш не пишется", async () => {
    const fetch = vi.fn(async () => new Response("quota", { status: 429 }));
    const c = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 9, fetch });
    await expect(c.searchText(body)).rejects.toThrow(/429/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("имя фото проверяется до запроса", async () => {
    const c = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 9, fetch: vi.fn() });
    await expect(c.photoUri("../../x", 800)).rejects.toBeInstanceOf(GoogleApiError);
  });
});

describe("выгрузка", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gp-collect-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("пагинация по nextPageToken, дедуп по id, пропуски и статистика", async () => {
    const far = { latitude: 48.92, longitude: 24.71 };
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { textQuery: string; pageToken?: string };
      if (b.textQuery !== "q") return ok({});
      if (!b.pageToken)
        return ok({ places: [place("a"), place("b", { primaryType: "pharmacy" })], nextPageToken: "p2" });
      return ok({
        places: [
          place("a"),
          place("c", { businessStatus: "CLOSED_PERMANENTLY" }),
          place("d", { location: far }),
          place("e", { primaryType: "locality", types: ["locality", "political"] }),
        ],
      });
    });
    const client = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 100,
      fetch: fetch as typeof globalThis.fetch,
    });
    const { places, stats } = await collect(client, {
      localities: IMPORT_LOCALITIES.slice(0, 1),
      queries: ["q", "z"],
    });
    expect(places.map((p) => [p.googlePlaceId, p.categoryCode])).toEqual([
      ["a", "cafes"],
      ["b", "pharmacies"],
    ]);
    expect(stats).toMatchObject({
      fetched: 6,
      unique: 5,
      imported: 2,
      skipped: { closed_permanently: 1, outside_radius: 1, no_category: 1 },
      byLocality: { yaremche: 2 },
      byCategory: { cafes: 1, pharmacies: 1 },
      unmappedTypes: { locality: 1 },
      queriesDone: 2,
      queriesTotal: 2,
      limitReached: false,
    });
    expect(client.requests.search).toBe(3);

    // Повтор — целиком из кэша, без запросов.
    const again = new GooglePlacesClient({
      apiKey: undefined,
      cacheDir: dir,
      maxRequests: 0,
      fetch: vi.fn(),
    });
    expect(
      (await collect(again, { localities: IMPORT_LOCALITIES.slice(0, 1), queries: ["q", "z"] })).places,
    ).toHaveLength(2);
    expect(again.totalRequests).toBe(0);
  });

  it("лимит — выгрузка останавливается, результат помечен неполным", async () => {
    const fetch = vi.fn(async () => ok({ places: [place("a")] }));
    const client = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 2, fetch });
    const { places, stats } = await collect(client, { queries: ["1", "2", "3", "4"] });
    expect(stats.limitReached).toBe(true);
    expect(stats.queriesDone).toBe(2);
    expect(places).toHaveLength(1);
  });
});
