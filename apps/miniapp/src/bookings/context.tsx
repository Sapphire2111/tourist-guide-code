// Окружение бронирований (блок 7, флаг module.bookings): API и часовой пояс региона. Без провайдера (тесты других
// экранов) — null: блок брони в карточке места не показывается.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useFeatureFlag } from "@tg/ui";
import type { BookingsApi, Resource } from "./bookings-api.js";

export type BookingsEnv = {
  api: BookingsApi;
  /** Пояс региона (слоты и брони — в местном времени). */
  timeZone: string;
  /** Контекст входа (QR) — атрибуция онлайн-брони; null — вход без контекста. */
  entryContextId?: string | null;
};

const BookingsContext = createContext<BookingsEnv | null>(null);

export function BookingsProvider({ value, children }: { value: BookingsEnv; children?: ReactNode }) {
  return <BookingsContext.Provider value={value}>{children}</BookingsContext.Provider>;
}

export function useMaybeBookings(): BookingsEnv | null {
  return useContext(BookingsContext);
}

export function useBookings(): BookingsEnv {
  const env = useContext(BookingsContext);
  if (!env) throw new Error("BookingsProvider не подключён");
  return env;
}

/**
 * Ресурсы бронирования места для карточки (C06 → C07): null — модуль выключен, нет региона, ещё грузится или
 * ошибка (тогда карточка без бейджа доступности, как без модуля).
 */
export function usePlaceResources(placeId: string, regionId: string | null): Resource[] | null {
  const env = useMaybeBookings();
  const on = useFeatureFlag("module.bookings");
  const [loaded, setLoaded] = useState<{ key: string; items: Resource[] | null } | null>(null);
  const key = `${regionId}:${placeId}`;
  const api = env?.api;
  useEffect(() => {
    if (!on || !api || !regionId || !placeId) return;
    let alive = true;
    api.resources(regionId, placeId).then(
      (items) => alive && setLoaded({ key, items }),
      () => alive && setLoaded({ key, items: null }),
    );
    return () => {
      alive = false;
    };
  }, [on, api, regionId, placeId, key]);
  if (!on || !api || !regionId || loaded?.key !== key) return null;
  return loaded.items;
}
