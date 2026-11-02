// T1-24: счётчики rate limit на реальном Redis — один EVALSHA на запрос, окно и сброс по PEXPIRE.
import type { StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { RedisRateLimitStore, type RateLimitHit } from "../../src/modules/rate-limit/index.js";
import { startRedis } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

describe.skipIf(!dockerAvailable)(`Rate limit на Redis (T1-24)${title}`, () => {
  let redis: StartedRedisContainer | undefined;
  let store: RedisRateLimitStore | undefined;

  beforeAll(async () => {
    redis = await startRedis();
    store = RedisRateLimitStore.open(redis.getConnectionUrl());
  });

  afterAll(async () => {
    await store?.close();
    await redis?.stop();
  });

  it("счётчики двух ключей растут за один вызов, срок окна выставлен", async () => {
    const keys = [
      { key: "rl:test:a", windowMs: 60_000 },
      { key: "rl:test:b", windowMs: 2_000 },
    ];
    // Первый вызов может прийти до готовности соединения (без офлайн-очереди) — повторяем.
    let first: RateLimitHit[] | undefined;
    for (let i = 0; i < 50 && !first; i++) {
      first = await store!.hit(keys).catch(() => undefined);
      if (!first) await new Promise((r) => setTimeout(r, 100));
    }
    expect(first!.map((h) => h.count)).toEqual([1, 1]);
    const second = await store!.hit(keys);
    expect(second.map((h) => h.count)).toEqual([2, 2]);
    expect(second[0]!.resetMs).toBeGreaterThan(50_000);
    expect(second[1]!.resetMs).toBeLessThanOrEqual(2_000);
  });

  it("после окна счётчик начинается заново", async () => {
    const k = [{ key: "rl:test:short", windowMs: 200 }];
    await store!.hit(k);
    await store!.hit(k);
    await new Promise((r) => setTimeout(r, 300));
    expect((await store!.hit(k))[0]!.count).toBe(1);
  });
});
