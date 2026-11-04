// Адаптер блока 10 (подтверждённые отзывы) поверх @tg/api-client: турист — отзывы и рейтинг места (C06), право на
// отзыв и отправка (C13), жалоба, апелляция; партнёр — отзывы о своих местах и ответ (P07). Ошибки — как у блоков
// 5–7 (ok из host-api). Регион туриста — из контекста входа; партнёрские запросы регион берут из самого отзыва.
import type { ApiClient, ApiSchemas } from "@tg/api-client";
import { ok } from "../host/host-api.js";

export type PublicReview = ApiSchemas["PublicReviewDto"];
export type ReviewResponse = ApiSchemas["ReviewResponseDto"];
export type MyReview = ApiSchemas["MyReviewDto"];
export type ReviewEligibility = ApiSchemas["ReviewEligibilityDto"];
export type ReviewStatus = ApiSchemas["ReviewStatus"];
export type ReviewAutoFlag = ApiSchemas["ReviewAutoFlag"];
export type ComplaintReason = ApiSchemas["ComplaintReason"];
export type PartnerReview = ApiSchemas["PartnerReviewDto"];
export type ReviewComplaint = ApiSchemas["ComplaintDto"];
export type ReviewAppeal = ApiSchemas["AppealDto"];

/**
 * Рейтинг места (D-37). В сгенерированной схеме имя PlaceRatingDto занято DTO гида (рейтинг Google, одноимённый
 * класс), поэтому тип рейтинга отзывов описан здесь по reviews.dto.ts сервера.
 */
export type PlaceRating = {
  placeId: string;
  /** Опубликованных проверенных отзывов. */
  reviewCount: number;
  /** Меньше minReviews отзывов — «Мало відгуків» вместо цифры (score = null). */
  fewReviews: boolean;
  /** 1–5 до десятых; null — мало отзывов. */
  score: number | null;
  minReviews: number;
};

export type PlaceReviews = { rating: PlaceRating; items: PublicReview[] };

/** Причины жалобы (справочник сервера COMPLAINT_REASONS). */
export const COMPLAINT_REASONS: readonly ComplaintReason[] = [
  "insult",
  "personal_data",
  "spam",
  "blackmail",
  "fraud",
  "other",
];

/** Границы форм — по review-rules.ts (REVIEW_PARAMS). */
export const REVIEW_TEXT_MAX = 2000;
export const RESPONSE_TEXT_MAX = 1000;
export const COMPLAINT_TEXT_MAX = 1000;
export const APPEAL_TEXT_MAX = 1000;

export type ReviewsApi = {
  placeReviews(regionId: string, placeId: string): Promise<PlaceReviews>;
  /** Права на отзыв пользователя (после завершённой брони) вместе с его отзывом. */
  eligibility(regionId: string): Promise<ReviewEligibility[]>;
  submit(regionId: string, input: { eligibilityId: string; rating: number; text: string }): Promise<MyReview>;
  complain(
    regionId: string,
    reviewId: string,
    input: { reasonCode: ComplaintReason; text?: string },
  ): Promise<ReviewComplaint>;
  appeal(regionId: string, reviewId: string, text: string): Promise<ReviewAppeal>;
  partnerReviews(placeId?: string): Promise<PartnerReview[]>;
  respond(reviewId: string, text: string): Promise<ReviewResponse>;
};

export function createReviewsApi(api: ApiClient): ReviewsApi {
  return {
    placeReviews: async (regionId, placeId) => {
      const res = await ok(api.GET("/reviews", { params: { query: { regionId, placeId } } }));
      return { rating: res.rating as unknown as PlaceRating, items: res.items };
    },
    eligibility: async (regionId) =>
      (await ok(api.GET("/reviews/eligibility", { params: { query: { regionId } } }))).items,
    submit: (regionId, input) => ok(api.POST("/reviews", { body: { regionId, ...input } })),
    complain: (regionId, id, input) =>
      ok(api.POST("/reviews/{id}/complaints", { params: { path: { id } }, body: { regionId, ...input } })),
    appeal: (regionId, reviewId, text) => ok(api.POST("/appeals", { body: { regionId, reviewId, text } })),
    partnerReviews: async (placeId) =>
      (await ok(api.GET("/partner/reviews", { params: { query: placeId ? { placeId } : {} } }))).items,
    respond: (id, text) =>
      ok(api.PUT("/partner/reviews/{id}/response", { params: { path: { id } }, body: { text } })),
  };
}
