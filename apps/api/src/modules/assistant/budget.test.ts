// Unit: суточный бюджет ассистента — единицы, ключи хранилища rate limit (Redis), окно до конца суток UTC,
// пользователь — раньше общего счётчика, запасной счёт в памяти при сбое Redis.
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "../../common/http/index.js";
import { MemoryRateLimitStore, type RateLimitKey, type RateLimitStore } from "../rate-limit/index.js";
import { AssistantBudget } from "./budget.js";

afterEach(() => vi.restoreAllMocks());

const status = (e: unknown) => (e as ApiError).getStatus();

describe("AssistantBudget", () => {
  it("голос — 2 единицы: сначала ключ пользователя, затем общий; окно — до конца суток UTC", async () => {
    const calls: RateLimitKey[][] = [];
    const store: RateLimitStore = {
      hit: (keys) => {
        calls.push([...keys]);
        return Promise.resolve(keys.map((_, i) => ({ count: i + 1, resetMs: 1 })));
      },
    };
    const budget = new AssistantBudget({}, store);
    budget.now = () => new Date("2026-11-03T23:00:00Z");
    await budget.spend("u1", 2);
    expect(calls.map((c) => c.map((k) => k.key))).toEqual([
      ["assistant:day:2026-11-03:u:u1", "assistant:day:2026-11-03:u:u1"],
      ["assistant:day:2026-11-03", "assistant:day:2026-11-03"],
    ]);
    expect(calls[0]![0]!.windowMs).toBe(3600_000 + 60_000);
  });

  it("сверх предела пользователя общий счётчик не растёт: один пользователь не исчерпает бюджет всех", async () => {
    const store = new MemoryRateLimitStore();
    const budget = new AssistantBudget({ userDailyLimit: 2, dailyLimit: 3 }, store);
    await budget.spend("u1", 1);
    await budget.spend("u1", 1);
    for (let i = 0; i < 5; i++)
      expect(status(await budget.spend("u1", 1).catch((e: unknown) => e))).toBe(429);
    // Общий: 2 из 3 — у другого пользователя ещё одна единица.
    await budget.spend("u2", 1);
    expect(status(await budget.spend("u2", 1).catch((e: unknown) => e))).toBe(503);
  });

  it("Redis недоступен — счёт в памяти процесса, предел действует; предупреждение — не чаще раза в минуту", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const store: RateLimitStore = { hit: () => Promise.reject(new Error("redis down")) };
    const budget = new AssistantBudget({ userDailyLimit: 3 }, store);
    let t = Date.parse("2026-11-03T10:00:00Z");
    budget.now = () => new Date(t);
    await budget.spend("u1", 2);
    await budget.spend("u1", 1);
    expect(status(await budget.spend("u1", 1).catch((e: unknown) => e))).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    t += 61_000;
    await budget.spend("u2", 1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
