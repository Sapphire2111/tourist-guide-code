// Окружение отзывов (блок 10, флаг module.reviews): API. Без провайдера (тесты других экранов) — null: блоки отзывов
// не показываются. При выключенном флаге интерфейс отзывов скрыт целиком (T1-22).
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useFeatureFlag } from "@tg/ui";
import type { ReviewEligibility, ReviewsApi } from "./reviews-api.js";

export type ReviewsEnv = { api: ReviewsApi };

const ReviewsContext = createContext<ReviewsEnv | null>(null);

export function ReviewsProvider({ value, children }: { value: ReviewsEnv; children?: ReactNode }) {
  return <ReviewsContext.Provider value={value}>{children}</ReviewsContext.Provider>;
}

export function useMaybeReviews(): ReviewsEnv | null {
  return useContext(ReviewsContext);
}

export function useReviews(): ReviewsEnv {
  const env = useContext(ReviewsContext);
  if (!env) throw new Error("ReviewsProvider не подключён");
  return env;
}

/** API отзывов, если модуль включён флагом и провайдер подключён; иначе null (интерфейс отзывов скрыт). */
export function useReviewsApi(): ReviewsApi | null {
  const env = useMaybeReviews();
  const on = useFeatureFlag("module.reviews");
  return on && env ? env.api : null;
}

/**
 * Права на отзыв пользователя (GET /reviews/eligibility): undefined — модуль выключен, вход не выполнен, нет региона,
 * ещё грузится или ошибка (вход «Залишити відгук» тогда просто не показывается — отзыв не обязателен для работы экрана).
 */
export function useMyEligibility(
  regionId: string | null,
  signedIn: boolean,
): ReviewEligibility[] | undefined {
  const api = useReviewsApi();
  const [loaded, setLoaded] = useState<{ key: string; items: ReviewEligibility[] } | null>(null);
  const key = `${regionId}`;
  useEffect(() => {
    if (!api || !regionId || !signedIn) return;
    let alive = true;
    api.eligibility(regionId).then(
      (items) => alive && setLoaded({ key, items }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, regionId, signedIn, key]);
  if (!api || !regionId || !signedIn || loaded?.key !== key) return undefined;
  return loaded.items;
}
