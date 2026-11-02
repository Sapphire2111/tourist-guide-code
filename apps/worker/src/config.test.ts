import { parseEnv } from "@tg/server-config";
import { describe, expect, it } from "vitest";
import { workerEnvSchema } from "./config.js";

const REDIS_URL = "redis://localhost:4304";

describe("workerEnvSchema", () => {
  it("local стартует только с REDIS_URL", () => {
    const env = parseEnv("worker", workerEnvSchema, { REDIS_URL });
    expect(env.APP_ENV).toBe("local");
    expect(env.REDIS_URL).toBe(REDIS_URL);
  });

  it("REDIS_URL обязателен во всех окружениях, включая local", () => {
    expect(() => parseEnv("worker", workerEnvSchema, {})).toThrow(
      /REDIS_URL: обязательная переменная не задана/,
    );
    expect(() => parseEnv("worker", workerEnvSchema, { REDIS_URL: "  " })).toThrow(/REDIS_URL/);
  });

  it("REDIS_URL — только redis:// или rediss://, значение не печатается", () => {
    expect(parseEnv("worker", workerEnvSchema, { REDIS_URL: "rediss://u:p@h:6379" }).REDIS_URL).toMatch(
      /^rediss:/,
    );
    const run = () => parseEnv("worker", workerEnvSchema, { REDIS_URL: "http://u:LEAKED@h" });
    expect(run).toThrow(/REDIS_URL: ожидается URL со схемой redis \| rediss/);
    expect(run).not.toThrow(/LEAKED/);
  });

  it("staging без секретов не стартует и не печатает значения", () => {
    const run = () =>
      parseEnv("worker", workerEnvSchema, {
        APP_ENV: "staging",
        REDIS_URL: "rediss://u:LEAKED@h:6379",
      });
    expect(run).toThrow(/DATABASE_URL.*обязательна при APP_ENV=staging/s);
    expect(run).not.toThrow(/LEAKED/);
  });
});

describe("QUEUE_METRICS_INTERVAL_MS", () => {
  const parse = (v?: string) =>
    parseEnv("worker", workerEnvSchema, { REDIS_URL, QUEUE_METRICS_INTERVAL_MS: v });
  it("по умолчанию 10 мин, 0 — выключено, ≥ 10 с допустимо", () => {
    expect(parse().QUEUE_METRICS_INTERVAL_MS).toBe(600_000);
    expect(parse("").QUEUE_METRICS_INTERVAL_MS).toBe(600_000);
    expect(parse("0").QUEUE_METRICS_INTERVAL_MS).toBe(0);
    expect(parse("10000").QUEUE_METRICS_INTERVAL_MS).toBe(10_000);
  });
  it.each(["1", "9999", "-1", "2147483648", "abc"])("%s — ошибка конфигурации", (v) => {
    expect(() => parse(v)).toThrow(/QUEUE_METRICS_INTERVAL_MS/);
  });
});
