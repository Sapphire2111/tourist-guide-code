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

/** Рейтинг места по отзывам (D-37): score = null и fewReviews — «Мало відгуків». */
export type PlaceRating = ApiSchemas["PlaceReviewRatingDto"];

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
/** Окно правки отзыва после первой отправки, дней (REVIEW_PARAMS.editWindowDays сервера). */
export const EDIT_WINDOW_DAYS = 30;

/** Момент, до которого отзыв можно править: createdAt + окно (как editAllowed сервера). */
export function editDeadline(review: { createdAt: string }): number {
  return Date.parse(review.createdAt) + EDIT_WINDOW_DAYS * 86_400_000;
}

/** Окно правки своего отзыва ещё открыто. */
export function canEditReview(review: { createdAt: string }, now = Date.now()): boolean {
  return now <= editDeadline(review);
}
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
  /** Сервер отвечает полным PartnerReviewDto (отзыв с сохранённым ответом). */
  respond(reviewId: string, text: string): Promise<PartnerReview>;
};

export function createReviewsApi(api: ApiClient): ReviewsApi {
  return {
    placeReviews: (regionId, placeId) =>
      ok(api.GET("/reviews", { params: { query: { regionId, placeId } } })),
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
