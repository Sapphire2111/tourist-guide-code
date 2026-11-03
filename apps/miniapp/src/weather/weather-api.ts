// Погода: адаптер GET /weather поверх @tg/api-client. Mini App ходит только к нашему api (прогноз хранится у нас,
// иконки Google — через прокси api). Нет прогноза, флаг выключен, сбой — null: погода просто не показывается.
import type { ApiClient, ApiSchemas } from "@tg/api-client";
import type { LatLng } from "../guide/geo.js";

export type WeatherDay = ApiSchemas["WeatherDayDto"];
export type WeatherNow = ApiSchemas["WeatherNowDto"];
export type WeatherSource = ApiSchemas["WeatherSource"];
export type WeatherWarning = ApiSchemas["WeatherWarning"];
export type WeatherCondition = ApiSchemas["WeatherCondition"];

export type Forecast = {
  source: WeatherSource;
  current: WeatherNow | null;
  days: WeatherDay[];
};

export type WeatherApi = {
  forecast(point: LatLng, signal?: AbortSignal): Promise<Forecast | null>;
};

/** Дней в прогнозе на главной (лист «Погода»). */
export const HOME_FORECAST_DAYS = 5;

/** Иконка — только наш прокси /weather/icons/…svg (https или адрес api); иное — своя иконка по condition. */
export function safeIcon(url: string | null | undefined, apiBase: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const base = new URL(apiBase);
    const ours = u.origin === base.origin && /^\/weather\/icons\/[a-z0-9_]{1,60}\.svg$/.test(u.pathname);
    return ours && (u.protocol === "https:" || u.origin === base.origin) ? u.href : null;
  } catch {
    return null;
  }
}

export function createWeatherApi(api: ApiClient, regionId: string | null, apiBase: string): WeatherApi {
  return {
    async forecast(point, signal) {
      try {
        const res = await api.GET("/weather", {
          params: {
            query: {
              lat: Math.round(point.lat * 1000) / 1000,
              lng: Math.round(point.lng * 1000) / 1000,
              days: HOME_FORECAST_DAYS,
              ...(regionId ? { regionId } : {}),
            },
          },
          signal,
        });
        const dto = res.data;
        if (!res.response.ok || !dto?.available || !dto.source || dto.days.length === 0) return null;
        const icon = <T extends { iconUrl: string | null }>(x: T): T => ({
          ...x,
          iconUrl: safeIcon(x.iconUrl, apiBase),
        });
        return { source: dto.source, current: dto.current && icon(dto.current), days: dto.days.map(icon) };
      } catch {
        return null;
      }
    },
  };
}
