import { describe, expect, it } from "vitest";
import {
  appealAllowed,
  appealGrantedStatus,
  autoFlags,
  categoryPrior,
  complaintOutcome,
  computeRating,
  decisionTarget,
  effectiveEligibilityStatus,
  eligibilityExpiresAt,
  ratingStale,
  RATING_PARAMS,
  recencyWeight,
  REVIEW_PARAMS,
  statusAfterSubmit,
} from "./review-rules.js";

const DAY = 24 * 3_600_000;
const NOW = new Date("2026-11-04T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

describe("право на отзыв (D-82)", () => {
  it("окно — eligibilityWindowDays после окончания брони; active после окна — expired", () => {
    const ended = daysAgo(REVIEW_PARAMS.eligibilityWindowDays - 1);
    expect(eligibilityExpiresAt(ended).getTime()).toBe(
      ended.getTime() + REVIEW_PARAMS.eligibilityWindowDays * DAY,
    );
    expect(effectiveEligibilityStatus({ status: "active", source_ended_at: ended }, NOW)).toBe("active");
    expect(
      effectiveEligibilityStatus(
        { status: "active", source_ended_at: daysAgo(REVIEW_PARAMS.eligibilityWindowDays) },
        NOW,
      ),
    ).toBe("expired");
  });

  it("consumed и revoked не меняются по времени", () => {
    for (const status of ["consumed", "revoked", "expired"] as const)
      expect(effectiveEligibilityStatus({ status, source_ended_at: daysAgo(400) }, NOW)).toBe(status);
  });
});

describe("автофильтр (D-08 В)", () => {
  it("чистый текст — без срабатываний, публикуется сразу", () => {
    const text = "Чудовий чан, гаряча вода, привітний персонал. Приїдемо ще 2026 року! Оцінка 5 з 5.";
    expect(autoFlags(text)).toEqual([]);
    expect(statusAfterSubmit(autoFlags(text))).toBe("published");
  });

  it("ссылки, телефоны, e-mail — в очередь модерации", () => {
    expect(autoFlags("Дивіться https://example.com")).toEqual(["link"]);
    expect(autoFlags("заходьте на www.spa-bukovel.ua")).toEqual(["link"]);
    expect(autoFlags("пишіть у t.me/spa_chat")).toEqual(["link"]);
    expect(autoFlags("сайт chany-vorokhta.com")).toEqual(["link"]);
    expect(autoFlags("Дзвоніть +38 (050) 123-45-67")).toEqual(["phone"]);
    expect(autoFlags("0501234567")).toEqual(["phone"]);
    expect(autoFlags("пишіть на owner@mail.com")).toEqual(["email"]);
    expect(statusAfterSubmit(["phone"])).toBe("pending_moderation");
  });

  it("мат — по корню с начала слова и целыми словами; похожие слова не срабатывают", () => {
    expect(autoFlags("Це просто бляха… ні, блядь, жах")).toEqual(["profanity"]);
    expect(autoFlags("Сука, холодно")).toEqual(["profanity"]);
    expect(autoFlags("What the FUCK")).toEqual(["profanity"]);
    // «потреба», «сукня», «скурвитися» не в словаре корней с начала слова.
    expect(autoFlags("Була потреба в рушниках, купила сукню")).toEqual([]);
  });
});

describe("решения модератора и апелляции (states-and-rules §6.2, §6.4)", () => {
  it("publish — всегда published (одобрить, оставить, вернуть); hide — hidden или rejected", () => {
    for (const s of ["pending_moderation", "published", "hidden", "rejected"] as const)
      expect(decisionTarget(s, "publish")).toBe("published");
    expect(decisionTarget("published", "hide")).toBe("hidden");
    expect(decisionTarget("pending_moderation", "hide")).toBe("rejected");
    expect(decisionTarget("hidden", "hide")).toBeUndefined();
    expect(decisionTarget("rejected", "hide")).toBeUndefined();
    expect(complaintOutcome("hide")).toBe("upheld");
    expect(complaintOutcome("publish")).toBe("dismissed");
  });

  it("автор апеллирует на hidden/rejected, партнёр — на «оставить» по своей жалобе; без решения — нельзя", () => {
    const decided = (status: "published" | "hidden" | "rejected" | "pending_moderation") => ({
      status,
      last_decision_by: "m1",
    });
    expect(appealAllowed("author", decided("hidden"), false)).toBe(true);
    expect(appealAllowed("author", decided("rejected"), false)).toBe(true);
    expect(appealAllowed("author", decided("published"), false)).toBe(false);
    expect(appealAllowed("author", { status: "hidden", last_decision_by: null }, false)).toBe(false);
    expect(appealAllowed("partner", decided("published"), true)).toBe(true);
    expect(appealAllowed("partner", decided("published"), false)).toBe(false);
    expect(appealAllowed("partner", decided("hidden"), true)).toBe(false);
    expect(appealGrantedStatus("author")).toBe("published");
    expect(appealGrantedStatus("partner")).toBe("hidden");
  });
});

describe("рейтинг (D-37 В)", () => {
  it("до порога — «Мало відгуків»: score null, среднее есть", () => {
    const r = computeRating(
      [
        { rating: 5, publishedAt: NOW },
        { rating: 4, publishedAt: NOW },
      ],
      4,
      NOW,
    );
    expect(r).toEqual({
      formulaVersion: RATING_PARAMS.formulaVersion,
      reviewCount: 2,
      average: 4.5,
      score: null,
    });
    expect(computeRating([], 4, NOW)).toMatchObject({ reviewCount: 0, average: null, score: null });
  });

  it("байесовское сглаживание: три пятёрки тянутся к среднему категории", () => {
    const fives = Array.from({ length: RATING_PARAMS.minReviews }, () => ({ rating: 5, publishedAt: NOW }));
    const r = computeRating(fives, 4, NOW);
    const c = RATING_PARAMS.priorWeight;
    expect(r.score).toBeCloseTo((c * 4 + 5 * fives.length) / (c + fives.length), 3);
    expect(r.score!).toBeLessThan(5);
    expect(r.score!).toBeGreaterThan(4);
  });

  it("затухание: старый отзыв весит меньше — свежая единица влияет сильнее старой", () => {
    expect(recencyWeight(NOW, NOW)).toBe(1);
    expect(recencyWeight(daysAgo(RATING_PARAMS.halfLifeDays), NOW)).toBeCloseTo(0.5, 6);
    const base = [5, 5, 5].map((rating) => ({ rating, publishedAt: NOW }));
    const freshOne = computeRating([...base, { rating: 1, publishedAt: NOW }], 4, NOW).score!;
    const oldOne = computeRating([...base, { rating: 1, publishedAt: daysAgo(730) }], 4, NOW).score!;
    expect(oldOne).toBeGreaterThan(freshOne);
  });

  it("среднее категории сглажено к среднему платформы; кэш другой версии или старый — пересчёт", () => {
    expect(categoryPrior(0, 0)).toBe(RATING_PARAMS.globalPrior);
    expect(categoryPrior(1000, 5000)).toBeGreaterThan(4.9);
    expect(ratingStale(undefined, NOW)).toBe(true);
    expect(ratingStale({ formula_version: RATING_PARAMS.formulaVersion, computed_at: NOW }, NOW)).toBe(false);
    expect(ratingStale({ formula_version: RATING_PARAMS.formulaVersion + 1, computed_at: NOW }, NOW)).toBe(
      true,
    );
    expect(
      ratingStale(
        {
          formula_version: RATING_PARAMS.formulaVersion,
          computed_at: new Date(NOW.getTime() - (RATING_PARAMS.staleAfterHours + 1) * 3_600_000),
        },
        NOW,
      ),
    ).toBe(true);
  });
});
