import { describe, expect, it } from "vitest";
import {
  ConfigError,
  baseEnvShape,
  commaList,
  optionalString,
  optionalUrl,
  parseEnv,
  port,
  requireInEnvs,
  requiredString,
  urlWith,
  z,
} from "./index.js";

const schema = z.object({
  ...baseEnvShape,
  PORT: port(4300),
  DATABASE_URL: urlWith("postgres", "postgresql"),
  TELEGRAM_BOT_TOKEN: requiredString(),
  CORS_ORIGINS: commaList(),
});

const SECRET = "123456:SUPER-SECRET-token";
const valid = {
  DATABASE_URL: "postgresql://u:p4ssw0rd@localhost:5432/db",
  TELEGRAM_BOT_TOKEN: SECRET,
};

describe("parseEnv", () => {
  it("применяет значения по умолчанию", () => {
    const cfg = parseEnv("test", schema, valid);
    expect(cfg).toMatchObject({
      NODE_ENV: "development",
      APP_ENV: "local",
      LOG_LEVEL: "info",
      PORT: 4300,
      CORS_ORIGINS: [],
    });
  });

  it("приводит типы и разбирает списки", () => {
    const cfg = parseEnv("test", schema, {
      ...valid,
      PORT: "8080",
      CORS_ORIGINS: "http://a, http://b,",
      APP_ENV: "staging",
    });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.CORS_ORIGINS).toEqual(["http://a", "http://b"]);
    expect(cfg.APP_ENV).toBe("staging");
  });

  it("падает без обязательной переменной и называет её", () => {
    expect(() => parseEnv("api", schema, { DATABASE_URL: valid.DATABASE_URL })).toThrow(
      /TELEGRAM_BOT_TOKEN: обязательная переменная не задана/,
    );
  });

  it("пустая строка = не задано", () => {
    expect(() => parseEnv("api", schema, { ...valid, TELEGRAM_BOT_TOKEN: "" })).toThrow(
      /TELEGRAM_BOT_TOKEN: обязательная/,
    );
  });

  it("собирает все ошибки сразу", () => {
    try {
      parseEnv("api", schema, { APP_ENV: "dev", PORT: "99999" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain("[api]");
      expect(msg).toMatch(/APP_ENV: допустимые значения: local, staging, prod/);
      expect(msg).toContain("PORT");
      expect(msg).toContain("DATABASE_URL");
      expect(msg).toContain("TELEGRAM_BOT_TOKEN");
    }
  });

  it("не выводит значения секретов в сообщение", () => {
    const badUrl = "mysql://user:p4ssw0rd-LEAK@host/db";
    try {
      parseEnv("api", schema, {
        DATABASE_URL: badUrl,
        TELEGRAM_BOT_TOKEN: SECRET,
        PORT: SECRET,
        LOG_LEVEL: SECRET,
      });
      expect.unreachable();
    } catch (e) {
      const err = e as ConfigError;
      const dump = `${err.message}\n${JSON.stringify(err)}\n${String(err.stack)}`;
      expect(err.message).toContain("DATABASE_URL: ожидается URL");
      expect(dump).not.toContain("p4ssw0rd");
      expect(dump).not.toContain("SUPER-SECRET");
    }
  });
});

describe("requireInEnvs", () => {
  const s = z
    .object({ ...baseEnvShape, REDIS_URL: urlWith("redis", "rediss").optional() })
    .superRefine(requireInEnvs(["REDIS_URL"]));

  it("в local переменная необязательна", () => {
    expect(parseEnv("worker", s, {}).REDIS_URL).toBeUndefined();
  });

  it("в staging/prod — обязательна", () => {
    expect(() => parseEnv("worker", s, { APP_ENV: "staging" })).toThrow(
      /REDIS_URL: обязательна при APP_ENV=staging/,
    );
    expect(
      parseEnv("worker", s, { APP_ENV: "prod", REDIS_URL: "rediss://default:x@h:6379" }).REDIS_URL,
    ).toMatch(/^rediss/);
  });
});

describe("пустые и пробельные значения", () => {
  const s = z.object({
    ...baseEnvShape,
    TOKEN: optionalString(),
    URL: optionalUrl("https"),
    REQ: requiredString(),
  });

  it('"" и пробелы в необязательных полях = не задано', () => {
    const cfg = parseEnv("t", s, { TOKEN: "", URL: "  ", REQ: "x" });
    expect(cfg.TOKEN).toBeUndefined();
    expect(cfg.URL).toBeUndefined();
  });

  it("requiredString обрезает пробелы, пробелы = не задано", () => {
    expect(parseEnv("t", s, { REQ: "  v  " }).REQ).toBe("v");
    expect(() => parseEnv("t", s, { REQ: "   " })).toThrow(/REQ: обязательная переменная не задана/);
  });
});

describe("NODE_ENV=production", () => {
  const s = z.object(baseEnvShape);
  it("требует APP_ENV явно", () => {
    expect(() => parseEnv("t", s, { NODE_ENV: "production" })).toThrow(
      /APP_ENV: обязательна при NODE_ENV=production/,
    );
    expect(parseEnv("t", s, { NODE_ENV: "production", APP_ENV: "staging" }).APP_ENV).toBe("staging");
  });
});
