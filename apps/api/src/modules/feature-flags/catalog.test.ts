// Unit (без БД): каталог фича-флагов и вычисление эффективных значений (T1-22).
import { describe, expect, it } from "vitest";
import {
  APP_ENVS,
  evaluateFlags,
  FEATURE_FLAG_KEYS,
  FEATURE_FLAGS,
  FINANCE_GATE_DECISIONS,
  isFeatureFlagKey,
  NO_OVERRIDES,
  rawValue,
} from "./catalog.js";

describe("каталог фича-флагов", () => {
  it("finance.live по умолчанию выключен во всех окружениях — и собственное, и эффективное значение", () => {
    expect(APP_ENVS).toEqual(["local", "staging", "prod"]);
    for (const env of APP_ENVS) {
      expect(FEATURE_FLAGS["finance.live"].defaults[env], env).toBe(false);
      expect(evaluateFlags(env, NO_OVERRIDES)["finance.live"], env).toBe(false);
    }
  });

  it("флаги финансового гейта — только finance.live, и все они по умолчанию выключены везде", () => {
    const gated = FEATURE_FLAG_KEYS.filter((k) => FEATURE_FLAGS[k].financeGate);
    expect(gated).toEqual(["finance.live"]);
    for (const k of gated) for (const env of APP_ENVS) expect(FEATURE_FLAGS[k].defaults[env]).toBe(false);
  });

  it("в prod по умолчанию выключено всё: релизы не объявлены", () => {
    const prod = evaluateFlags("prod", NO_OVERRIDES);
    expect(Object.values(prod).every((v) => !v)).toBe(true);
    expect(Object.keys(prod).sort()).toEqual([...FEATURE_FLAG_KEYS].sort());
  });

  it("ключи — в формате таблицы (CHECK feature_flags_key_format), requires ссылаются на флаги каталога", () => {
    for (const key of FEATURE_FLAG_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(key.length).toBeLessThanOrEqual(100);
      for (const r of FEATURE_FLAGS[key].requires) expect(isFeatureFlagKey(r), `${key} → ${r}`).toBe(true);
    }
    expect(isFeatureFlagKey("module.unknown")).toBe(false);
    expect(isFeatureFlagKey("constructor")).toBe(false);
  });

  it("решения финансового гейта — D-09, D-10, D-13, D-17, D-20, D-24 (decisions.md §2.1)", () => {
    expect(FINANCE_GATE_DECISIONS).toEqual(["D-09", "D-10", "D-13", "D-17", "D-20", "D-24"]);
  });
});

describe("evaluateFlags", () => {
  it("приоритет: регион → окружение → значение по умолчанию", () => {
    expect(rawValue("module.weather", "prod", NO_OVERRIDES)).toBe(true);
    // Бронирования (блок 7) по умолчанию выключены во всех окружениях — включает админ платформы.
    expect(rawValue("module.bookings", "staging", NO_OVERRIDES)).toBe(false);
    // Отзывы (блок 10) — так же: по умолчанию выключены, включает админ платформы.
    expect(rawValue("module.reviews", "local", NO_OVERRIDES)).toBe(false);
    expect(rawValue("module.bookings", "local", { global: { "module.bookings": true }, region: {} })).toBe(
      true,
    );
    expect(rawValue("release.r1", "prod", NO_OVERRIDES)).toBe(false);
    expect(rawValue("release.r1", "prod", { global: { "release.r1": true }, region: {} })).toBe(true);
    expect(
      rawValue("release.r1", "prod", { global: { "release.r1": true }, region: { "release.r1": false } }),
    ).toBe(false);
    expect(rawValue("release.r1", "local", { global: {}, region: { "release.r1": false } })).toBe(false);
  });

  it("requires: флаг действует, только если действуют все флаги, от которых он зависит (транзитивно)", () => {
    const local = evaluateFlags("local", NO_OVERRIDES);
    expect(local["module.weather"]).toBe(true);
    expect(local["finance.engine"]).toBe(true);
    const noR1 = evaluateFlags("local", { global: { "release.r1": false }, region: {} });
    // release.mvp → release.r1; finance.engine → release.mvp; module.qr_transactions → finance.engine.
    expect(noR1["release.mvp"]).toBe(false);
    expect(noR1["finance.engine"]).toBe(false);
    expect(noR1["module.qr_transactions"]).toBe(false);
    expect(noR1["module.weather"]).toBe(false);
  });

  it("включённый finance.live без finance.engine не действует", () => {
    const flags = evaluateFlags("prod", { global: { "finance.live": true }, region: {} });
    expect(flags["finance.live"]).toBe(false);
    const all = evaluateFlags("prod", {
      global: { "release.r1": true, "release.mvp": true, "finance.engine": true, "finance.live": true },
      region: {},
    });
    expect(all["finance.live"]).toBe(true);
  });

  it("модуль выключен в регионе — выключен только там", () => {
    const overrides = { global: {}, region: { "module.weather": false } };
    expect(evaluateFlags("local", overrides)["module.weather"]).toBe(false);
    expect(evaluateFlags("local", NO_OVERRIDES)["module.weather"]).toBe(true);
  });
});
