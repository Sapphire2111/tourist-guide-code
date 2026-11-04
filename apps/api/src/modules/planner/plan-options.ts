// Варианты на выбор для «Мій план» (просьба владельца 02.11.2026): на каждую часть дня (ранок, день, вечір) и на
// «якщо дощ» — 3–5 настоящих мест каталога региона (они из Google Maps), разных по смыслу; турист отмечает галочками,
// что будет делать. Без Nest и БД. Ничего не выдумываем: подпись — категория места (или «Водоспад»/«Бар» по названию
// из Google), причина — что даёт эта категория в эту часть дня, расстояние — по прямой от предыдущего пункта дня
// (или базовой точки), время в пути — оценка по средней скорости. Цен, рейтингов, часов работы не придумываем.
import type { LonLat, PlanSlot, ScenarioSeason } from "../../db/index.js";
import { sphericalMeters } from "./plan-rules.js";
import { placeFitsSeason } from "./season.js";
import { isMountainHike } from "./visit-duration.js";

/** Горный поход — одно определение для сезона и погоды (visit-duration.ts). */
export { isMountainHike };

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
  /** Коды активных доп. категорий (place_extra_categories): место подбирается и по ним, как в поиске гида. */
  extraCategories?: readonly string[];
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
  /** null — без точки отсчёта: как добираться, не утверждаем. */
  travel: Travel | null;
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
  // «Вершини» — сходження зранку (не зимой и не в непогоду — season.ts, isMountainHike).
  morning: ["cafes", "nature", "peaks", "sights", "museums", "excursions", "active"],
  afternoon: [
    "restaurants",
    "kolyby",
    "kids",
    "nature",
    "sights",
    "museums",
    "entertainment",
    "active",
    "gear-rental",
    "souvenirs",
    "markets",
  ],
  // «Для дорослих» (боулінг, караоке, клуби) и «Бари» — вечером и только без детей (adultsOnly).
  evening: ["restaurants", "kolyby", "chany", "spa", "cafes", "bars", "adult-fun"],
  // Под крышей: музеи, кафе, ресторации, чаны и SPA, сувенирные лавки; аттракционы — только с тегом «У дощ».
  rain: ["museums", "cafes", "restaurants", "kolyby", "chany", "spa", "souvenirs", "stores"],
};

/** С детьми — сначала то, что интересно детям. */
const KIDS_FIRST = new Set(["kids", "museums", "entertainment", "nature", "sights", "active", "cafes"]);

const L = "\\p{L}";
const word = (src: string) => new RegExp(`(^|[^${L}])(${src})([^${L}]|$)`, "iu");
/** Водоспад за назвою Google; «Вдсп», «вдсп.» — скорочення на мітках карти (як NATURE_NAME у mapping.ts). */
const WATERFALL_RE = /водоспад|waterfall|(^|[^\p{L}])вдсп(?!\p{L})/iu;
/**
 * Бар за назвою для категорії «Кафе»: паб, пивна, винний чи коктейль-бар, кальянна, лаунж. Імпорт (mapping.ts) кладе
 * Google bar/pub/wine_bar/cocktail_bar/hookah_bar і кафе з «кальян/lounge/паб» у назві в «Бари» (bars); тут — решта
 * кафе з барною назвою («Пивний бар» з типом cafe).
 */
const BAR_RE = word(
  "бар|bar|паб|pub|пивн\\p{L}*|beer|винн\\p{L}*|wine|cocktail|коктейль\\p{L}*|lounge|лаунж|кальян\\p{L}*|hookah|shisha",
);
/** «Кава-бар», «суші-бар», «фреш-бар», «десерт-бар» — кафе, а не бар (не «тільки дорослим» і не лише ввечері). */
const FOOD_BAR_RE =
  /(кав\p{L}*|coffee|кофе|espresso|еспресо|суші|суши|sushi|фреш\p{L}*|fresh|смузі|smoothie|салат\p{L}*|salad|десерт\p{L}*|dessert|морозив\p{L}*|молочн\p{L}*|milk|сніданк\p{L}*|breakfast|веган\p{L}*|vegan|чай\p{L}*|tea)[\s-]*(бар|bar)(?!\p{L})/iu;
/** Ночная жизнь — не для детей в любой категории. */
const NIGHTLIFE_RE = /нічн\p{L}*\s+клуб|night\s*club|кальян|hookah|стрип|strip/iu;
/** ТРЦ/ТЦ — под крышей; прочие магазины в «якщо дощ» не предлагаем. */
const MALL_RE = word("трц|тц|mall|торгов\\p{L}*\\s+центр");

export function placeKind(p: Pick<CatalogPlace, "category" | "names">): PlaceKind {
  if ((p.category === "nature" || p.category === "sights") && p.names.some((n) => WATERFALL_RE.test(n)))
    return "waterfall";
  // «Бари» (bars) — бар по категории импорта; кафе — по названию.
  if (p.category === "bars") return "bar";
  if (p.category === "cafes" && p.names.some((n) => BAR_RE.test(n) && !FOOD_BAR_RE.test(n))) return "bar";
  return p.category;
}

/** Не для детей: бары (категория «Бари» и кафе-бары), ночная жизнь и «Для дорослих» (категория и название). */
export function adultsOnly(p: Pick<CatalogPlace, "category" | "extraCategories" | "names">): boolean {
  return (
    categoriesOf(p).includes("adult-fun") ||
    placeKind(p) === "bar" ||
    p.names.some((n) => NIGHTLIFE_RE.test(n))
  );
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
    case "bars":
      return "evening_out";
    case "restaurants":
    case "kolyby":
      return slot === "evening" ? "dinner" : "lunch";
    case "nature":
    case "peaks":
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

/** Основная и доп. категории места. */
export function categoriesOf(p: Pick<CatalogPlace, "category" | "extraCategories">): string[] {
  return [p.category, ...(p.extraCategories ?? [])];
}

/** Категория, по которой место подходит части дня (основная в приоритете); иначе — основная. */
function slotCategory(p: CatalogPlace, slot: PlanSlot): string {
  return categoriesOf(p).find((c) => SLOT_CATEGORIES[slot].includes(c)) ?? p.category;
}

function fitsSlot(p: CatalogPlace, slot: PlanSlot): boolean {
  // Бар («Бари» или кафе-бар) — только вечером: не сніданок, не обід и не «якщо дощ».
  if (placeKind(p) === "bar") return slot === "evening";
  const cats = categoriesOf(p);
  if (slot !== "rain") return cats.some((c) => SLOT_CATEGORIES[slot].includes(c));
  if (p.tags.includes("rainy-day")) return true;
  // Магазин (основная stores) — только ТРЦ, доп. категории его «под крышу» не переводят.
  if (p.category === "stores") return p.names.some((n) => MALL_RE.test(n));
  if (cats.some((c) => c !== "stores" && SLOT_CATEGORIES.rain.includes(c))) return true;
  return cats.includes("stores") && p.names.some((n) => MALL_RE.test(n));
}

/** Место с признаками, посчитанными один раз (вид, «не для детей»). */
type Prepared = CatalogPlace & { kind: PlaceKind; adultsOnly: boolean; mountain: boolean };
const prepare = (p: CatalogPlace | Prepared): Prepared =>
  "kind" in p ? p : { ...p, kind: placeKind(p), adultsOnly: adultsOnly(p), mountain: isMountainHike(p) };

type Scored = { p: Prepared; d: number | null };

/**
 * Варианты одной части дня: подходящие категории, без уже выбранных мест; разнообразие — по кругу по категориям
 * (в каждой — сначала с тегом «З дітьми», если есть дети, затем рекомендованные, затем ближайшие). Без машины —
 * сначала пешая доступность, при нехватке — ближайшие дальше с travel = transport; без точки отсчёта travel = null.
 */
export function slotOptions(
  slot: PlanSlot,
  from: LonLat | null,
  places: readonly (CatalogPlace | Prepared)[],
  trip: TripParams,
  exclude: ReadonlySet<string>,
  /** Погода опасна для гор (гроза, ветер, снегопад, гололёд): горные походы не предлагаются. */
  noMountains = false,
): PlanOption[] {
  const kids = trip.children > 0;
  const pool: Scored[] = [];
  for (const raw of places) {
    if (exclude.has(raw.id) || !fitsSlot(raw, slot)) continue;
    const p = prepare(raw);
    if (kids && p.adultsOnly) continue;
    if (noMountains && p.mountain) continue;
    const d = from ? sphericalMeters(from, p.location) : null;
    if (d === null || d <= CAR_MAX_M) pool.push({ p, d });
  }
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
      const c0 = slotCategory(s.p, slot);
      const cat = order.includes(c0) ? c0 : "_other";
      const list = byCat.get(cat);
      if (list) list.push(s);
      else byCat.set(cat, [s]);
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

  const chosen: { s: Scored; travel: Travel | null }[] = [];
  if (from === null) {
    // Не от чего считать: ни «пішки», ни «потрібен транспорт» не утверждаем.
    for (const s of pick(pool, OPTIONS_PER_SLOT)) chosen.push({ s, travel: null });
  } else if (trip.withCar) {
    for (const s of pick(pool, OPTIONS_PER_SLOT))
      chosen.push({ s, travel: s.d! <= WALK_MAX_M ? "walk" : "car" });
  } else {
    const walk = pick(
      pool.filter((s) => s.d! <= WALK_MAX_M),
      OPTIONS_PER_SLOT,
    );
    for (const s of walk) chosen.push({ s, travel: "walk" });
    if (walk.length < MIN_OPTIONS) {
      const far = pool.filter((s) => s.d! > WALK_MAX_M).sort((a, b) => a.d! - b.d!);
      for (const s of far.slice(0, MIN_OPTIONS - walk.length)) chosen.push({ s, travel: "transport" });
    }
  }
  return chosen.map(({ s, travel }) => ({
    placeId: s.p.id,
    kind: s.p.kind,
    reason: reasonOf(slot, slotCategory(s.p, slot)),
    distanceMeters: s.d,
    travel,
    travelMinutes:
      s.d === null || travel === null ? null : travelMinutes(s.d, travel === "walk" ? "walk" : "car"),
    kidsFriendly: s.p.tags.includes("kids"),
  }));
}

/**
 * Варианты по всем дням плана. Точка отсчёта части дня — последний выбранный пункт раньше в этот день, иначе базовая
 * точка плана; места — только уместные в сезон поездки. Одно место не предлагается дважды в разные части дня/дни (кроме «якщо дощ» — запасной набор на
 * каждый день), выбранные места плана — не предлагаются.
 */
export function planOptions(input: {
  days: number;
  items: readonly ChosenItem[];
  places: readonly CatalogPlace[];
  trip: TripParams;
  base: LonLat | null;
  /** Сезон поездки: места не по сезону (зимой — вершины и «Літо») не предлагаются; не задан — без фильтра. */
  season?: ScenarioSeason;
  /** Дни, когда погода опасна для гор (прогноз): горные походы в эти дни не предлагаются. */
  noMountainDays?: ReadonlySet<number>;
}): DayOptions[] {
  const season = input.season;
  const places = (season ? input.places.filter((p) => placeFitsSeason(p, season)) : input.places).map(
    prepare,
  );
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
      const options = slotOptions(
        slot,
        from,
        places,
        input.trip,
        slot === "rain" ? inPlan : offered,
        input.noMountainDays?.has(dayNo) ?? false,
      );
      if (slot !== "rain") for (const o of options) offered.add(o.placeId);
      slots.push({ slot, options });
    }
    out.push({ dayNo, slots });
  }
  return out;
}

/** Пункт для части дня: выбранная часть (slot) или время. */
export type SlotSource = {
  id: string;
  dayNo: number;
  position: number;
  timeHint: string | null;
  slot?: PlanSlot | undefined;
};

/**
 * Части дня всех пунктов без перестановки пунктов сценария: явный slot — как есть; иначе по времени, а без времени —
 * от предыдущего по позиции (первый без времени — от ближайшего следующего со временем, иначе «день»). Часть дня
 * пунктов без явного slot не убывает по позиции — сортировка по части дня не меняет порядок сценария.
 */
export function itemSlots(items: readonly SlotSource[]): Map<string, PlanSlot> {
  const out = new Map<string, PlanSlot>();
  const days = new Map<number, SlotSource[]>();
  for (const i of items) {
    if (i.slot) out.set(i.id, i.slot);
    else days.set(i.dayNo, [...(days.get(i.dayNo) ?? []), i]);
  }
  for (const list of days.values()) {
    list.sort((a, b) => a.position - b.position);
    let cur: PlanSlot | null = null;
    list.forEach((i, k) => {
      const own = i.timeHint ? slotOf({ timeHint: i.timeHint }) : null;
      let slot: PlanSlot =
        own ??
        cur ??
        (list.slice(k + 1).find((n) => n.timeHint)
          ? slotOf({ timeHint: list.slice(k + 1).find((n) => n.timeHint)!.timeHint })
          : "afternoon");
      if (cur && slotRank(cur) > slotRank(slot)) slot = cur;
      cur = slot;
      out.set(i.id, slot);
    });
  }
  return out;
}
