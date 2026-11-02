import { parseEnv } from "@tg/server-config";
import { describe, expect, it } from "vitest";
import { botEnvSchema, listenPort } from "./config.js";

describe("botEnvSchema", () => {
  it("local стартует без внешних сервисов", () => {
    expect(parseEnv("bot", botEnvSchema, {}).APP_ENV).toBe("local");
  });

  it("staging без секретов не стартует и не печатает значения", () => {
    const run = () =>
      parseEnv("bot", botEnvSchema, { APP_ENV: "staging", DATABASE_URL: "mysql://u:LEAKED@h/db" });
    expect(run).toThrow(/обязательна при APP_ENV=staging/);
    expect(run).not.toThrow(/LEAKED/);
  });

  const staging = {
    APP_ENV: "staging",
    TELEGRAM_BOT_TOKEN: "1:x",
    TELEGRAM_WEBHOOK_SECRET: "s",
    PUBLIC_API_URL: "https://api.example",
    PUBLIC_MINIAPP_URL: "https://m.example",
    REDIS_URL: "rediss://r.example:6379",
  };

  it("staging с полным набором стартует; порт BOT_PORT → PORT → 4306", () => {
    expect(listenPort(parseEnv("bot", botEnvSchema, staging))).toBe(4306);
    expect(listenPort(parseEnv("bot", botEnvSchema, { ...staging, PORT: "10000" }))).toBe(10000);
    expect(listenPort(parseEnv("bot", botEnvSchema, { ...staging, PORT: "10000", BOT_PORT: "4400" }))).toBe(
      4400,
    );
  });

  it("REDIS_URL обязателен в staging", () => {
    expect(() => parseEnv("bot", botEnvSchema, { ...staging, REDIS_URL: "" })).toThrow(
      /REDIS_URL: обязательна/,
    );
  });

  it("в staging PUBLIC_MINIAPP_URL и BOT_PUBLIC_URL только https; в local http допустим", () => {
    expect(() =>
      parseEnv("bot", botEnvSchema, { ...staging, PUBLIC_MINIAPP_URL: "http://m.example" }),
    ).toThrow(/PUBLIC_MINIAPP_URL: при APP_ENV=staging нужен https/);
    expect(() => parseEnv("bot", botEnvSchema, { ...staging, BOT_PUBLIC_URL: "http://b.example" })).toThrow(
      /BOT_PUBLIC_URL/,
    );
    expect(parseEnv("bot", botEnvSchema, { PUBLIC_MINIAPP_URL: "http://localhost:4301" }).APP_ENV).toBe(
      "local",
    );
  });

  it("TELEGRAM_MINIAPP_LINK только https", () => {
    expect(() => parseEnv("bot", botEnvSchema, { TELEGRAM_MINIAPP_LINK: "http://t.me/b/a" })).toThrow(
      /TELEGRAM_MINIAPP_LINK/,
    );
  });
});
