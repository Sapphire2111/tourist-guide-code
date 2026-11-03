// Unit: точечный импорт по списку запросов (без сети и БД).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseImportArgs } from "./args.js";
import { GooglePlacesClient } from "./google-client.js";
import type { GooglePlace } from "./mapping.js";
import {
  collectTargeted,
  parseQueryFlag,
  parseTargetedQueries,
  pickResults,
  TargetedQueryError,
  type TargetedQuery,
} from "./targeted.js";

const known = {
  categories: new Set(["nature", "museums", "markets", "sights"]),
  localities: new Set(["yaremche", "kosiv"]),
};
const names = { nature: "Пам'ятки природи", museums: "Музеї" };

const gp = (id: string, extra: Partial<GooglePlace> = {}): GooglePlace => ({
  id,
  displayName: { text: `Місце ${id}` },
  location: { latitude: 48.16, longitude: 24.5 },
  types: ["mountain_peak", "natural_feature"],
  primaryType: "mountain_peak",
  ...extra,
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("точечный импорт: аргументы и список", () => {
  it("--queries-file и повторяемый --query", () => {
    const a = parseImportArgs([
      "--queries-file",
      "q.json",
      "--query",
      "Говерла=nature",
      "--query=Скит=sights",
    ]);
    expect(a.queriesFile).toBe(path.resolve("q.json"));
    expect(a.queries).toEqual(["Говерла=nature", "Скит=sights"]);
    expect(parseQueryFlag("Хом'як=nature")).toEqual({ query: "Хом'як", category: "nature" });
    expect(() => parseQueryFlag("Говерла")).toThrow(TargetedQueryError);
  });

  it("проверка полей: категория, пункт, область, take, types", () => {
    expect(
      parseTargetedQueries(
        [{ query: " Говерла ", category: "nature", near: { lon: 24.5, lat: 48.16 }, radiusM: 5000, take: 2 }],
        known,
      ),
    ).toEqual([
      { query: "Говерла", category: "nature", near: { lon: 24.5, lat: 48.16 }, radiusM: 5000, take: 2 },
    ]);
    expect(() => parseTargetedQueries([], known)).toThrow(/непустой/);
    expect(() => parseTargetedQueries([{ query: "x", category: "nope" }], known)).toThrow(/категория/);
    expect(() => parseTargetedQueries([{ query: "x", category: "nature", locality: "lviv" }], known)).toThrow(
      /пункт/,
    );
    expect(() => parseTargetedQueries([{ query: "x", category: "nature", take: 0 }], known)).toThrow(/take/);
    expect(() => parseTargetedQueries([{ query: "x", category: "nature", near: { lon: 1 } }], known)).toThrow(
      /near/,
    );
    expect(() => parseTargetedQueries([{ query: "x", category: "nature", types: [1] }], known)).toThrow(
      /types/,
    );
  });
});

describe("точечный импорт: выбор результатов", () => {
  const q: TargetedQuery = {
    query: "Говерла",
    category: "nature",
    near: { lon: 24.5, lat: 48.16 },
    radiusM: 10_000,
  };

  it("категория из запроса, вне пунктов — без пункта; первый подходящий", () => {
    const [p, ...rest] = pickResults(q, [gp("a"), gp("b")], names, new Set());
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      googlePlaceId: "a",
      categoryCode: "nature",
      localityCode: "",
      name: "Місце a",
    });
    expect(p!.description).toMatch(/на Прикарпатті.*Джерело: Google Maps\.$/);
  });

  it("пропуск: закрыто, вне области, не тот тип, уже взято; take и пункт из запроса", () => {
    const res = [
      gp("closed", { businessStatus: "CLOSED_PERMANENTLY" }),
      gp("far", { location: { latitude: 49.5, longitude: 24.5 } }),
      gp("shop", { primaryType: "food_store", types: ["food_store"] }),
      gp("dup"),
      gp("m1", { primaryType: "museum", types: ["museum"] }),
      gp("m2", { primaryType: "museum", types: ["museum"] }),
      gp("m3", { primaryType: "museum", types: ["museum"] }),
    ];
    const picked = pickResults(
      { ...q, category: "museums", types: ["museum"], take: 2, locality: "kosiv" },
      res,
      names,
      new Set(["dup"]),
    );
    expect(picked.map((p) => [p.googlePlaceId, p.categoryCode, p.localityCode])).toEqual([
      ["m1", "museums", "kosiv"],
      ["m2", "museums", "kosiv"],
    ]);
  });

  it("без типа Google (категория по типам не нашлась) — всё равно берётся с категорией запроса", () => {
    const picked = pickResults(
      q,
      [gp("x", { primaryType: undefined, types: ["establishment"] })],
      names,
      new Set(),
    );
    expect(picked.map((p) => p.categoryCode)).toEqual(["nature"]);
  });
});

describe("точечный импорт: выгрузка", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gp-targeted-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("один запрос на строку, дедуп между запросами, отчёт «не найдено», кэш, лимит", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { textQuery: string };
      if (b.textQuery === "пусто") return ok({});
      return ok({ places: [gp("same")] });
    });
    const client = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: dir,
      maxRequests: 3,
      fetch: fetch as typeof globalThis.fetch,
    });
    const queries: TargetedQuery[] = [
      { query: "Говерла", category: "nature" },
      { query: "Говерла гора", category: "nature" },
      { query: "пусто", category: "nature" },
      { query: "четвертий", category: "nature" },
    ];
    const r = await collectTargeted(client, queries, names);
    expect(r.places.map((p) => p.googlePlaceId)).toEqual(["same"]);
    expect(r.outcomes.map((o) => o.missing ?? "ok")).toEqual([
      "ok",
      expect.stringMatching(/ни один не подошёл/),
      "Google ничего не нашёл",
      "лимит запросов",
    ]);
    expect(r).toMatchObject({ queriesDone: 3, limitReached: true });
    expect(client.requests.search).toBe(3);

    const again = new GooglePlacesClient({
      apiKey: undefined,
      cacheDir: dir,
      maxRequests: 0,
      fetch: vi.fn(),
    });
    expect((await collectTargeted(again, queries.slice(0, 3), names)).places).toHaveLength(1);
    expect(again.totalRequests).toBe(0);
  });
});
