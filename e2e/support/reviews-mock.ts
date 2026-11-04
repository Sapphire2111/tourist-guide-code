// Мок api отзывов (блок 10) для E2E Mini App: отзывы и рейтинг места (C06), право на отзыв после завершённой брони
// (C13), жалоба, апелляция, отзывы партнёра и ответ (P07). Автофильтр — упрощённо: ссылка (http/t.me) в тексте →
// pending_moderation. Флаг module.reviews включается здесь (поверх общих флагов фикстуры). Пути не отзывов — дальше
// другим мокам (route.fallback).
import type { Page, Route } from "@playwright/test";
import { CAFE_PLACE, REGION_ID } from "./api-mock.js";
import { PARTNER_PLACE } from "./bookings-mock.js";

export const ELIGIBILITY_ID = "00000000-0000-4000-8000-000000000511";
export const COMPLETED_BOOKING_ID = "00000000-0000-4000-8000-000000000498";
const REVIEW_ID = "00000000-0000-4000-8000-000000000611";
const PARTNER_REVIEW_ID = "00000000-0000-4000-8000-000000000612";
const NOW = "2026-11-03T08:00:00.000Z";

export type ReviewsMockState = {
  submitted: Record<string, unknown>[];
  complaints: { id: string; body: Record<string, unknown> }[];
  appeals: Record<string, unknown>[];
  responses: { id: string; text: string }[];
  /** Право на отзыв: что отдаёт GET /reviews/eligibility. */
  eligibility: Record<string, unknown>[];
  /** Отзывы партнёра. */
  partnerReviews: Record<string, unknown>[];
  /** Опубликованные отзывы места. */
  published: Record<string, unknown>[];
};

export async function installReviewsMock(page: Page): Promise<ReviewsMockState> {
  const state: ReviewsMockState = {
    submitted: [],
    complaints: [],
    appeals: [],
    responses: [],
    eligibility: [
      {
        id: ELIGIBILITY_ID,
        placeId: CAFE_PLACE,
        placeName: { uk: "Кав'ярня «Смерека»" },
        bookingId: COMPLETED_BOOKING_ID,
        level: "verified_booking",
        status: "active",
        issuedAt: NOW,
        expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
        review: null,
      },
    ],
    published: [
      {
        id: REVIEW_ID,
        placeId: CAFE_PLACE,
        rating: 5,
        text: "Дуже смачна кава й привітний персонал.",
        version: 1,
        verificationLevel: "verified_booking",
        authorName: "Олена",
        publishedAt: NOW,
        updatedAt: NOW,
        response: {
          id: "r1",
          text: "Дякуємо, чекаємо знову!",
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ],
    partnerReviews: [
      {
        id: PARTNER_REVIEW_ID,
        regionId: REGION_ID,
        placeId: PARTNER_PLACE,
        placeName: { uk: "Садиба «Під Смерекою»" },
        status: "published",
        rating: 2,
        text: "Довго чекали на заселення.",
        version: 1,
        authorName: "Іван",
        publishedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        response: null,
        myComplaints: [],
        appeal: null,
        canRespond: true,
        canAppeal: false,
      },
    ],
  };
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, idempotency-key",
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  const error = (route: Route, status: number, code: string, messageKey?: string, details?: unknown) =>
    json(
      route,
      { error: { code, ...(messageKey ? { messageKey } : {}), ...(details ? { details } : {}) } },
      status,
    );

  await page.route("**/feature-flags*", (route) =>
    json(route, {
      items: ["module.partner_cabinet", "module.host_requests", "module.bookings", "module.reviews"].map(
        (key) => ({ key, enabled: true }),
      ),
    }),
  );

  await page.route(
    (url) => /^\/(reviews(\/.*)?|appeals|partner\/reviews(\/.*)?)$/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const method = req.method();
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const body = () => (req.postData() ? (req.postDataJSON() as Record<string, unknown>) : {});

      if (path === "/reviews" && method === "GET") {
        const count = state.published.length;
        return json(route, {
          rating: {
            placeId: CAFE_PLACE,
            reviewCount: count,
            fewReviews: count < 3,
            score: count < 3 ? null : 4.4,
            minReviews: 3,
            formulaVersion: 1,
            computedAt: NOW,
          },
          items: state.published,
        });
      }
      if (path === "/reviews/eligibility" && method === "GET")
        return json(route, { items: state.eligibility });
      if (path === "/reviews" && method === "POST") {
        const b = body();
        state.submitted.push(b);
        const flagged = /https?:\/\/|t\.me\//i.test(String(b.text));
        const review = {
          id: REVIEW_ID,
          placeId: CAFE_PLACE,
          status: flagged ? "pending_moderation" : "published",
          rating: b.rating,
          text: b.text,
          version: 1,
          autoFlags: flagged ? ["link"] : [],
          hiddenReason: null,
          publishedAt: flagged ? null : NOW,
          createdAt: NOW,
          updatedAt: NOW,
          response: null,
          appeal: null,
          canAppeal: false,
        };
        state.eligibility = state.eligibility.map((e) => ({ ...e, status: "consumed", review }));
        return json(route, review, 201);
      }
      const complaint = /^\/reviews\/([^/]+)\/complaints$/.exec(path);
      if (complaint && method === "POST") {
        const b = body();
        if (state.complaints.some((c) => c.id === complaint[1]))
          return error(route, 409, "CONFLICT", "errors.review.complaintExists");
        state.complaints.push({ id: complaint[1]!, body: b });
        return json(
          route,
          {
            id: "c1",
            reviewId: complaint[1],
            kind: "user",
            reasonCode: b.reasonCode,
            text: b.text ?? null,
            status: "open",
            createdAt: NOW,
            decidedAt: null,
          },
          201,
        );
      }
      if (path === "/appeals" && method === "POST") {
        const b = body();
        state.appeals.push(b);
        return json(
          route,
          {
            id: "a1",
            reviewId: b.reviewId,
            kind: "author",
            text: b.text,
            status: "open",
            decisionNote: null,
            createdAt: NOW,
            decidedAt: null,
          },
          201,
        );
      }
      if (path === "/partner/reviews" && method === "GET")
        return json(route, { items: state.partnerReviews });
      const respond = /^\/partner\/reviews\/([^/]+)\/response$/.exec(path);
      if (respond && method === "PUT") {
        const text = String(body().text);
        if (/https?:\/\/|t\.me\//i.test(text))
          return error(route, 422, "UNPROCESSABLE", "errors.review.responseRejected", { flags: ["link"] });
        state.responses.push({ id: respond[1]!, text });
        const saved = {
          ...state.partnerReviews.find((r) => r.id === respond[1]),
          response: { id: "r2", text, version: 1, createdAt: NOW, updatedAt: NOW },
        };
        state.partnerReviews = state.partnerReviews.map((r) => (r.id === respond[1] ? saved : r));
        return json(route, saved);
      }
      return route.fallback();
    },
  );
  return state;
}
