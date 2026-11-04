// Unit: аргументы CLI, кэш и лимит клиента Google, выгрузка с пагинацией и дедупом (без сети и БД).
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseImportArgs, photoStorageEnv } from "./args.js";
import { collect } from "./collect.js";
import { IMPORT_LOCALITIES, SEARCH_ZONES } from "./config.js";
import {
  GoogleApiError,
  GooglePlacesClient,
  isAllowedPhotoUrl,
  RequestLimitError,
  SEARCH_FIELD_MASK,
  SEARCH_FIELD_MASKS,
} from "./google-client.js";
import type { GooglePlace, MappedPlace } from "./mapping.js";
import { photoCandidates, photosToAdd } from "./photos.js";

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
    expect(() => parseImportArgs(["--fields", "cheap"])).toThrow(/full, enterprise или pro/);
    expect(() => parseImportArgs(["--zones-only", "--query", "Говерла=nature"])).toThrow(/несовместимы/);
  });

  it("--zones-only (только новые места), --search, --fields, --plan (без записи)", () => {
    expect(parseImportArgs([])).toMatchObject({
      fields: "full",
      zonesOnly: false,
      insertOnly: false,
      searches: [],
      plan: false,
    });
    expect(
      parseImportArgs(["--zones-only", "--fields=enterprise", "--search", "Нова пошта відділення", "--plan"]),
    ).toMatchObject({
      zonesOnly: true,
      insertOnly: true,
      fields: "enterprise",
      searches: ["Нова пошта відділення"],
      plan: true,
      dryRun: true,
    });
    expect(parseImportArgs(["--insert-only"]).insertOnly).toBe(true);
  });

  it("--fields enterprise|pro в записи — только с --insert-only/--zones-only; без записи — можно", () => {
    expect(() => parseImportArgs(["--fields", "pro"])).toThrow(/только с --insert-only/);
    expect(() => parseImportArgs(["--fields", "enterprise", "--region", "r"])).toThrow(
      /только с --insert-only/,
    );
    expect(parseImportArgs(["--fields", "pro", "--insert-only"]).fields).toBe("pro");
    expect(parseImportArgs(["--fields", "pro", "--zones-only"]).fields).toBe("pro");
    expect(parseImportArgs(["--fields", "pro", "--dry-run"]).fields).toBe("pro");
    expect(parseImportArgs(["--fields", "full"]).fields).toBe("full");
  });
});

describe("фото: только вставленные при --insert-only", () => {
  const m = (id: string) => ({ googlePlaceId: id }) as MappedPlace;
  it("insertOnly — только новые; иначе все", () => {
    const places = [m("a"), m("b"), m("c")];
    expect(photoCandidates(places, ["b"], true).map((p) => p.googlePlaceId)).toEqual(["b"]);
    expect(photoCandidates(places, [], true)).toEqual([]);
    expect(photoCandidates(places, ["b"], false).map((p) => p.googlePlaceId)).toEqual(["a", "b", "c"]);
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
    const c = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 9,
      fetch,
      maxRateRetries: 0,
    });
    await expect(c.searchText(body)).rejects.toThrow(/429/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("--fields: маска SKU в заголовке, свой файл кэша; ответ с полной маской годится и дешёвой", async () => {
    const fetch = vi.fn(async () => ok({ places: [place("a")] }));
    const pro = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 9,
      fetch,
      searchFields: "pro",
    });
    await pro.searchText(body);
    const mask = (
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    )["X-Goog-FieldMask"];
    expect(mask).toBe(SEARCH_FIELD_MASKS.pro);
    expect(mask).not.toMatch(/editorialSummary|internationalPhoneNumber|regularOpeningHours|rating/);
    expect(SEARCH_FIELD_MASKS.enterprise).toMatch(/internationalPhoneNumber/);
    expect(SEARCH_FIELD_MASKS.enterprise).not.toMatch(/editorialSummary/);
    // Населённый пункт из адреса — SKU Pro (как адрес): во всех масках.
    for (const m of Object.values(SEARCH_FIELD_MASKS)) expect(m).toMatch(/places\.addressComponents/);
    // Полная маска не берёт ответ pro (нет телефона/часов) — запрос; а enterprise берёт уже полный ответ.
    const full = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 9, fetch });
    await full.searchText(body);
    expect(full.requests.search).toBe(1);
    const ent = new GooglePlacesClient({
      apiKey: undefined,
      cacheDir: dir,
      maxRequests: 0,
      fetch,
      searchFields: "enterprise",
    });
    expect((await ent.searchText(body)).fields).toBe("full");
    expect(ent.cacheHits).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    // forgetSearch — только файл своей маски: полный ответ остаётся, pro удалён.
    expect(await readdir(dir)).toHaveLength(2);
    await pro.forgetSearch(body, "pro");
    expect(await readdir(dir)).toHaveLength(1);
    expect((await ent.searchText(body)).fields).toBe("full");
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

  it("--zones-only: запросы только по зонам; место зоны — к ближайшему пункту зоны", async () => {
    const dora = SEARCH_ZONES.find((z) => z.code === "dora")!;
    const fetch = vi.fn(async () =>
      ok({ places: [place("np1", { location: { latitude: 48.48526, longitude: 24.59394 } })] }),
    );
    const client = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 50, fetch });
    const { places, stats } = await collect(client, { zones: [dora], zonesOnly: true, queries: ["q"] });
    expect(stats.queriesTotal).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(places.map((p) => [p.googlePlaceId, p.localityCode])).toEqual([["np1", "yaremche"]]);
    // Без --zones-only — ещё и круги всех пунктов.
    const all = await collect(client, { zones: [dora], queries: ["q"] });
    expect(all.stats.queriesTotal).toBe(IMPORT_LOCALITIES.length + 1);
  });

  it("--plan: запросы мимо кэша только считаются, в Google не ходим", async () => {
    const fetch = vi.fn();
    const client = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 50,
      fetch,
      planOnly: true,
    });
    const { stats } = await collect(client, { zonesOnly: true, queries: ["a", "b"] });
    expect(fetch).not.toHaveBeenCalled();
    expect(client.planned.search).toBe(SEARCH_ZONES.length * 2);
    expect(stats.limitReached).toBe(false);
    expect(stats.zones).toEqual({
      queries: SEARCH_ZONES.length * 2,
      googleRequests: 0,
      planned: SEARCH_ZONES.length * 2,
      cacheHits: 0,
    });
  });

  it("статистика зон отдельно от кругов пунктов", async () => {
    const fetch = vi.fn(async () => ok({}));
    const client = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 50, fetch });
    const { stats } = await collect(client, { queries: ["q"] });
    expect(client.requests.search).toBe(IMPORT_LOCALITIES.length + SEARCH_ZONES.length);
    expect(stats.zones).toMatchObject({ queries: SEARCH_ZONES.length, googleRequests: SEARCH_ZONES.length });
  });

  it("дубль места: полная версия (full) вытесняет дешёвую (pro), в каком бы порядке ни пришли", async () => {
    const one = [IMPORT_LOCALITIES[0]!];
    // Ответ на «2» — в кэше полной маски (с телефоном).
    const richFetch = vi.fn(async () =>
      ok({ places: [place("a", { internationalPhoneNumber: "+380987930729" })] }),
    );
    const full = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 9, fetch: richFetch });
    await collect(full, { localities: one, queries: ["2"] });
    // Клиент pro: «1» — свежий ответ pro (без телефона), «2» — полный из кэша.
    const proFetch = vi.fn(async () => ok({ places: [place("a")] }));
    const pro = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 9,
      fetch: proFetch,
      searchFields: "pro",
    });
    const { places } = await collect(pro, { localities: one, queries: ["1", "2"] });
    expect(proFetch).toHaveBeenCalledTimes(1);
    expect(places.map((p) => [p.googlePlaceId, p.phone])).toEqual([["a", "+380987930729"]]);
  });

  it("маска pro: паркинг без числа отзывов не «не наш» — не в rejectedIds (не архивируется)", async () => {
    const fetch = vi.fn(async () => ok({ places: [place("pk", { primaryType: "parking" })] }));
    const pro = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 9,
      fetch,
      searchFields: "pro",
    });
    const r = await collect(pro, { localities: [IMPORT_LOCALITIES[0]!], queries: ["q"] });
    expect(r.places).toEqual([]);
    expect(r.rejectedIds).toEqual([]);
    expect(r.stats.skipped.unverified).toBe(1);
    // Полная маска — прежнее правило: без отзывов паркинг «не наш».
    const full = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 9, fetch });
    const f = await collect(full, { localities: [IMPORT_LOCALITIES[0]!], queries: ["z"] });
    expect(f.rejectedIds).toEqual(["pk"]);
  });

  it("записи номерів Booking і однакові назви в 50 м — одне місце; відкинуті — у rejectedIds (архів)", async () => {
    const at = IMPORT_LOCALITIES[0]!.at;
    const fetch = vi.fn(async () =>
      ok({
        places: [
          place("main", {
            displayName: { text: "Садиба Казка" },
            primaryType: "lodging",
            userRatingCount: 9,
          }),
          place("room1", { displayName: { text: "Садиба Казка - Double Room" }, primaryType: "lodging" }),
          place("room2", {
            displayName: { text: "Садиба «Казка» - Two-Bedroom Villa" },
            primaryType: "lodging",
            location: { latitude: at.lat + 0.0003, longitude: at.lon },
          }),
          place("taxi", { displayName: { text: "Приватне таксі Ворохта" }, primaryType: "lodging" }),
        ],
      }),
    );
    const client = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 9, fetch });
    const r = await collect(client, { localities: [IMPORT_LOCALITIES[0]!], queries: ["q"] });
    expect(r.places.map((p) => [p.googlePlaceId, p.categoryCode, p.name])).toEqual([
      ["main", "sadyby", "Садиба Казка"],
      ["taxi", "taxi", "Приватне таксі Ворохта"],
    ]);
    expect(r.rejectedIds.sort()).toEqual(["room1", "room2"]);
    expect(r.stats.skipped.duplicate).toBe(2);
    expect(r.stats.imported).toBe(2);
    expect(r.stats.byCategory).toEqual({ sadyby: 1, taxi: 1 });
  });

  it("дубли не номеров Booking — не пишутся и не архивируются; остаётся опубликованная запись", async () => {
    const fetch = vi.fn(async () =>
      ok({
        places: [
          place("w1", { displayName: { text: "Водоспад Капливець" }, primaryType: "natural_feature" }),
          place("w2", { displayName: { text: "Водоспад  Капливець" }, primaryType: "natural_feature" }),
        ],
      }),
    );
    const client = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 9, fetch });
    const opts = { localities: [IMPORT_LOCALITIES[0]!], queries: ["q"] };
    const first = await collect(client, { ...opts, publishedIds: new Set(["w2"]) });
    expect(first.places.map((p) => p.googlePlaceId)).toEqual(["w2"]);
    expect(first.rejectedIds).toEqual([]);
    expect(first.stats.duplicatesSkipped).toBe(1);
    // Повтор (из кэша) с тем же набором опубликованных — тот же выбор.
    const again = await collect(client, { ...opts, publishedIds: new Set(["w2"]) });
    expect(again.places.map((p) => p.googlePlaceId)).toEqual(["w2"]);
    // Не опубліковано нічого, але w2 уже в БД (архів) — лишається w2, архівований дубль не вставляється новим w1.
    const archived = await collect(client, { ...opts, existingIds: new Set(["w2"]) });
    expect(archived.places.map((p) => p.googlePlaceId)).toEqual(["w2"]);
  });
});

describe("--photos: хранилище", () => {
  const neon = "postgres://u:p@ep-x.eu-central-1.aws.neon.tech/db";
  it("local — только с локальной БД и APP_ENV=local", () => {
    expect(photoStorageEnv({ DATABASE_URL: "postgres://u:p@localhost:5432/db" }).STORAGE_DRIVER).toBe(
      "local",
    );
    expect(
      photoStorageEnv({ DATABASE_URL: "postgres://u:p@127.0.0.1/db", STORAGE_DRIVER: "local" })
        .STORAGE_DRIVER,
    ).toBe("local");
    expect(() => photoStorageEnv({ DATABASE_URL: neon })).toThrow(/s3/);
    expect(() => photoStorageEnv({ DATABASE_URL: neon, APP_ENV: "local" })).toThrow(/s3/);
    expect(() =>
      photoStorageEnv({ DATABASE_URL: "postgres://u:p@localhost/db", APP_ENV: "staging" }),
    ).toThrow(/s3/);
    expect(() => photoStorageEnv({ DATABASE_URL: "postgres://u:p@localhost/db?host=remote" })).toThrow(/s3/);
    expect(() => photoStorageEnv({})).toThrow(/s3/);
  });
  it("s3 — с любой БД; неизвестный драйвер — ошибка", () => {
    expect(photoStorageEnv({ DATABASE_URL: neon, STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toMatchObject({
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "b",
    });
    expect(() => photoStorageEnv({ STORAGE_DRIVER: "ftp" })).toThrow(/local или s3/);
  });
});

describe("клиент Google: фото и формат ответов", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gp-photo-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("разрешённые адреса фото — только https на хостах Google", () => {
    expect(isAllowedPhotoUrl("https://lh3.googleusercontent.com/p/abc=w1600")).toBe(true);
    expect(isAllowedPhotoUrl("https://lh5.ggpht.com/x")).toBe(true);
    expect(isAllowedPhotoUrl("https://places.googleapis.com/v1/x")).toBe(false);
    expect(isAllowedPhotoUrl("http://lh3.googleusercontent.com/x")).toBe(false);
    expect(isAllowedPhotoUrl("https://evil.com/googleusercontent.com")).toBe(false);
    expect(isAllowedPhotoUrl("https://googleusercontent.com.evil.com/x")).toBe(false);
    expect(isAllowedPhotoUrl("https://lh3.googleusercontent.com:8443/x")).toBe(false);
    expect(isAllowedPhotoUrl("not a url")).toBe(false);
  });

  it("редирект на чужой хост — ошибка; на хост Google — следуем вручную", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("first")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://lh4.googleusercontent.com/second" },
          })
        : url.includes("second")
          ? new Response(new Uint8Array([1, 2, 3]))
          : new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    );
    const c = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 10,
      fetch: fetch as typeof globalThis.fetch,
    });
    expect([...(await c.photoBytes("places/a/photos/1", "https://lh3.googleusercontent.com/first"))]).toEqual(
      [1, 2, 3],
    );
    expect(
      fetch.mock.calls.every((call) => (call as unknown as [string, RequestInit])[1].redirect === "manual"),
    ).toBe(true);
    await expect(c.photoBytes("places/a/photos/2", "https://lh3.googleusercontent.com/bad")).rejects.toThrow(
      /хосте Google/,
    );
    await expect(c.photoBytes("places/a/photos/3", "https://evil.example/x")).rejects.toThrow(/хосте Google/);
  });

  it("фото больше лимита — ошибка, в кэш не пишется", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array(100)));
    const c = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 10, fetch });
    await expect(
      c.photoBytes("places/a/photos/1", "https://lh3.googleusercontent.com/x", 50),
    ).rejects.toThrow(/больше/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("испорченный ответ в кэше — запрашивается заново; неожиданный формат ответа Google — ошибка", async () => {
    const body = {
      textQuery: "кафе",
      languageCode: "uk",
      regionCode: "UA",
      pageSize: 20,
      locationRestriction: {
        rectangle: { low: { latitude: 1, longitude: 1 }, high: { latitude: 2, longitude: 2 } },
      },
    };
    const good = vi.fn(async () => ok({ places: [place("a")] }));
    const c = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 10, fetch: good });
    await c.searchText(body);
    const [file] = await readdir(dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, file!), JSON.stringify({ places: "oops" }));
    const c2 = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 10, fetch: good });
    expect((await c2.searchText(body)).places).toHaveLength(1);
    expect(c2.requests.search).toBe(1);
    const bad = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 10,
      fetch: vi.fn(async () => ok([1])),
    });
    await expect(bad.searchText({ ...body, textQuery: "x" })).rejects.toThrow(/формат/);
  });
});

describe("выгрузка: устаревший токен и закрытые", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gp-token-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("400 на странице с pageToken — страница пропущена, кэш первой страницы сброшен; закрытые — в closedIds", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { pageToken?: string };
      if (b.pageToken) return new Response("INVALID_ARGUMENT", { status: 400 });
      return ok({
        places: [place("a"), place("z", { businessStatus: "CLOSED_PERMANENTLY" })],
        nextPageToken: "old",
      });
    });
    const client = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 10,
      fetch: fetch as typeof globalThis.fetch,
    });
    const r = await collect(client, { localities: IMPORT_LOCALITIES.slice(0, 1), queries: ["q"] });
    expect(r.stats.pagesFailed).toBe(1);
    expect(r.stats.queriesDone).toBe(1);
    expect(r.places.map((p) => p.googlePlaceId)).toEqual(["a"]);
    expect(r.closedIds).toEqual(["z"]);
    expect(r.seenIds.sort()).toEqual(["a", "z"]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("400 на первой странице — ошибка прогона", async () => {
    const fetch = vi.fn(async () => new Response("bad", { status: 400 }));
    const client = new GooglePlacesClient({ apiKey: "k", cacheDir: dir, maxRequests: 10, fetch });
    await expect(
      collect(client, { localities: IMPORT_LOCALITIES.slice(0, 1), queries: ["q"] }),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });
});
