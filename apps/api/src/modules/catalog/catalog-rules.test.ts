// Unit: правила каталога (ADR-0017) — переходы статусов, готовность к публикации, проверка графика.
import { describe, expect, it } from "vitest";
import {
  archiveNeedsDelete,
  canTransition,
  likePattern,
  publishProblems,
  scheduleProblems,
} from "./catalog-rules.js";

const ready = {
  place: { description_i18n: { uk: "Опис" }, address_i18n: { uk: "Адреса" }, hasLocation: true },
  categoryActive: true,
  media: [{ alt: { uk: "Фото" }, status: "ready" }],
};

describe("переходы статусов места", () => {
  it("publish — из любого неопубликованного; suspend — только опубликованное; archive — кроме архива", () => {
    expect(["draft", "suspended", "archived"].every((s) => canTransition(s as never, "publish"))).toBe(true);
    expect(canTransition("published", "publish")).toBe(false);
    expect(canTransition("published", "suspend")).toBe(true);
    expect(canTransition("draft", "suspend")).toBe(false);
    expect(canTransition("archived", "archive")).toBe(false);
    expect(canTransition("published", "archive")).toBe(true);
  });

  it("архив — только публиковавшемуся: без first_published_at — удаление (CHECK places_published_once)", () => {
    expect(archiveNeedsDelete("archive", null)).toBe(true);
    expect(archiveNeedsDelete("archive", new Date())).toBe(false);
    expect(archiveNeedsDelete("suspend", null)).toBe(false);
    expect(archiveNeedsDelete("publish", null)).toBe(false);
  });
});

describe("publishProblems", () => {
  it("готовое место — без проблем; фото в обработке публикации не мешает", () => {
    expect(publishProblems(ready)).toEqual([]);
    expect(publishProblems({ ...ready, media: [{ alt: { uk: "Фото" }, status: "processing" }] })).toEqual([]);
    expect(publishProblems({ ...ready, media: [] })).toEqual([]);
  });

  it("каждое обязательное поле и фото без alt (в т. ч. пустой uk) — своя причина", () => {
    expect(
      publishProblems({
        place: { description_i18n: null, address_i18n: { uk: "  " }, hasLocation: false },
        categoryActive: false,
        media: [
          { alt: null, status: "ready" },
          { alt: { uk: "ok" }, status: "rejected" },
        ],
      }),
    ).toEqual([
      "description_missing",
      "address_missing",
      "location_missing",
      "category_inactive",
      "media_alt_missing",
      "media_rejected",
    ]);
  });
});

describe("scheduleProblems", () => {
  it("непересекающиеся интервалы, обед и ночной интервал — без проблем", () => {
    expect(
      scheduleProblems(
        [
          { dayOfWeek: 1, opensAt: "09:00", closesAt: "13:00" },
          { dayOfWeek: 1, opensAt: "14:00", closesAt: "18:00" },
          { dayOfWeek: 5, opensAt: "18:00", closesAt: "02:00" },
        ],
        [
          { date: "2026-12-31", closed: true },
          { date: "2027-01-01", closed: false, opensAt: "12:00", closesAt: "16:00" },
        ],
      ),
    ).toEqual([]);
  });

  it("пересечение, пустой интервал, время у закрытого дня, без времени у открытого, дубль даты", () => {
    expect(
      scheduleProblems(
        [
          { dayOfWeek: 2, opensAt: "09:00", closesAt: "14:00" },
          { dayOfWeek: 2, opensAt: "13:00", closesAt: "18:00" },
          { dayOfWeek: 3, opensAt: "10:00", closesAt: "10:00" },
          // Ночной интервал до 24:00 пересекается с вечерним.
          { dayOfWeek: 4, opensAt: "20:00", closesAt: "03:00" },
          { dayOfWeek: 4, opensAt: "22:00", closesAt: "23:00" },
        ],
        [
          { date: "2026-12-30", closed: true, opensAt: "10:00" },
          { date: "2026-12-29", closed: false },
          { date: "2026-12-28", closed: true },
          { date: "2026-12-28", closed: false, opensAt: "10:00", closesAt: "12:00" },
        ],
      ).sort(),
    ).toEqual(
      [
        "exception_duplicate",
        "exception_times_forbidden",
        "exception_times_required",
        "interval_empty",
        "interval_overlap",
      ].sort(),
    );
  });
});

describe("likePattern", () => {
  it("% и _ из запроса — буквально", () => {
    expect(likePattern(" 50%_off ")).toBe("%50\\%\\_off%");
  });
});
