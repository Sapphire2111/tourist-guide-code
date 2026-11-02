// Unit: суточный бюджет ассистента — единицы, ключи хранилища rate limit (Redis), окно до конца суток UTC,
// запасной счёт в памяти при сбое Redis.
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "../../common/http/index.js";
import type { RateLimitKey, RateLimitStore } from "../rate-limit/index.js";
import { AssistantBudget } from "./budget.js";

afterEach(() => vi.restoreAllMocks());

const status = (e: unknown) => (e as ApiError).getStatus();

describe("AssistantBudget", () => {
  it("голос — 2 единицы: ключи общий и пользователя, окно — до конца суток UTC", async () => {
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
    expect(calls[0]!.map((k) => k.key)).toEqual([
      "assistant:day:2026-11-03",
      "assistant:day:2026-11-03:u:u1",
      "assistant:day:2026-11-03",
      "assistant:day:2026-11-03:u:u1",
    ]);
    expect(calls[0]![0]!.windowMs).toBe(3600_000 + 60_000);
  });

  it("Redis недоступен — счёт в памяти процесса, предел действует", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const store: RateLimitStore = { hit: () => Promise.reject(new Error("redis down")) };
    const budget = new AssistantBudget({ userDailyLimit: 3 }, store);
    await budget.spend("u1", 2);
    await budget.spend("u1", 1);
    expect(status(await budget.spend("u1", 1).catch((e: unknown) => e))).toBe(429);
  });
});
