// Сезон для «Мій план» (просьба владельца 03.11.2026): время года по часовому поясу региона (Europe/Kyiv) — зима
// (грудень–лютий), весна, літо, осінь. Сценарии и варианты на выбор — только уместные в этот сезон: зимой без
// летних походов на вершины и мест с тегом «Літо», летом без мест с тегом «Зима» (лыжи). Без Nest и БД.
import { SCENARIO_SEASONS, type ScenarioSeason } from "../../db/index.js";
import { isSeasonalHike, landmarkOf } from "./visit-duration.js";

export const DEFAULT_TIME_ZONE = "Europe/Kyiv";

/** Месяц 1…12 → сезон. */
export function seasonOfMonth(month: number): ScenarioSeason {
  if (month === 12 || month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "autumn";
}

const monthFormatters = new Map<string, Intl.DateTimeFormat>();

/** Сезон момента в часовом поясе (по умолчанию Europe/Kyiv); неизвестный пояс — Europe/Kyiv. */
export function seasonAt(at: Date, timeZone: string = DEFAULT_TIME_ZONE): ScenarioSeason {
  let f = monthFormatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric" });
    } catch {
      return seasonAt(at, DEFAULT_TIME_ZONE);
    }
    monthFormatters.set(timeZone, f);
  }
  return seasonOfMonth(Number(f.format(at)));
}

/** Сезон местной даты YYYY-MM-DD (дата начала плана). */
export function seasonOfDate(date: string): ScenarioSeason {
  return seasonOfMonth(Number(date.slice(5, 7)));
}

/** Сценарий уместен в сезон: сезоны не заданы (круглый год) или среди них есть этот. */
export function scenarioFitsSeason(seasons: readonly string[], season: ScenarioSeason): boolean {
  return seasons.length === 0 || seasons.includes(season);
}

/** Признаки места для сезона: категории, названия из Google, коды тегов (summer, winter). */
export type SeasonPlace = {
  category: string;
  extraCategories?: readonly string[] | undefined;
  names: readonly string[];
  tags: readonly string[];
};

/**
 * Чисто лыжное (прокат лыж, школы): не летом и не осенью — снега нет. Весной (березень) катаются; подъёмники и
 * лыжные магазины работают круглый год (подъёмник летом возит туристов на гору) — их не прячем.
 */
export const SNOW_ONLY_CATEGORIES: ReadonlySet<string> = new Set(["ski-schools", "ski-rental"]);
const SNOWLESS: ReadonlySet<ScenarioSeason> = new Set(["summer", "autumn"]);

/**
 * Место уместно в сезон. Тег «Літо» без «Зима» — не зимой; «Зима» без «Літо» — только зимой; прокат лыж и школы — не летом и не осенью;
 * поход на вершину (Говерла, Хом'як, Синяк…) — не зимой.
 */
export function placeFitsSeason(p: SeasonPlace, season: ScenarioSeason): boolean {
  const summer = p.tags.includes("summer");
  const winter = p.tags.includes("winter");
  if (summer && !winter && season === "winter") return false;
  if (winter && !summer && season !== "winter") return false;
  if (SNOWLESS.has(season) && SNOW_ONLY_CATEGORIES.has(p.category)) return false;
  // Горный поход (isSeasonalHike: маршруты природы и активностей) — не зимой; кроме маршрутов, уместных и зимой.
  if (season === "winter" && isSeasonalHike(p) && !landmarkOf(p)?.winterOk) return false;
  return true;
}

export const isSeason = (v: unknown): v is ScenarioSeason =>
  typeof v === "string" && (SCENARIO_SEASONS as readonly string[]).includes(v);
