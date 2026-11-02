// Unit: демо-данные блока 5 согласованы с демо-каталогом — ≥5 сценариев на существующих местах (по ключу), отель
// — место каталога, коды и теги — в форматах API. На БД — test/integration/host.test.ts.
import { describe, expect, it } from "vitest";
import { SCENARIO_TAGS } from "../modules/planner/index.js";
import { SEED_PLACES } from "./seed-catalog.js";
import { SEED_HOTEL_PLACE_KEY, SEED_SCENARIOS } from "./seed-host.js";

const CODE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;
const published = new Set(SEED_PLACES.filter((p) => p.status === "published").map((p) => p.key));
const known = new Set(SEED_PLACES.map((p) => p.key));

describe("демо-данные блока 5", () => {
  it("отель «Тестовий готель» — опубликованное место демо-каталога", () => {
    expect(published.has(SEED_HOTEL_PLACE_KEY)).toBe(true);
  });

  it("≥5 сценариев с опубликованными пунктами; коды уникальны; теги из справочника", () => {
    const withPublished = SEED_SCENARIOS.filter((s) => s.items.some((i) => published.has(i.place)));
    expect(withPublished.length).toBeGreaterThanOrEqual(5);
    expect(new Set(SEED_SCENARIOS.map((s) => s.code)).size).toBe(SEED_SCENARIOS.length);
    for (const s of SEED_SCENARIOS) {
      expect(s.code).toMatch(CODE);
      for (const t of s.tags) expect(SCENARIO_TAGS as readonly string[], `${s.code}: ${t}`).toContain(t);
      for (const i of s.items) expect(i.day, s.code).toBeLessThanOrEqual(s.days);
    }
  });

  it("пункты и альтернативы — ключи демо-каталога (новых мест не выдумываем); есть сценарий с заменой", () => {
    for (const s of SEED_SCENARIOS)
      for (const i of s.items) {
        expect(known.has(i.place), `${s.code}: ${i.place}`).toBe(true);
        for (const a of i.alternatives ?? []) expect(known.has(a), `${s.code}: ${a}`).toBe(true);
      }
    expect(
      SEED_SCENARIOS.some((s) => s.items.some((i) => (i.alternatives ?? []).some((a) => published.has(a)))),
    ).toBe(true);
  });
});
