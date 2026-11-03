// Прогноз погоды (просьба владельца 03.11.2026): общая модель прогноза, предупреждения туристу, разбор ответа
// Open-Meteo (запасной источник; основной — Google Weather, google-weather.ts). Без Nest и сети. Ничего не выдумываем:
// нет значения у источника — null; нет ответа — прогноза нет.

/** Источник прогноза: подпись у клиента — по нему (Google — «Includes weather data from Google», Open-Meteo — CC BY 4.0). */
export const WEATHER_SOURCES = ["google", "open-meteo"] as const;
export type WeatherSource = (typeof WEATHER_SOURCES)[number];

/** Предупреждения дня (ключи текстов клиента miniapp.weather.warning.*). */
export const WEATHER_WARNINGS = [
  "thunderstorm",
  "heavy_rain",
  "strong_wind",
  "frost",
  "heavy_snow",
  "ice",
  "heat",
] as const;
export type WeatherWarning = (typeof WEATHER_WARNINGS)[number];

/** Погода одним словом (ключ текста и своей иконки клиента miniapp.weather.condition.*). */
export const WEATHER_CONDITIONS = [
  "clear",
  "partly_cloudy",
  "cloudy",
  "fog",
  "drizzle",
  "rain",
  "heavy_rain",
  "showers",
  "thunderstorm",
  "snow",
  "heavy_snow",
  "sleet",
  "freezing_rain",
  "hail",
  "windy",
] as const;
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

/** Дней прогноза: по умолчанию и не больше (дальше недели прогноз ненадёжен). */
export const FORECAST_DAYS_DEFAULT = 7;
export const FORECAST_DAYS_MAX = 7;

/**
 * Пороги предупреждений. Сильный дождь — от 20 мм за сутки; ветер — порывы от 60 км/ч или средний от 40 км/ч (в горах
 * и на вершинах опасно); мороз — минимум −10 °C и ниже; снегопад — от 10 см за сутки; жара — максимум от 32 °C;
 * гроза — по погоде или вероятности грозы от 50 %.
 */
export const THRESHOLDS = {
  heavyRainMm: 20,
  windGustKmh: 60,
  windKmh: 40,
  frostC: -10,
  heavySnowCm: 10,
  heatC: 32,
  thunderPercent: 50,
  /** Дождь (для «якщо дощ»): жидкие осадки за сутки, мм. */
  rainMm: 2,
} as const;

/**
 * Опасно для походов в горы и на вершины: гроза, сильный ветер, снегопад, гололёд. В такие дни планировщик не
 * предлагает горные походы и помечает уже выбранные.
 */
export const HIKE_UNSAFE: readonly WeatherWarning[] = ["thunderstorm", "strong_wind", "heavy_snow", "ice"];
/** Что из предупреждений относится к походу в горы (мороз — тоже, жара в горах — нет). */
export const HIKE_RELEVANT: readonly WeatherWarning[] = [...HIKE_UNSAFE, "frost"];

const RAINY: ReadonlySet<WeatherCondition> = new Set([
  "drizzle",
  "rain",
  "heavy_rain",
  "showers",
  "thunderstorm",
  "sleet",
  "freezing_rain",
  "hail",
]);
export const isRainyCondition = (c: WeatherCondition | null) => c !== null && RAINY.has(c);

export type WeatherDay = {
  /** Местная дата точки. */
  date: string;
  condition: WeatherCondition | null;
  /** Описание у источника на языке запроса (Google, uk); у Open-Meteo — null (текст клиента по condition). */
  description: string | null;
  /** Иконка источника (Google: iconBaseUri + ".svg"); null — клиент рисует свою по condition. */
  iconUrl: string | null;
  temperatureMax: number | null;
  temperatureMin: number | null;
  /** Осадки за сутки (в воде), мм. */
  precipitationSum: number | null;
  precipitationProbabilityMax: number | null;
  /** Снег за сутки, см (у Google — нет, null). */
  snowfallSum: number | null;
  windSpeedMax: number | null;
  windGustsMax: number | null;
  /** Ожидается дождь — турист видит запасной план «якщо дощ». */
  rainy: boolean;
  warnings: WeatherWarning[];
};

export type WeatherNow = {
  time: string | null;
  temperature: number | null;
  condition: WeatherCondition | null;
  description: string | null;
  iconUrl: string | null;
  windSpeed: number | null;
  isDay: boolean | null;
};

export type Forecast = {
  source: WeatherSource;
  latitude: number;
  longitude: number;
  /** Высота точки над уровнем моря по модели рельефа источника, м (у Google — null). */
  elevation: number | null;
  timezone: string | null;
  current: WeatherNow | null;
  days: WeatherDay[];
};

/** Признаки для предупреждений: числа дня и погода (у Google — днём и ночью). */
export type WarningInput = {
  conditions: readonly (WeatherCondition | null)[];
  temperatureMax: number | null;
  temperatureMin: number | null;
  /** Жидкие осадки (без снега), мм; null — неизвестно. */
  liquidMm: number | null;
  snowfallCm: number | null;
  windSpeedMax: number | null;
  windGustsMax: number | null;
  thunderProbability?: number | null;
  iceMm?: number | null;
};

/** Предупреждения дня по порогам THRESHOLDS и погоде. */
export function dayWarnings(d: WarningInput): WeatherWarning[] {
  const has = (...c: WeatherCondition[]) => d.conditions.some((x) => x !== null && c.includes(x));
  const out: WeatherWarning[] = [];
  if (has("thunderstorm") || (d.thunderProbability ?? 0) >= THRESHOLDS.thunderPercent)
    out.push("thunderstorm");
  if (has("heavy_rain") || (d.liquidMm ?? 0) >= THRESHOLDS.heavyRainMm) out.push("heavy_rain");
  if ((d.windGustsMax ?? 0) >= THRESHOLDS.windGustKmh || (d.windSpeedMax ?? 0) >= THRESHOLDS.windKmh)
    out.push("strong_wind");
  if (d.temperatureMin !== null && d.temperatureMin <= THRESHOLDS.frostC) out.push("frost");
  if (has("heavy_snow") || (d.snowfallCm ?? 0) >= THRESHOLDS.heavySnowCm) out.push("heavy_snow");
  if (has("freezing_rain") || (d.iceMm ?? 0) > 0) out.push("ice");
  if (d.temperatureMax !== null && d.temperatureMax >= THRESHOLDS.heatC) out.push("heat");
  return out;
}

/** Опасно ли идти в горы в этот день. */
export function hikeUnsafe(day: Pick<WeatherDay, "warnings">): boolean {
  return day.warnings.some((w) => HIKE_UNSAFE.includes(w));
}

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const maxOf = (...v: (number | null)[]): number | null => {
  const xs = v.filter((x): x is number => x !== null);
  return xs.length ? Math.max(...xs) : null;
};

// --- Open-Meteo (запасной источник, без ключа) ---

/** Код погоды WMO (Open-Meteo weather_code) → погода одним словом. */
export function wmoCondition(code: number | null): WeatherCondition | null {
  if (code === null) return null;
  if (code === 0 || code === 1) return "clear";
  if (code === 2) return "partly_cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 55) return "drizzle";
  if (code === 56 || code === 57 || code === 66 || code === 67) return "freezing_rain";
  if (code === 61 || code === 63) return "rain";
  if (code === 65) return "heavy_rain";
  if (code === 71 || code === 73 || code === 77 || code === 85) return "snow";
  if (code === 75 || code === 86) return "heavy_snow";
  if (code === 80 || code === 81) return "showers";
  if (code === 82) return "heavy_rain";
  if (code === 95) return "thunderstorm";
  if (code === 96 || code === 99) return "thunderstorm";
  return null;
}

export const OPEN_METEO_DAILY = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "rain_sum",
  "showers_sum",
  "snowfall_sum",
  "precipitation_probability_max",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
] as const;
export const OPEN_METEO_CURRENT = ["temperature_2m", "weather_code", "wind_speed_10m", "is_day"] as const;

export function openMeteoUrl(base: string, lat: number, lng: number, days: number): string {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    daily: OPEN_METEO_DAILY.join(","),
    current: OPEN_METEO_CURRENT.join(","),
    timezone: "auto",
    forecast_days: String(days),
    wind_speed_unit: "kmh",
  });
  return `${base}?${q.toString()}`;
}

const at = (arr: unknown, i: number): number | null => (Array.isArray(arr) ? num(arr[i]) : null);

/**
 * Ответ Open-Meteo → прогноз. Неверная форма (нет daily.time, нет координат) — null (как сбой источника). Значения,
 * которых у источника нет, — null; предупреждения — только по имеющимся значениям.
 */
export function parseOpenMeteo(body: unknown): Forecast | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const latitude = num(b.latitude);
  const longitude = num(b.longitude);
  const daily = b.daily as Record<string, unknown> | undefined;
  if (latitude === null || longitude === null || !daily || !Array.isArray(daily.time)) return null;
  const days: WeatherDay[] = [];
  daily.time.forEach((t, i) => {
    if (typeof t !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return;
    const rain = at(daily.rain_sum, i);
    const showers = at(daily.showers_sum, i);
    const liquid = rain === null && showers === null ? null : (rain ?? 0) + (showers ?? 0);
    const condition = wmoCondition(at(daily.weather_code, i));
    const d = {
      date: t,
      condition,
      description: null,
      iconUrl: null,
      temperatureMax: at(daily.temperature_2m_max, i),
      temperatureMin: at(daily.temperature_2m_min, i),
      precipitationSum: at(daily.precipitation_sum, i),
      precipitationProbabilityMax: at(daily.precipitation_probability_max, i),
      snowfallSum: at(daily.snowfall_sum, i),
      windSpeedMax: at(daily.wind_speed_10m_max, i),
      windGustsMax: at(daily.wind_gusts_10m_max, i),
    };
    days.push({
      ...d,
      rainy: isRainyCondition(condition) || (liquid !== null && liquid >= THRESHOLDS.rainMm),
      warnings: dayWarnings({
        conditions: [condition],
        temperatureMax: d.temperatureMax,
        temperatureMin: d.temperatureMin,
        liquidMm: liquid,
        snowfallCm: d.snowfallSum,
        windSpeedMax: d.windSpeedMax,
        windGustsMax: d.windGustsMax,
      }),
    });
  });
  const c = b.current as Record<string, unknown> | undefined;
  const isDay = c ? num(c.is_day) : null;
  const current: WeatherNow | null = c
    ? {
        time: typeof c.time === "string" ? c.time : null,
        temperature: num(c.temperature_2m),
        condition: wmoCondition(num(c.weather_code)),
        description: null,
        iconUrl: null,
        windSpeed: num(c.wind_speed_10m),
        isDay: isDay === null ? null : isDay === 1,
      }
    : null;
  return {
    source: "open-meteo",
    latitude,
    longitude,
    elevation: num(b.elevation),
    timezone: typeof b.timezone === "string" ? b.timezone : null,
    current,
    days,
  };
}
