import { describe, expect, it } from "vitest";
import { assertSeedAllowed, SeedNotAllowedError } from "./guard.js";
import { seedUuid } from "./ids.js";
import { checkStartParam } from "../modules/qr-context/index.js";
import {
  assertVolumeAllowed,
  MAX_VOLUME,
  parseVolumeArgs,
  SEED_QR_POINTS,
  SEED_USERS,
  VOLUME_PRESETS,
} from "./seed.js";

describe("assertSeedAllowed", () => {
  it("local и staging разрешены, пустой APP_ENV = local", () => {
    expect(assertSeedAllowed({ APP_ENV: "local" })).toBe("local");
    expect(assertSeedAllowed({ APP_ENV: " staging " })).toBe("staging");
    expect(assertSeedAllowed({})).toBe("local");
  });

  it("prod запрещён", () => {
    expect(() => assertSeedAllowed({ APP_ENV: "prod" })).toThrow(SeedNotAllowedError);
    expect(() => assertSeedAllowed({ APP_ENV: "prod", DATABASE_URL: "x" })).toThrow(
      /запрещён при APP_ENV=prod/,
    );
  });

  it("NODE_ENV=production без явного APP_ENV и неизвестный APP_ENV — отказ", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "production" })).toThrow(SeedNotAllowedError);
    expect(() => assertSeedAllowed({ NODE_ENV: "production", APP_ENV: "staging" })).not.toThrow();
    expect(() => assertSeedAllowed({ APP_ENV: "production" })).toThrow(/неизвестный APP_ENV/);
  });
});

describe("assertSeedAllowed: хост базы", () => {
  const remote = "postgres://u:p@ep-x.eu-central-1.aws.neon.tech/db";
  it("пустой APP_ENV + удалённый хост - отказ", () => {
    expect(() => assertSeedAllowed({}, remote)).toThrow(/задайте APP_ENV явно/);
    expect(() => assertSeedAllowed({}, "не url")).toThrow(SeedNotAllowedError);
  });
  it("пустой APP_ENV + host/hostaddr в query (pg берёт его вместо хоста URL) - отказ", () => {
    for (const q of ["host=ep-x.neon.tech", "host=%2Fvar%2Frun", "hostaddr=10.0.0.1"])
      expect(() => assertSeedAllowed({}, `postgres://u:p@localhost/db?${q}`)).toThrow(SeedNotAllowedError);
  });
  it("APP_ENV=staging + удалённый хост - можно, prod по-прежнему нет", () => {
    expect(assertSeedAllowed({ APP_ENV: "staging" }, remote)).toBe("staging");
    expect(() => assertSeedAllowed({ APP_ENV: "prod" }, remote)).toThrow(SeedNotAllowedError);
  });
  it("локальные хосты без APP_ENV - можно", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "postgres"])
      expect(assertSeedAllowed({}, `postgres://tg:tg@${host}:5432/tg`)).toBe("local");
  });
});

describe("assertVolumeAllowed и пределы", () => {
  it("большой объём вне local - только с --allow-large", () => {
    const big = VOLUME_PRESETS.tz;
    expect(() => assertVolumeAllowed(big, "staging", false)).toThrow(/--allow-large/);
    expect(() => assertVolumeAllowed(big, "staging", true)).not.toThrow();
    expect(() => assertVolumeAllowed(big, "local", false)).not.toThrow();
    expect(() => assertVolumeAllowed(VOLUME_PRESETS.small, "staging", false)).not.toThrow();
  });
  it("--allow-large разбирается, значения выше MAX_VOLUME - ошибка", () => {
    expect(parseVolumeArgs(["--allow-large"]).allowLarge).toBe(true);
    expect(parseVolumeArgs([]).allowLarge).toBe(false);
    expect(() => parseVolumeArgs([`--events=${MAX_VOLUME + 1}`])).toThrow(/максимума/);
    expect(parseVolumeArgs([`--users=${MAX_VOLUME}`]).users).toBe(MAX_VOLUME);
  });
});

describe("seedUuid", () => {
  it("детерминирован, различает имена и выдаёт uuid версии 5", () => {
    expect(seedUuid("user:a")).toBe(seedUuid("user:a"));
    expect(seedUuid("user:a")).not.toBe(seedUuid("user:b"));
    expect(seedUuid("user:a")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("ключи пользователей seed уникальны", () => {
    const keys = SEED_USERS.map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("parseVolumeArgs", () => {
  it("по умолчанию — небольшой объём", () => {
    expect(parseVolumeArgs([])).toEqual({ ...VOLUME_PRESETS.small, allowLarge: false });
  });

  it("пресет tz и переопределение чисел", () => {
    expect(parseVolumeArgs(["--volume=tz"])).toEqual({
      users: 100_000,
      events: 1_000_000,
      allowLarge: false,
    });
    expect(parseVolumeArgs(["--", "--users=5", "--events=0"])).toEqual({
      users: 5,
      events: 0,
      allowLarge: false,
    });
  });

  it("мусор — ошибка", () => {
    expect(() => parseVolumeArgs(["--volume=huge"])).toThrow(/неизвестный --volume/);
    expect(() => parseVolumeArgs(["--users=-1"])).toThrow(/неотрицательное/);
    expect(() => parseVolumeArgs(["--foo=1"])).toThrow(/неизвестный аргумент/);
    expect(() => parseVolumeArgs(["users"])).toThrow(/неизвестный аргумент/);
  });
});

describe("SEED_QR_POINTS", () => {
  it("коды проходят проверку start_param и уникальны; есть активный QR отеля и неактивный", () => {
    const codes = SEED_QR_POINTS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(checkStartParam(c), c).toEqual({ valid: true, code: c });
    expect(SEED_QR_POINTS.some((p) => p.type === "hotel" && p.active && "venue" in p)).toBe(true);
    expect(SEED_QR_POINTS.some((p) => !p.active)).toBe(true);
  });
});
