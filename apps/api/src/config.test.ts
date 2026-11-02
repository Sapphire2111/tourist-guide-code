import { parseEnv } from "@tg/server-config";
import { describe, expect, it } from "vitest";
import { analyticsClientEventsEnabled, apiEnvSchema, mediaProcessingMode } from "./config.js";

describe("apiEnvSchema", () => {
  it("local стартует без внешних сервисов, кроме строки подключения к БД", () => {
    const env = parseEnv("api", apiEnvSchema, {
      DATABASE_URL: "postgresql://tg:tg@localhost:4303/tourist_guide",
    });
    expect(env.APP_ENV).toBe("local");
  });

  it("DATABASE_URL обязателен и в local", () => {
    expect(() => parseEnv("api", apiEnvSchema, {})).toThrow(/DATABASE_URL/);
  });

  it("staging без секретов не стартует и не печатает значения", () => {
    const run = () =>
      parseEnv("api", apiEnvSchema, { APP_ENV: "staging", DATABASE_URL: "mysql://u:LEAKED@h/db" });
    expect(run).toThrow(/обязательна при APP_ENV=staging/);
    expect(run).not.toThrow(/LEAKED/);
  });

  it("CORS_ORIGINS — только origin: схема, хост, порт без пути и слэша", () => {
    const parse = (CORS_ORIGINS: string) =>
      parseEnv("api", apiEnvSchema, { DATABASE_URL: "postgresql://tg:tg@localhost:4303/tg", CORS_ORIGINS });
    expect(parse("https://a.example.com, http://localhost:4301").CORS_ORIGINS).toEqual([
      "https://a.example.com",
      "http://localhost:4301",
    ]);
    for (const bad of ["https://a.example.com/", "https://A.example.com", "https://a.example.com/app", "*"]) {
      expect(() => parse(bad), bad).toThrow(/CORS_ORIGINS/);
    }
  });

  it("ANALYTICS_CLIENT_EVENTS: по умолчанию выключен только в prod, явное значение важнее", () => {
    expect(analyticsClientEventsEnabled({ APP_ENV: "local" })).toBe(true);
    expect(analyticsClientEventsEnabled({ APP_ENV: "staging" })).toBe(true);
    expect(analyticsClientEventsEnabled({ APP_ENV: "prod" })).toBe(false);
    expect(analyticsClientEventsEnabled({ APP_ENV: "prod", ANALYTICS_CLIENT_EVENTS: "on" })).toBe(true);
    expect(analyticsClientEventsEnabled({ APP_ENV: "staging", ANALYTICS_CLIENT_EVENTS: "off" })).toBe(false);
    expect(() =>
      parseEnv("api", apiEnvSchema, {
        DATABASE_URL: "postgresql://tg:tg@localhost:4303/tg",
        ANALYTICS_CLIENT_EVENTS: "yes",
      }),
    ).toThrow(/ANALYTICS_CLIENT_EVENTS/);
  });

  it("RATE_LIMIT: пусто — on, регистр и пробелы не важны, чужое значение — ошибка", () => {
    const parse = (extra: Record<string, string>) =>
      parseEnv("api", apiEnvSchema, { DATABASE_URL: "postgresql://tg:tg@localhost:4303/tg", ...extra });
    expect(parse({ RATE_LIMIT: "" })).toMatchObject({ RATE_LIMIT: "on" });
    expect(parse({ RATE_LIMIT: " Memory " })).toMatchObject({ RATE_LIMIT: "memory" });
    expect(() => parse({ RATE_LIMIT: "redis" })).toThrow();
  });

  it("сессии (T1-26): срок по умолчанию 24 ч, 1–720; dev-вход выключен по умолчанию", () => {
    const parse = (extra: Record<string, string>) =>
      parseEnv("api", apiEnvSchema, { DATABASE_URL: "postgresql://tg:tg@localhost:4303/tg", ...extra });
    expect(parse({})).toMatchObject({ AUTH_SESSION_TTL_HOURS: 24, AUTH_DEV_LOGIN: false });
    expect(parse({ AUTH_SESSION_TTL_HOURS: "720", AUTH_DEV_LOGIN: "true" })).toMatchObject({
      AUTH_SESSION_TTL_HOURS: 720,
      AUTH_DEV_LOGIN: true,
    });
    expect(parse({ AUTH_DEV_LOGIN: " " }).AUTH_DEV_LOGIN).toBe(false);
    for (const bad of ["0", "721", "1.5", "x"])
      expect(() => parse({ AUTH_SESSION_TTL_HOURS: bad }), bad).toThrow(/AUTH_SESSION_TTL_HOURS/);
    expect(() => parse({ AUTH_DEV_LOGIN: "yes" })).toThrow(/AUTH_DEV_LOGIN/);
  });

  it("вход через Telegram (блок 2): срок initData по умолчанию 24 ч, 1–168", () => {
    const parse = (extra: Record<string, string>) =>
      parseEnv("api", apiEnvSchema, { DATABASE_URL: "postgresql://tg:tg@localhost:4303/tg", ...extra });
    expect(parse({}).TELEGRAM_INIT_DATA_MAX_AGE_HOURS).toBe(24);
    expect(parse({ TELEGRAM_INIT_DATA_MAX_AGE_HOURS: " " }).TELEGRAM_INIT_DATA_MAX_AGE_HOURS).toBe(24);
    expect(parse({ TELEGRAM_INIT_DATA_MAX_AGE_HOURS: "1" }).TELEGRAM_INIT_DATA_MAX_AGE_HOURS).toBe(1);
    for (const bad of ["0", "169", "2.5", "x"])
      expect(() => parse({ TELEGRAM_INIT_DATA_MAX_AGE_HOURS: bad }), bad).toThrow(
        /TELEGRAM_INIT_DATA_MAX_AGE_HOURS/,
      );
  });

  it("dev-вход в staging/prod запрещён конфигом: api не стартует", () => {
    for (const APP_ENV of ["staging", "prod"])
      expect(
        () =>
          parseEnv("api", apiEnvSchema, {
            APP_ENV,
            DATABASE_URL: "postgresql://tg:tg@localhost:4303/tg",
            PUBLIC_API_URL: "https://api.example.com",
            CORS_ORIGINS: "https://app.example.com",
            REDIS_URL: "rediss://default:x@h:6379",
            TELEGRAM_BOT_TOKEN: "123:abc",
            AUTH_DEV_LOGIN: "true",
          }),
        APP_ENV,
      ).toThrow(/AUTH_DEV_LOGIN: dev-вход разрешён только при APP_ENV=local/);
  });

  it("хранилище (T1-20): по умолчанию local; s3 — нужны бакет и ключи; local в prod запрещён; секрет ≥ 32", () => {
    const db = { DATABASE_URL: "postgresql://tg:tg@localhost:4303/tg" };
    expect(parseEnv("api", apiEnvSchema, db).STORAGE_DRIVER).toBe("local");
    expect(() => parseEnv("api", apiEnvSchema, { ...db, STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toThrow(
      /S3_ACCESS_KEY_ID: обязательна при STORAGE_DRIVER=s3/,
    );
    expect(
      parseEnv("api", apiEnvSchema, {
        ...db,
        STORAGE_DRIVER: "s3",
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "k",
        S3_SECRET_ACCESS_KEY: "SECRETVALUE",
      }).STORAGE_DRIVER,
    ).toBe("s3");
    expect(() => parseEnv("api", apiEnvSchema, { ...db, STORAGE_SIGNING_SECRET: "short" })).toThrow(
      /STORAGE_SIGNING_SECRET/,
    );
    expect(() => parseEnv("api", apiEnvSchema, { ...db, STORAGE_DRIVER: "ftp" })).toThrow(/STORAGE_DRIVER/);
    const prod = () =>
      parseEnv("api", apiEnvSchema, {
        ...db,
        APP_ENV: "prod",
        PUBLIC_API_URL: "https://api.example.com",
        CORS_ORIGINS: "https://app.example.com",
        REDIS_URL: "rediss://r:6379",
        TELEGRAM_BOT_TOKEN: "t",
      });
    expect(prod).toThrow(/STORAGE_DRIVER: local запрещён при APP_ENV=prod/);
  });

  it("MEDIA_PROCESSING: queue только в prod при s3 и Redis, иначе inline; queue без Redis — ошибка", () => {
    const prodS3 = { APP_ENV: "prod", STORAGE_DRIVER: "s3", REDIS_URL: "redis://r" } as const;
    expect(mediaProcessingMode(prodS3)).toBe("queue");
    expect(mediaProcessingMode({ ...prodS3, APP_ENV: "staging" })).toBe("inline");
    expect(mediaProcessingMode({ ...prodS3, APP_ENV: "local" })).toBe("inline");
    expect(mediaProcessingMode({ ...prodS3, STORAGE_DRIVER: "local" })).toBe("inline");
    expect(mediaProcessingMode({ APP_ENV: "prod", STORAGE_DRIVER: "s3" })).toBe("inline");
    expect(mediaProcessingMode({ ...prodS3, MEDIA_PROCESSING: "inline" })).toBe("inline");
    expect(mediaProcessingMode({ APP_ENV: "staging", MEDIA_PROCESSING: "queue" })).toBe("queue");
    expect(() =>
      parseEnv("api", apiEnvSchema, {
        DATABASE_URL: "postgresql://tg:tg@localhost:4303/tg",
        MEDIA_PROCESSING: "queue",
      }),
    ).toThrow(/MEDIA_PROCESSING: queue требует REDIS_URL/);
  });
});
