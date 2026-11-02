// Варианты на выбор для «Мій план» (просьба владельца 02.11.2026): на каждую часть дня (ранок, день, вечір) и на
// «якщо дощ» — 3–5 настоящих мест каталога региона (они из Google Maps), разных по смыслу; турист отмечает галочками,
// что будет делать. Без Nest и БД. Ничего не выдумываем: подпись — категория места (или «Водоспад»/«Бар» по названию
// из Google), причина — что даёт эта категория в эту часть дня, расстояние — по прямой от предыдущего пункта дня
// (или базовой точки), время в пути — оценка по средней скорости. Цен, рейтингов, часов работы не придумываем.
import type { LonLat, PlanSlot } from "../../db/index.js";
import { sphericalMeters } from "./plan-rules.js";

export const PLAN_DAYS_MAX = 14;
export const OPTIONS_PER_SLOT = 5;
/** Пешая доступность по прямой, м (≈ 25–30 хв пішки с поправкой на дорогу). */
export const WALK_MAX_M = 2000;
/** Дальше этого и на машине не предлагаем (по прямой), м. */
export const CAR_MAX_M = 35_000;
/** Без машины: если в пешей доступности вариантов меньше — добавляем ближайшие с пометкой «потрібен транспорт». */
const MIN_OPTIONS = 3;

/** Место каталога-кандидат: опубликовано, с точкой, категория активна. */
export type CatalogPlace = {
  id: string;
  /** Код подкатегории (cafes, museums, nature…). */
  category: string;
  /** Все языковые варианты названия — для признаков по названию (водоспад, бар). */
  names: readonly string[];
  location: LonLat;
  /** Коды тегов места (kids, rainy-day…). */
  tags: readonly string[];
  recommended: boolean;
};

/** Что это за место для подписи: код категории, а по названию из Google — водоспад и бар. */
export type PlaceKind = string;

export type OptionReason =
  | "breakfast"
  | "lunch"
  | "dinner"
  | "evening_out"
  | "walk"
  | "culture"
  | "active"
  | "fun"
  | "relax"
  | "shopping"
  | "indoor";

export type Travel = "walk" | "car" | "transport";

export type PlanOption = {
  placeId: string;
  kind: PlaceKind;
  reason: OptionReason;
  /** По прямой от предыдущего пункта дня или базовой точки; null — не от чего считать. */
  distanceMeters: number | null;
  travel: Travel;
  /** Оценка в пути, мин; null — без расстояния. */
  travelMinutes: number | null;
  kidsFriendly: boolean;
};

export type TripParams = { children: number; withCar: boolean };

/** Пункт плана для подбора: где он и в какой части дня. */
export type ChosenItem = { dayNo: number; slot: PlanSlot; placeId: string; location: LonLat | null };

export type DayOptions = { dayNo: number; slots: { slot: PlanSlot; options: PlanOption[] }[] };

const SLOT_ORDER: readonly PlanSlot[] = ["morning", "afternoon", "evening", "rain"];

/** Категории части дня в порядке предпочтения: разнообразие — по одному месту каждой по кругу. */
const SLOT_CATEGORIES: Record<PlanSlot, readonly string[]> = {
  morning: ["cafes", "nature", "sights", "museums", "excursions", "active"],
  afternoon: [
    "restaurants",
    "kolyby",
    "nature",
    "sights",
    "museums",
    "entertainment",
    "active",
    "gear-rental",
    "souvenirs",
    "markets",
  ],
  evening: ["restaurants", "kolyby", "chany", "spa", "cafes"],
  // Под крышей: музеи, кафе, ресторации, чаны и SPA, сувенирные лавки; аттракционы — только с тегом «У дощ».
  rain: ["museums", "cafes", "restaurants", "kolyby", "chany", "spa", "souvenirs", "stores"],
};

/** С детьми — сначала то, что интересно детям. */
const KIDS_FIRST = new Set(["museums", "entertainment", "nature", "sights", "active", "cafes"]);

const L = "\\p{L}";
const word = (src: string) => new RegExp(`(^|[^${L}])(${src})([^${L}]|$)`, "iu");
const WATERFALL_RE = /водоспад|waterfall/iu;
/** Бар, паб, винний чи коктейль-бар — у Google это тип bar/pub, у нас категория cafes (mapping.ts). */
const BAR_RE = word(
  "бар|bar|паб|pub|пивн\\p{L}*|beer|винн\\p{L}*|wine|cocktail|коктейль\\p{L}*|lounge|лаунж",
);
/** Ночная жизнь — не для детей в любой категории. */
const NIGHTLIFE_RE = /нічн\p{L}*\s+клуб|night\s*club|кальян|hookah|стрип|strip/iu;
/** ТРЦ/ТЦ — под крышей; прочие магазины в «якщо дощ» не предлагаем. */
const MALL_RE = word("трц|тц|mall|торгов\\p{L}*\\s+центр");

export function placeKind(p: Pick<CatalogPlace, "category" | "names">): PlaceKind {
  if ((p.category === "nature" || p.category === "sights") && p.names.some((n) => WATERFALL_RE.test(n)))
    return "waterfall";
  if (p.category === "cafes" && p.names.some((n) => BAR_RE.test(n))) return "bar";
  return p.category;
}

/** Не для детей: бары и ночная жизнь (признак — категория и название из Google). */
export function adultsOnly(p: Pick<CatalogPlace, "category" | "names">): boolean {
  return placeKind(p) === "bar" || p.names.some((n) => NIGHTLIFE_RE.test(n));
}

/** Часть дня пункта: выбранная или по времени (до 12 — ранок, до 17 — день, далі — вечір; без часу — день). */
export function slotOf(item: { slot?: PlanSlot | undefined; timeHint: string | null }): PlanSlot {
  if (item.slot) return item.slot;
  if (!item.timeHint) return "afternoon";
  const h = Number(item.timeHint.slice(0, 2));
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

export const slotRank = (s: PlanSlot) => SLOT_ORDER.indexOf(s);

function reasonOf(slot: PlanSlot, category: string): OptionReason {
  if (slot === "rain") return "indoor";
  switch (category) {
    case "cafes":
      return slot === "morning" ? "breakfast" : "evening_out";
    case "restaurants":
    case "kolyby":
      return slot === "evening" ? "dinner" : "lunch";
    case "nature":
    case "sights":
      return "walk";
    case "museums":
    case "excursions":
      return "culture";
    case "active":
    case "gear-rental":
      return "active";
    case "chany":
    case "spa":
      return "relax";
    case "souvenirs":
    case "markets":
    case "stores":
      return "shopping";
    default:
      return "fun";
  }
}

/** Оценка в пути: пешком 4,5 км/ч, авто 35 км/ч по горным дорогам; к прямой — поправка на извилистость. */
export function travelMinutes(meters: number, travel: Travel): number {
  const road = meters * 1.3;
  const kmh = travel === "walk" ? 4.5 : 35;
  return Math.max(1, Math.round((road / 1000 / kmh) * 60));
}

function fitsSlot(p: CatalogPlace, slot: PlanSlot): boolean {
  if (slot !== "rain") return SLOT_CATEGORIES[slot].includes(p.category);
  if (p.tags.includes("rainy-day")) return true;
  if (p.category === "stores") return p.names.some((n) => MALL_RE.test(n));
  return SLOT_CATEGORIES.rain.includes(p.category);
}

type Scored = { p: CatalogPlace; d: number | null };

/**
 * Варианты одной части дня: подходящие категории, без уже выбранных мест; разнообразие — по кругу по категориям
 * (в каждой — сначала с тегом «З дітьми», если есть дети, затем рекомендованные, затем ближайшие). Без машины —
 * сначала пешая доступность, при нехватке — ближайшие дальше с travel = transport.
 */
export function slotOptions(
  slot: PlanSlot,
  from: LonLat | null,
  places: readonly CatalogPlace[],
  trip: TripParams,
  exclude: ReadonlySet<string>,
): PlanOption[] {
  const kids = trip.children > 0;
  const pool: Scored[] = places
    .filter((p) => !exclude.has(p.id) && fitsSlot(p, slot) && !(kids && adultsOnly(p)))
    .map((p) => ({ p, d: from ? sphericalMeters(from, p.location) : null }))
    .filter((s) => s.d === null || s.d <= CAR_MAX_M);
  const better = (a: Scored, b: Scored) =>
    (kids ? Number(b.p.tags.includes("kids")) - Number(a.p.tags.includes("kids")) : 0) ||
    Number(b.p.recommended) - Number(a.p.recommended) ||
    (a.d ?? 0) - (b.d ?? 0) ||
    (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0);

  const order = [...SLOT_CATEGORIES[slot]];
  if (kids) order.sort((a, b) => Number(KIDS_FIRST.has(b)) - Number(KIDS_FIRST.has(a)));
  const pick = (candidates: Scored[], limit: number): Scored[] => {
    const byCat = new Map<string, Scored[]>();
    for (const s of candidates) {
      const cat = order.includes(s.p.category) ? s.p.category : "_other";
      byCat.set(cat, [...(byCat.get(cat) ?? []), s]);
    }
    for (const list of byCat.values()) list.sort(better);
    const cats = [...order, "_other"].filter((c) => byCat.has(c));
    const out: Scored[] = [];
    // По кругу: одно место каждой категории, пока не наберём limit.
    for (let round = 0; out.length < limit; round++) {
      let added = false;
      for (const c of cats) {
        const s = byCat.get(c)![round];
        if (s && out.length < limit) {
          out.push(s);
          added = true;
        }
      }
      if (!added) break;
    }
    return out;
  };

  let chosen: { s: Scored; travel: Travel }[];
  if (trip.withCar || from === null) {
    chosen = pick(pool, OPTIONS_PER_SLOT).map((s) => ({
      s,
      travel: s.d !== null && s.d <= WALK_MAX_M ? "walk" : "car",
    }));
    if (!trip.withCar) chosen = chosen.map((c) => ({ ...c, travel: "transport" }));
  } else {
    const walk = pick(
      pool.filter((s) => s.d! <= WALK_MAX_M),
      OPTIONS_PER_SLOT,
    );
    chosen = walk.map((s) => ({ s, travel: "walk" as Travel }));
    if (walk.length < MIN_OPTIONS) {
      const far = pool.filter((s) => s.d! > WALK_MAX_M).sort((a, b) => a.d! - b.d!);
      chosen.push(
        ...far.slice(0, MIN_OPTIONS - walk.length).map((s) => ({ s, travel: "transport" as Travel })),
      );
    }
  }
  return chosen.map(({ s, travel }) => ({
    placeId: s.p.id,
    kind: placeKind(s.p),
    reason: reasonOf(slot, s.p.category),
    distanceMeters: s.d,
    travel,
    travelMinutes: s.d === null ? null : travelMinutes(s.d, travel === "walk" ? "walk" : "car"),
    kidsFriendly: s.p.tags.includes("kids"),
  }));
}

/**
 * Варианты по всем дням плана. Точка отсчёта части дня — последний выбранный пункт раньше в этот день, иначе базовая
 * точка плана. Одно место не предлагается дважды в разные части дня/дни (кроме «якщо дощ» — запасной набор на
 * каждый день), выбранные места плана — не предлагаются.
 */
export function planOptions(input: {
  days: number;
  items: readonly ChosenItem[];
  places: readonly CatalogPlace[];
  trip: TripParams;
  base: LonLat | null;
}): DayOptions[] {
  const inPlan = new Set(input.items.map((i) => i.placeId));
  const offered = new Set(inPlan);
  const out: DayOptions[] = [];
  for (let dayNo = 1; dayNo <= input.days; dayNo++) {
    const day = input.items
      .filter((i) => i.dayNo === dayNo && i.slot !== "rain" && i.location)
      .sort((a, b) => slotRank(a.slot) - slotRank(b.slot));
    const slots: DayOptions["slots"] = [];
    for (const slot of SLOT_ORDER) {
      const before = slot === "rain" ? [] : day.filter((i) => slotRank(i.slot) < slotRank(slot));
      const from = before.at(-1)?.location ?? input.base ?? day[0]?.location ?? null;
      const options = slotOptions(slot, from, input.places, input.trip, slot === "rain" ? inPlan : offered);
      if (slot !== "rain") for (const o of options) offered.add(o.placeId);
      slots.push({ slot, options });
    }
    out.push({ dayNo, slots });
  }
  return out;
}
