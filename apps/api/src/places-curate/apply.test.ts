import { describe, expect, it } from "vitest";
import { MERGE_BLOCKING_TABLES, mergeSkipReason, pickMain, placeMergeBlockers } from "./apply.js";

describe("placeMergeBlockers", () => {
  it("место партнёра и ручное место — не сливаются автоматически; место Google — можно", () => {
    expect(placeMergeBlockers({ id: "p", organizationId: "org-1", source: "google" })).toEqual([
      "p: место партнёра",
    ]);
    expect(placeMergeBlockers({ id: "m", organizationId: null, source: "manual" })).toEqual([
      "m: источник manual",
    ]);
    expect(placeMergeBlockers({ id: "g", organizationId: null, source: "google" })).toEqual([]);
  });

  it("брони, отзывы, медиа и расписание блокируют; аналитика — нет", () => {
    for (const t of ["bookings", "reviews", "place_media", "place_schedules", "place_tags"])
      expect(MERGE_BLOCKING_TABLES).toContain(t);
    expect(MERGE_BLOCKING_TABLES).not.toContain("analytics_events");
  });
});

describe("mergeSkipReason", () => {
  const base = { main: "m", mainMerging: false, mainStatus: "published", blockers: [] as string[] };

  it("опубликованная главная без блокеров — слияние идёт", () => {
    expect(mergeSkipReason(base)).toBeNull();
  });

  it("главная сама сливается, не опубликована или есть блокеры — в todo", () => {
    expect(mergeSkipReason({ ...base, mainMerging: true })).toMatch(/сама архивируется/);
    expect(mergeSkipReason({ ...base, mainStatus: "archived" })).toMatch(/не опубликована \(archived\)/);
    expect(mergeSkipReason({ ...base, mainStatus: undefined })).toMatch(/нет в БД/);
    expect(mergeSkipReason({ ...base, blockers: ["d: место партнёра"] })).toMatch(/место партнёра/);
  });
});

describe("pickMain", () => {
  it("опубликованная с большим числом отзывов", () => {
    const row = (id: string, status: string, ratingCount: number) => ({
      id,
      status,
      ratingCount,
      photos: 0,
      hasAi: false,
      description: null,
    });
    expect(
      pickMain([row("a", "published", 5), row("b", "published", 50), row("c", "archived", 500)]).id,
    ).toBe("b");
  });
});
