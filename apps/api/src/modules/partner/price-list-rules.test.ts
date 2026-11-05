// Unit: правила прайса заведения (0030) — порядок показа, ▲▼, перенумерация только изменившихся, лимиты, версия,
// видимость туристу, цена из bigint.
import { describe, expect, it } from "vitest";
import {
  byOrder,
  moved,
  nextSortOrder,
  priceOf,
  renumber,
  underLimit,
  versionMatches,
  visibleToTourist,
} from "./price-list-rules.js";

describe("price-list-rules", () => {
  it("byOrder: sort_order, при равенстве — id", () => {
    const rows = [
      { id: "c", sort_order: 1 },
      { id: "b", sort_order: 0 },
      { id: "a", sort_order: 1 },
    ];
    expect(byOrder(rows).map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(rows[0]!.id).toBe("c"); // исходный массив не меняется
  });

  it("moved: обмен с соседом; крайние и неизвестный id — null", () => {
    expect(moved(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], "b", "down")).toEqual(["a", "c", "b"]);
    expect(moved(["a", "b", "c"], "a", "up")).toBeNull();
    expect(moved(["a", "b", "c"], "c", "down")).toBeNull();
    expect(moved(["a"], "x", "up")).toBeNull();
  });

  it("renumber: 0..n по новому порядку, только изменившиеся (и починка одинаковых sort_order)", () => {
    const rows = [
      { id: "a", sort_order: 0 },
      { id: "b", sort_order: 1 },
      { id: "c", sort_order: 2 },
    ];
    expect(renumber(rows, ["b", "a", "c"])).toEqual([
      { id: "b", sortOrder: 0 },
      { id: "a", sortOrder: 1 },
    ]);
    const same = [
      { id: "a", sort_order: 0 },
      { id: "b", sort_order: 0 },
    ];
    expect(renumber(same, ["b", "a"])).toEqual([{ id: "a", sortOrder: 1 }]);
  });

  it("nextSortOrder: в конец; пустой список — 0", () => {
    expect(nextSortOrder([])).toBe(0);
    expect(
      nextSortOrder([
        { id: "a", sort_order: 4 },
        { id: "b", sort_order: 2 },
      ]),
    ).toBe(5);
  });

  it("лимит и версия", () => {
    expect(underLimit(199, 200)).toBe(true);
    expect(underLimit(200, 200)).toBe(false);
    expect(versionMatches(undefined, 7)).toBe(true);
    expect(versionMatches(7, 7)).toBe(true);
    expect(versionMatches(6, 7)).toBe(false);
  });

  it("туристу видно только active в active-разделе", () => {
    expect(visibleToTourist("active", "active")).toBe(true);
    expect(visibleToTourist("hidden", "active")).toBe(false);
    expect(visibleToTourist("active", "hidden")).toBe(false);
    expect(visibleToTourist("active", "archived")).toBe(false);
  });

  it("priceOf: bigint строкой из pg → число копеек", () => {
    expect(priceOf("35000")).toBe(35000);
    expect(priceOf(0)).toBe(0);
  });
});
