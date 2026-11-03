// Google Weather API (основной источник прогноза): currentConditions:lookup и forecast/days:lookup → общая модель
// (weather-rules.ts). Ключ — серверный GOOGLE_MAPS_API_KEY (в заголовке X-Goog-Api-Key, в ответ клиенту не попадает).
// Описания — на украинском (languageCode=uk), иконки — iconBaseUri + ".svg" с maps.gstatic.com. Без Nest и сети.
// Подпись у клиента по условиям Google: «Includes weather data from Google».
import {
  dayWarnings,
  isRainyCondition,
  maxOf,
  num,
  THRESHOLDS,
  type Forecast,
  type WeatherCondition,
  type WeatherDay,
  type WeatherNow,
} from "./weather-rules.js";

export const GOOGLE_WEATHER_URL = "https://weather.googleapis.com/v1";

export function googleCurrentUrl(base: string, lat: number, lng: number, lang: string): string {
  const q = new URLSearchParams({
    "location.latitude": String(lat),
    "location.longitude": String(lng),
    languageCode: lang,
    unitsSystem: "METRIC",
  });
  return `${base}/currentConditions:lookup?${q.toString()}`;
}

export function googleDaysUrl(base: string, lat: number, lng: number, days: number, lang: string): string {
  const q = new URLSearchParams({
    "location.latitude": String(lat),
    "location.longitude": String(lng),
    days: String(days),
    pageSize: String(days),
    languageCode: lang,
    unitsSystem: "METRIC",
  });
  return `${base}/forecast/days:lookup?${q.toString()}`;
}

/** Тип погоды Google (weatherCondition.type) → погода одним словом. */
export function googleCondition(type: unknown): WeatherCondition | null {
  if (typeof type !== "string") return null;
  if (/THUNDER/.test(type)) return "thunderstorm";
  if (/HAIL/.test(type)) return "hail";
  if (type === "RAIN_AND_SNOW") return "sleet";
  if (/HEAVY_SNOW|SNOWSTORM|MODERATE_TO_HEAVY_SNOW|BLIZZARD/.test(type)) return "heavy_snow";
  if (/SNOW/.test(type)) return "snow";
  if (/HEAVY_RAIN|MODERATE_TO_HEAVY_RAIN|RAIN_PERIODICALLY_HEAVY/.test(type)) return "heavy_rain";
  if (/SHOWERS/.test(type)) return "showers";
  if (/RAIN/.test(type)) return "rain";
  if (type === "WINDY") return "windy";
  if (type === "CLEAR" || type === "MOSTLY_CLEAR") return "clear";
  if (type === "PARTLY_CLOUDY") return "partly_cloudy";
  if (type === "MOSTLY_CLOUDY" || type === "CLOUDY") return "cloudy";
  if (/FOG|HAZE/.test(type)) return "fog";
  return null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" ? (v as Obj) : undefined);
const path = (v: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((o, k) => obj(o)?.[k], v);

/** Иконка Google: только https://maps.gstatic.com/weather/… (iconBaseUri + ".svg"). */
export function googleIcon(cond: unknown): string | null {
  const base = path(cond, "iconBaseUri");
  if (typeof base !== "string" || !/^https:\/\/maps\.gstatic\.com\/weather\/[a-z0-9_/-]{1,100}$/i.test(base))
    return null;
  return `${base}.svg`;
}

const text = (cond: unknown): string | null => {
  const t = path(cond, "description", "text");
  return typeof t === "string" && t.length <= 200 ? t : null;
};

/** Скорость в км/ч (METRIC — KILOMETERS_PER_HOUR; иное — не утверждаем). */
const kmh = (v: unknown): number | null => {
  const value = num(path(v, "value"));
  const unit = path(v, "unit");
  return unit === undefined || unit === "KILOMETERS_PER_HOUR" ? value : null;
};
const celsius = (v: unknown): number | null => {
  const unit = path(v, "unit");
  return unit === undefined || unit === "CELSIUS" ? num(path(v, "degrees")) : null;
};
const mm = (v: unknown): number | null => {
  const unit = path(v, "unit");
  return unit === undefined || unit === "MILLIMETERS" ? num(path(v, "quantity")) : null;
};

/** День и ночь прогноза дня Google → признаки части суток. */
function part(p: unknown) {
  const cond = path(p, "weatherCondition");
  const precipType = path(p, "precipitation", "probability", "type");
  return {
    cond,
    condition: googleCondition(path(cond, "type")),
    qpf: mm(path(p, "precipitation", "qpf")),
    snowy: typeof precipType === "string" && precipType === "SNOW",
    probability: num(path(p, "precipitation", "probability", "percent")),
    thunder: num(path(p, "thunderstormProbability")),
    wind: kmh(path(p, "wind", "speed")),
    gust: kmh(path(p, "wind", "gust")),
  };
}

function dateOf(v: unknown): string | null {
  const y = num(path(v, "year"));
  const m = num(path(v, "month"));
  const d = num(path(v, "day"));
  if (!y || !m || !d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** forecast/days:lookup → дни. Неверная форма — null. */
export function parseGoogleDays(body: unknown): { days: WeatherDay[]; timezone: string | null } | null {
  const list = path(body, "forecastDays");
  if (!Array.isArray(list)) return null;
  const days: WeatherDay[] = [];
  for (const fd of list) {
    const date = dateOf(path(fd, "displayDate"));
    if (!date) continue;
    const day = part(path(fd, "daytimeForecast"));
    const night = part(path(fd, "nighttimeForecast"));
    const precipitationSum =
      day.qpf === null && night.qpf === null ? null : (day.qpf ?? 0) + (night.qpf ?? 0);
    // Снег в воде у Google без отдельной величины: осадки части суток с типом SNOW — не дождь.
    const liquid =
      day.qpf === null && night.qpf === null
        ? null
        : (day.snowy ? 0 : (day.qpf ?? 0)) + (night.snowy ? 0 : (night.qpf ?? 0));
    const temperatureMax = celsius(path(fd, "maxTemperature"));
    const temperatureMin = celsius(path(fd, "minTemperature"));
    const windSpeedMax = maxOf(day.wind, night.wind);
    const windGustsMax = maxOf(day.gust, night.gust);
    const d = {
      date,
      condition: day.condition ?? night.condition,
      description: text(day.cond) ?? text(night.cond),
      iconUrl: googleIcon(day.cond) ?? googleIcon(night.cond),
      temperatureMax,
      temperatureMin,
      precipitationSum,
      precipitationProbabilityMax: maxOf(day.probability, night.probability),
      snowfallSum: null,
      windSpeedMax,
      windGustsMax,
    };
    // «Якщо дощ» — по дневной части: днём турист в пути.
    const dayLiquid = day.snowy ? 0 : day.qpf;
    days.push({
      ...d,
      rainy:
        isRainyCondition(day.condition) ||
        (dayLiquid !== null && dayLiquid >= THRESHOLDS.rainMm && (day.probability ?? 100) >= 50),
      warnings: dayWarnings({
        conditions: [day.condition, night.condition],
        temperatureMax,
        temperatureMin,
        liquidMm: liquid,
        snowfallCm: null,
        windSpeedMax,
        windGustsMax,
        thunderProbability: maxOf(day.thunder, night.thunder),
        iceMm: mm({
          quantity: num(path(fd, "iceThickness", "thickness")),
          unit: path(fd, "iceThickness", "unit"),
        }),
      }),
    });
  }
  const tz = path(body, "timeZone", "id");
  return { days, timezone: typeof tz === "string" ? tz : null };
}

/** currentConditions:lookup → сейчас. Неверная форма — null. */
export function parseGoogleCurrent(body: unknown): { now: WeatherNow; timezone: string | null } | null {
  const b = obj(body);
  if (!b) return null;
  const cond = b.weatherCondition;
  const temperature = celsius(b.temperature);
  if (temperature === null && !cond) return null;
  const tz = path(b, "timeZone", "id");
  return {
    now: {
      time: typeof b.currentTime === "string" ? b.currentTime : null,
      temperature,
      condition: googleCondition(path(cond, "type")),
      description: text(cond),
      iconUrl: googleIcon(cond),
      windSpeed: kmh(path(b, "wind", "speed")),
      isDay: typeof b.isDaytime === "boolean" ? b.isDaytime : null,
    },
    timezone: typeof tz === "string" ? tz : null,
  };
}

export function googleForecast(
  lat: number,
  lng: number,
  current: ReturnType<typeof parseGoogleCurrent>,
  days: NonNullable<ReturnType<typeof parseGoogleDays>>,
): Forecast {
  return {
    source: "google",
    latitude: lat,
    longitude: lng,
    elevation: null,
    timezone: days.timezone ?? current?.timezone ?? null,
    current: current?.now ?? null,
    days: days.days,
  };
}
