// Unit: 429 от Google — поминутная квота (ожидание и повтор, затем место откладывается), суточная (остановка Google),
// предохранитель, темп --rpm. Без сети: fetch и пауза подменены.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GoogleDailyQuotaError,
  GooglePlacesClient,
  GoogleRateLimitedError,
  isLongQuota429,
} from "../places-import/google-client.js";
import type { MappedPlace } from "../places-import/mapping.js";
import { parseEnrichArgs } from "./args.js";
import { enrich } from "./enrich.js";

const tmp = () => mkdtemp(path.join(tmpdir(), "tg-rl-"));
const MINUTE_BODY = JSON.stringify({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Quota exceeded for quota metric 'GetPlaceRequest' and limit 'GetPlaceRequest per minute'",
    details: [{ reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_unit: "1/min/{project}" } }],
  },
});
// Google ставит RATE_LIMIT_EXCEEDED и для суточных квот; "per day" стоит далеко от начала тела.
const DAY_BODY = JSON.stringify({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: `${"x".repeat(700)} Quota exceeded for limit 'GetPlaceRequest per day'`,
    details: [{ reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_unit: "1/d/{project}" } }],
  },
});
const r429 = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 429, headers });
const ok = (id: string) => new Response(JSON.stringify({ id, photos: [] }), { status: 200 });

const place = (id: string): MappedPlace =>
  ({
    googlePlaceId: id,
    categoryCode: "restaurants",
    extraCategoryCodes: [],
    localityCode: "yaremche",
    name: id,
    description: "",
    address: "",
    at: { lon: 24.5, lat: 48.4 },
  }) as unknown as MappedPlace;

const make = async (fetchMock: unknown, extra: Record<string, unknown> = {}) => {
  const sleeps: number[] = [];
  const client = new GooglePlacesClient({
    apiKey: "k",
    cacheDir: await tmp(),
    maxRequests: 100,
    fetch: fetchMock as typeof fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
    ...extra,
  });
  return { client, sleeps };
};

describe("Google 429", () => {
  it("классификация по полному телу", () => {
    expect(isLongQuota429(MINUTE_BODY)).toBe(false);
    expect(isLongQuota429(DAY_BODY)).toBe(true);
    expect(isLongQuota429("limit per month")).toBe(true);
  });

  it("поминутная квота: ждёт 60 с (или Retry-After) и повторяет", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(r429(MINUTE_BODY))
      .mockResolvedValueOnce(r429(MINUTE_BODY, { "retry-after": "7" }))
      .mockResolvedValueOnce(ok("A"));
    const { client, sleeps } = await make(f);
    const res = await client.placePhotos("A");
    expect(res?.id).toBe("A");
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([60_000, 7_000]);
    expect(client.waitedMs).toBe(67_000);
    expect(client.rateLimitHits).toBe(2);
  });

  it("повторы исчерпаны: место откладывается (Details отложен — placePhotos не зовётся), прогон идёт", async () => {
    const f = vi.fn((url: string) =>
      Promise.resolve(url.includes("/places/B") ? r429(MINUTE_BODY) : ok("C")),
    );
    const { client, sleeps } = await make(f, { maxRateRetries: 2 });
    const r = await enrich([place("B"), place("C")], client, undefined, {
      rawById: new Map([["B", { id: "B" }]]),
      log: () => undefined,
    });
    expect(r.stats.rateLimited).toBe(1);
    expect(r.stats.detailsDeferred).toBe(1);
    expect(r.stats.details).toBe(1);
    expect(r.places).toHaveLength(2);
    expect(sleeps).toHaveLength(2);
    // 3 попытки Details для B + 1 для C, фото для B не запрашивались.
    expect(f).toHaveBeenCalledTimes(4);
    expect(client.rateLimitedGiveUps).toBe(1);
  });

  it("суточная квота + RATE_LIMIT_EXCEEDED: без ожидания, Google остановлен, прогон завершается", async () => {
    const f = vi.fn(() => Promise.resolve(r429(DAY_BODY)));
    const { client, sleeps } = await make(f);
    const r = await enrich([place("A"), place("B"), place("C")], client, undefined);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(r.stats.googleLimitReached).toBe(true);
    expect(r.stats.detailsDeferred).toBe(3);
    expect(r.places).toHaveLength(3);
    await expect(client.placePhotos("Z")).rejects.toBeInstanceOf(GoogleDailyQuotaError);
  });

  it("после остановки не списывается месячная квота и счётчик запросов", async () => {
    const f = vi.fn(() => Promise.resolve(r429(DAY_BODY)));
    const quota = vi.fn(() => Promise.resolve(true));
    const { client } = await make(f, { quota });
    await enrich([place("A"), place("B"), place("C")], client, undefined);
    expect(quota).toHaveBeenCalledTimes(1);
    expect(client.requests.details).toBe(1);
  });

  it("предохранитель: 2 места подряд отложены после повторов — Google остановлен", async () => {
    const f = vi.fn(() => Promise.resolve(r429(MINUTE_BODY)));
    const { client } = await make(f, { maxRateRetries: 1 });
    await expect(client.placeDetails("A")).rejects.toBeInstanceOf(GoogleRateLimitedError);
    await expect(client.placeDetails("B")).rejects.toBeInstanceOf(GoogleRateLimitedError);
    const calls = f.mock.calls.length;
    await expect(client.placeDetails("C")).rejects.toBeInstanceOf(GoogleDailyQuotaError);
    expect(f).toHaveBeenCalledTimes(calls);
  });

  it("сообщение отложенного 429 содержит HTTP 429", async () => {
    const f = vi.fn(() => Promise.resolve(r429(MINUTE_BODY)));
    const { client } = await make(f, { maxRateRetries: 0 });
    await expect(client.placeDetails("A")).rejects.toThrow(/HTTP 429/);
  });
});

describe("--rpm", () => {
  it("равномерный темп: между запросами пауза 60000/rpm", async () => {
    let t = 1_000_000;
    const f = vi.fn((url: string) => Promise.resolve(ok(url.split("/places/")[1]!.split("?")[0]!)));
    const sleeps: number[] = [];
    const client = new GooglePlacesClient({
      apiKey: "k",
      cacheDir: await tmp(),
      maxRequests: 100,
      fetch: f as unknown as typeof fetch,
      rpm: 30,
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    await client.placePhotos("A");
    await client.placePhotos("B");
    await client.placePhotos("C");
    expect(sleeps).toEqual([2000, 2000]);
    expect(client.waitedMs).toBe(4000);
  });

  it("аргумент разбирается, по умолчанию 30", () => {
    expect(parseEnrichArgs([]).rpm).toBe(30);
    expect(parseEnrichArgs(["--rpm", "10"]).rpm).toBe(10);
  });
});
