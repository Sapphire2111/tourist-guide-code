// Кандидаты для одного заказа: реальные места каталога рядом с районом, уместные в сезон и для аудитории (діти, дощ,
// без авто). Модель видит их под короткими ссылками p1…pN (не UUID — их нельзя «придумать»), программа переводит
// ссылки обратно в place id и проверяет. Мест в списке не больше ~80 — промпт небольшой.
import type { LonLat, ScenarioSeason } from "../db/index.js";
import { SCENARIO_SEASONS, placeFitsSeason, sphericalMeters } from "../modules/planner/index.js";
import type { Brief } from "./briefs.js";
import type { GenCatalog, GenPlace } from "./catalog.js";

export const MEAL_CATEGORIES = ["restaurants", "kolyby", "cafes", "fast-food"] as const;
export const RELAX_CATEGORIES = ["chany", "spa"] as const;
/** Под крышей (как «якщо дощ» в «Мій план»): музеи, еда, чаны/SPA, сувениры. */
export const INDOOR_CATEGORIES = ["museums", ...MEAL_CATEGORIES, ...RELAX_CATEGORIES, "souvenirs"] as const;
/** Категории, из которых строится день (сервисы — аптеки, такси, АЗС — не пункты плана). */
const PLAN_CATEGORIES = new Set([
  "nature",
  "sights",
  "museums",
  "excursions",
  "active",
  "entertainment",
  "kids",
  "adult-fun",
  "ski-resorts",
  "ski-lifts",
  "ski-schools",
  "ski-rental",
  "gear-rental",
  ...MEAL_CATEGORIES,
  ...RELAX_CATEGORIES,
  "markets",
  "souvenirs",
]);

/** Не пункт плана: парковки, остановки, лесничества, безликие «Гора», «Відпочинок», «Джерело». */
const JUNK_RE =
  /(^|[^\p{L}])тц([^\p{L}]|$)|торгов\p{L}*\s+центр|парковк|автопарк|parking|зупинка|шиномонтаж|лісництв|профспілк|природоохоронн|науково|^\s*(гора|карпати|яремче|микуличин|відпочинок|отдих|джерело|криниця|качеля|гойдалка|колиба|вихід з лісу|місце для туристів|стіл для відпочинку|деревʼяний будиночок|бук|ожина|встреча)\s*$/iu;

const MAX = { focus: 40, meals: 18, relax: 8, other: 12 } as const;

export type Candidate = { ref: string; place: GenPlace; distance: number; focus: boolean };

export type CandidateSet = {
  candidates: Candidate[];
  byRef: Map<string, GenPlace>;
  center: LonLat;
  viable: boolean;
  /** Почему заказ не собрать из каталога (для отчёта). */
  reason: string | null;
};

const isWaterfall = (p: GenPlace) => p.kind === "waterfall";

/** Сезоны заказа: пустой — круглый год, место должно подходить во все. */
export const seasonsOf = (b: Pick<Brief, "seasons">): readonly ScenarioSeason[] =>
  b.seasons.length ? b.seasons : SCENARIO_SEASONS;

export function fitsBrief(p: GenPlace, b: Brief): boolean {
  if (!PLAN_CATEGORIES.has(p.category) || p.names.some((n) => JUNK_RE.test(n))) return false;
  if (p.category === "excursions" && b.theme.code !== "guided-peak") return false;
  // Лыжный курорт вне зимы — не «лижі ~5 год»: летний Буковель представлен парками, озером и активностями.
  if (p.category === "ski-resorts" && (b.seasons.length !== 1 || b.seasons[0] !== "winter")) return false;
  if (!seasonsOf(b).every((s) => placeFitsSeason(p, s))) return false;
  if (b.theme.kids && (p.adultsOnly || (p.estimate.kind === "hike" && p.estimate.minutes > 240)))
    return false;
  if (
    b.theme.rain &&
    !(INDOOR_CATEGORIES as readonly string[]).includes(p.category) &&
    !p.tags.includes("rainy-day")
  )
    return false;
  if (b.theme.noCar && p.estimate.minutes > 240) return false;
  return true;
}

function score(c: { place: GenPlace; distance: number }, radius: number): number {
  const p = c.place;
  const popularity = p.ratingCount ? Math.log10(p.ratingCount + 1) * ((p.rating ?? 3.5) / 5) : 0;
  return (p.recommended ? 2 : 0) + popularity + (p.estimate.landmark ? 1.5 : 0) - c.distance / radius;
}

/** Центр района заказа: населённый пункт каталога. */
export function areaCenter(catalog: GenCatalog, area: string): LonLat | null {
  return catalog.localities.find((l) => l.code === area)?.location ?? null;
}

export function selectCandidates(b: Brief, catalog: GenCatalog): CandidateSet {
  const center = areaCenter(catalog, b.area);
  if (!center)
    return {
      candidates: [],
      byRef: new Map(),
      center: { lon: 0, lat: 0 },
      viable: false,
      reason: "нет района",
    };
  const radius = b.theme.radius;
  const near = catalog.places
    .map((place) => ({ place, distance: sphericalMeters(center, place.location) }))
    .filter((c) => c.distance <= radius && fitsBrief(c.place, b));
  const focusSet = new Set(b.theme.focus);
  const isFocus = (p: GenPlace) =>
    focusSet.has(p.category) ||
    p.extraCategories.some((c) => focusSet.has(c)) ||
    (b.theme.code === "waterfalls" && isWaterfall(p)) ||
    (b.theme.code === "peak" && p.estimate.kind === "hike");
  const groups = { focus: [], meals: [], relax: [], other: [] } as Record<keyof typeof MAX, typeof near>;
  for (const c of near) {
    const g = isFocus(c.place)
      ? "focus"
      : (MEAL_CATEGORIES as readonly string[]).includes(c.place.category)
        ? "meals"
        : (RELAX_CATEGORIES as readonly string[]).includes(c.place.category)
          ? "relax"
          : "other";
    groups[g].push(c);
  }
  const picked: Candidate[] = [];
  for (const g of ["focus", "meals", "relax", "other"] as const) {
    const sorted = groups[g].sort(
      (x, y) => score(y, radius) - score(x, radius) || (x.place.id < y.place.id ? -1 : 1),
    );
    // Водоспады и маршруты темы — первыми, чтобы не вытеснились популярными кафе.
    for (const c of sorted.slice(0, MAX[g])) picked.push({ ...c, ref: "", focus: g === "focus" });
  }
  picked.sort((x, y) => x.distance - y.distance);
  picked.forEach((c, i) => (c.ref = `p${i + 1}`));
  const byRef = new Map(picked.map((c) => [c.ref, c.place]));
  const reason = viability(b, picked);
  return { candidates: picked, byRef, center, viable: reason === null, reason };
}

function viability(b: Brief, list: readonly Candidate[]): string | null {
  const has = (f: (p: GenPlace) => boolean, n = 1) => list.filter((c) => f(c.place)).length >= n;
  const meals = has((p) => (MEAL_CATEGORIES as readonly string[]).includes(p.category), 2);
  switch (b.theme.code) {
    case "peak":
      if (!has((p) => p.estimate.kind === "hike" && p.estimate.minutes >= 200))
        return "нет маршрута на вершину";
      break;
    case "guided-peak":
      if (!has((p) => p.estimate.kind === "tour")) return "нет турфирмы с вершиной в названии";
      break;
    case "dovbush":
      if (!has((p) => p.estimate.landmark?.code === "dovbush-rocks")) return "нет скель/стежки Довбуша";
      break;
    case "ski":
      if (!has((p) => p.category === "ski-resorts" || p.category === "ski-lifts"))
        return "нет лыжного комплекса";
      break;
    case "waterfalls":
      if (!has(isWaterfall, 2)) return "меньше 2 водоспадов";
      break;
    default:
      if (!has((p) => list.find((c) => c.place === p)!.focus, 3 * b.days)) return "мало мест темы";
  }
  return meals ? null : "мало мест, де поїсти";
}

const DAY_UK = ["", "пн", "вт", "ср", "чт", "пт", "сб", "нд"];

/** График недели коротко: «пн-нд 09:00-18:00», «пн-пт 10:00-17:00; сб 10:00-15:00»; без графика — «?». */
export function weeklyShort(weekly: GenPlace["weekly"]): string {
  if (!weekly.length) return "?";
  const byDay = new Map<number, string>();
  for (const w of [...weekly].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.opensAt.localeCompare(b.opensAt)))
    byDay.set(w.dayOfWeek, [byDay.get(w.dayOfWeek), `${w.opensAt}-${w.closesAt}`].filter(Boolean).join(","));
  const parts: string[] = [];
  let start = 1;
  for (let d = 1; d <= 8; d++) {
    if (d <= 7 && byDay.get(d) === byDay.get(start)) continue;
    const h = byDay.get(start);
    if (h) parts.push(`${DAY_UK[start]}${d - 1 > start ? `-${DAY_UK[d - 1]}` : ""} ${h}`);
    start = d;
  }
  const closed = [1, 2, 3, 4, 5, 6, 7].filter((d) => !byDay.has(d)).map((d) => DAY_UK[d]);
  return parts.join("; ") + (closed.length ? `; вихідний ${closed.join(",")}` : "");
}

const KIND_UK: Record<string, string> = {
  hike: "похід",
  walk: "прогулянка",
  visit: "огляд",
  tour: "екскурсія з гідом",
  activity: "активність",
  meal: "їжа",
  relax: "відпочинок",
  ski: "лижі",
  shopping: "покупки",
};

/** Строка кандидата для промпта. */
export function candidateLine(c: Candidate): string {
  const p = c.place;
  const est = p.estimate;
  const what = [p.category, p.kind !== p.category ? p.kind : null, p.typeLabel].filter(Boolean).join("/");
  const rating = p.rating !== null && p.ratingCount ? ` | ★${p.rating}·${p.ratingCount}` : "";
  const tags = p.tags.length ? ` | теги: ${p.tags.join(",")}` : "";
  const lm = est.landmark
    ? ` | ${est.landmark.name}${est.landmark.from ? ` ${est.landmark.from}` : ""}${est.fixed ? " (тривалість фіксована)" : ""}`
    : "";
  return (
    `${c.ref} | ${p.name} | ${what} | ${p.location.lat.toFixed(3)},${p.location.lon.toFixed(3)} | ` +
    `${KIND_UK[est.kind] ?? est.kind} ~${est.minutes} хв${lm}${rating}${tags} | ${weeklyShort(p.weekly)}`
  );
}
