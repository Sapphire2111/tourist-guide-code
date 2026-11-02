// Unit: демо-каталог seed (блок 3) согласован с правилами каталога — 8 разделов главной, 10–15 мест, ссылки только
// на существующие коды, опубликованные места готовы к публикации, графики корректны. На БД — integration/catalog.test.ts.
import { describe, expect, it } from "vitest";
import { HOME_SECTIONS } from "../db/index.js";
import { publishProblems, scheduleProblems } from "../modules/catalog/index.js";
import { SEED_CATEGORIES, SEED_LOCALITIES, SEED_PLACES, SEED_TAGS } from "./seed-catalog.js";

const CODE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;

describe("демо-каталог", () => {
  it("корневые категории — ровно 8 разделов главной C02, у каждого раздела своя кнопка", () => {
    expect(SEED_CATEGORIES.map((c) => c.home).sort()).toEqual([...HOME_SECTIONS].sort());
  });

  it("коды уникальны и в формате is_catalog_code", () => {
    const codes = SEED_CATEGORIES.flatMap((c) => [c.code, ...c.children.map((s) => s.code)]);
    for (const list of [codes, SEED_TAGS.map((t) => t.code), SEED_LOCALITIES.map((l) => l.code)]) {
      expect(new Set(list).size).toBe(list.length);
      for (const code of list) expect(code).toMatch(CODE);
    }
  });

  it("10–15 мест; ссылки на подкатегории, теги и населённые пункты из seed; ключи уникальны", () => {
    expect(SEED_PLACES.length).toBeGreaterThanOrEqual(10);
    expect(SEED_PLACES.length).toBeLessThanOrEqual(15);
    expect(new Set(SEED_PLACES.map((p) => p.key)).size).toBe(SEED_PLACES.length);
    const subcategories = new Set(SEED_CATEGORIES.flatMap((c) => c.children.map((s) => s.code)));
    const tags = new Set(SEED_TAGS.map((t) => t.code));
    const localities = new Set(SEED_LOCALITIES.map((l) => l.code));
    for (const p of SEED_PLACES) {
      expect(subcategories.has(p.category), p.key).toBe(true);
      expect(localities.has(p.locality), p.key).toBe(true);
      for (const t of p.tags ?? []) expect(tags.has(t), `${p.key}: ${t}`).toBe(true);
    }
  });

  it("опубликованные места проходят проверку публикации; есть черновик и место с бейджем", () => {
    for (const p of SEED_PLACES.filter((x) => x.status === "published"))
      expect(
        publishProblems({
          place: { description_i18n: p.description ?? null, address_i18n: p.address, hasLocation: true },
          categoryActive: true,
          media: [],
        }),
        p.key,
      ).toEqual([]);
    expect(SEED_PLACES.some((p) => p.status === "draft")).toBe(true);
    expect(SEED_PLACES.some((p) => p.recommended)).toBe(true);
  });

  it("графики корректны (без пересечений), у большинства мест график есть", () => {
    for (const p of SEED_PLACES) {
      const weekly = (p.week ?? []).flatMap((w) =>
        w.days.map((dayOfWeek) => ({ dayOfWeek, opensAt: w.from, closesAt: w.to })),
      );
      const exceptions = p.exception
        ? [
            {
              date: p.exception.date,
              closed: p.exception.closed,
              opensAt: p.exception.from ?? null,
              closesAt: p.exception.to ?? null,
            },
          ]
        : [];
      expect(scheduleProblems(weekly, exceptions), p.key).toEqual([]);
    }
    expect(SEED_PLACES.filter((p) => p.week).length).toBeGreaterThanOrEqual(8);
  });
});
