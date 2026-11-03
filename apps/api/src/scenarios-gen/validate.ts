// Проверка сценария от модели программой — без неё в БД ничего не пишется. Каждый пункт — место из списка кандидатов
// (опубликованное место каталога); длительность — реалистичная (маршрут на вершину — фиксированно, иначе в пределах
// оценки по месту); время сдвигается вперёд на дорогу между пунктами; день — не дольше разумного, место открыто в
// это время, сезон и аудитория (діти, без авто, дощ) соблюдены, дублей нет.
import type { LocalizedText, ScenarioSeason } from "../db/index.js";
import {
  placeFitsSeason,
  SCENARIO_SEASONS,
  SCENARIO_TAGS,
  sphericalMeters,
  travelMinutes,
  type ScenarioTag,
} from "../modules/planner/index.js";
import type { Brief } from "./briefs.js";
import { INDOOR_CATEGORIES, MEAL_CATEGORIES, seasonsOf, type CandidateSet } from "./candidates.js";
import type { GenPlace } from "./catalog.js";
import type { GenScenario } from "./prompt.js";

export const DAY_START = "07:00";
export const DAY_END = "23:00";
/** Сумма времени на местах за день, хв (13 год: день экскурсии на вершину с вечерей и чаном — 07:00–21:00). */
export const DAY_ACTIVE_MAX_MIN = 13 * 60;
/** «Большой» пункт (поход, экскурсия, лыжи) — от 4 год; такой один на день. */
export const BIG_MIN = 240;
/** Большой поход начинается не позже, хв от полуночи (10:00). */
export const BIG_START_MAX = 10 * 60;
/** Без авто — между соседними пунктами не дальше, м по прямой. */
export const FOOT_HOP_MAX_M = 2_500;
/** На авто — не дальше, м по прямой. */
export const CAR_HOP_MAX_M = 35_000;
/** Место открыто в это время — хотя бы в столько дней недели (график известен). */
export const OPEN_DAYS_MIN = 4;
export const ITEMS_PER_DAY = { min: 2, max: 8 } as const;
export const ALTERNATIVES_MAX = 3;

export type DraftItem = {
  dayNo: number;
  placeId: string;
  /** Для отчёта и проверки глазами (в БД не пишется). */
  placeName: string;
  category: string;
  timeHint: string;
  durationMin: number;
  note: LocalizedText | null;
  alternatives: string[];
};

export type ScenarioDraft = {
  code: string;
  title: LocalizedText;
  description: LocalizedText | null;
  days: number;
  tags: ScenarioTag[];
  seasons: ScenarioSeason[];
  items: DraftItem[];
  /** По дням: активное время, начало и конец (для отчёта). */
  dayStats: { dayNo: number; activeMin: number; start: string; end: string }[];
};

export type ValidationResult = { draft: ScenarioDraft | null; errors: string[]; fixes: string[] };

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export const toMin = (t: string): number | null => {
  const m = HHMM.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export const fromMin = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const round5 = (m: number) => Math.round(m / 5) * 5;
const ceil5 = (m: number) => Math.ceil(m / 5) * 5;

/** Реалистичная длительность: маршрут — фиксированно; иначе ответ модели в пределах ×0,5…×2 оценки места. */
export function realisticMinutes(p: GenPlace, asked: number): number {
  const est = p.estimate.minutes;
  if (p.estimate.fixed) return est;
  const lo = Math.max(15, round5(est * 0.5));
  const hi = round5(est * 2);
  return Math.min(hi, Math.max(lo, round5(Number.isFinite(asked) ? asked : est)));
}

/** Дорога между пунктами, хв: пешком при близости или без авто, иначе на авто (+5 хв на парковку). */
export function hopMinutes(
  from: GenPlace,
  to: GenPlace,
  noCar: boolean,
): { meters: number; minutes: number } {
  const meters = sphericalMeters(from.location, to.location);
  if (noCar || meters <= 1200) return { meters, minutes: meters < 50 ? 0 : travelMinutes(meters, "walk") };
  return { meters, minutes: travelMinutes(meters, "car") + 5 };
}

/** Открыто ли место в [from, to) (минуты дня) хотя бы в OPEN_DAYS_MIN дней недели; график неизвестен — да. */
export function openEnough(p: GenPlace, from: number, to: number): boolean {
  if (!p.weekly.length) return true;
  let days = 0;
  for (let d = 1; d <= 7; d++) {
    const ok = p.weekly.some((w) => {
      if (w.dayOfWeek !== d) return false;
      const o = toMin(w.opensAt) ?? 0;
      let c = toMin(w.closesAt) ?? 0;
      if (c <= o) c += 24 * 60; // через полночь (или круглосуточно 00:00–00:00)
      return from >= o && to <= c;
    });
    if (ok) days++;
  }
  return days >= OPEN_DAYS_MIN;
}

/** Теги, которые модель может добавить сама. */
export const MODEL_TAGS = SCENARIO_TAGS.filter(
  (t) => !["one_day", "multi_day", "kids", "no_car", "rain", "ski", "excursion"].includes(t),
);

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max).trim();
const BAD_TEXT = /https?:|www\.|[<>`*#]|\+?\d[\d\s-]{8,}/i;

export function validateScenario(b: Brief, set: CandidateSet, gen: GenScenario): ValidationResult {
  const errors: string[] = [];
  const fixes: string[] = [];
  const seasons = seasonsOf(b);
  const days = [...gen.days].sort((x, y) => x.day - y.day);
  if (days.length !== b.days || days.some((d, i) => d.day !== i + 1))
    errors.push(`днів має бути рівно ${b.days} (1…${b.days}), отримано: ${days.map((d) => d.day).join(",")}`);
  const used = new Set<string>();
  const items: DraftItem[] = [];
  const dayStats: ScenarioDraft["dayStats"] = [];
  let anyAdultsOnly = false;
  const placesById = new Map([...set.byRef.values()].map((p) => [p.id, p]));

  for (const d of days) {
    const list = d.items;
    if (list.length < ITEMS_PER_DAY.min || list.length > ITEMS_PER_DAY.max)
      errors.push(
        `день ${d.day}: пунктів має бути ${ITEMS_PER_DAY.min}–${ITEMS_PER_DAY.max}, а не ${list.length}`,
      );
    let prev = null as { place: GenPlace; end: number } | null;
    let active = 0;
    let big = 0;
    let meal = false;
    let start: number | null = null;
    let end = 0;
    for (const it of list) {
      const place = set.byRef.get(it.ref.trim());
      if (!place) {
        errors.push(`день ${d.day}: «${it.ref}» — немає в списку кандидатів`);
        continue;
      }
      if (used.has(place.id)) errors.push(`${it.ref} (${place.name}) повторюється`);
      used.add(place.id);
      const minutes = realisticMinutes(place, it.minutes);
      if (Math.abs(minutes - it.minutes) >= 15)
        fixes.push(`${it.ref} ${place.name}: тривалість ${it.minutes} → ${minutes} хв`);
      const asked = toMin(it.time);
      if (asked === null) errors.push(`${it.ref}: час «${it.time}» не ГГ:ХХ`);
      let at: number = asked ?? prev?.end ?? toMin(DAY_START)!;
      if (prev) {
        const hop = hopMinutes(prev.place, place, Boolean(b.theme.noCar));
        if (b.theme.noCar && hop.meters > FOOT_HOP_MAX_M)
          errors.push(
            `${it.ref}: без авто — ${(hop.meters / 1000).toFixed(1)} км від попереднього (макс. 2,5 км)`,
          );
        if (!b.theme.noCar && hop.meters > CAR_HOP_MAX_M)
          errors.push(
            `${it.ref}: ${(hop.meters / 1000).toFixed(0)} км від попереднього — задалеко для одного дня`,
          );
        const earliest = ceil5(prev.end + hop.minutes);
        if (at < earliest) {
          fixes.push(
            `${it.ref} ${place.name}: старт ${fromMin(at)} → ${fromMin(earliest)} (дорога ${hop.minutes} хв)`,
          );
          at = earliest;
        }
      }
      if (at < toMin(DAY_START)!) errors.push(`${it.ref}: старт ${fromMin(at)} — раніше ${DAY_START}`);
      const finish: number = at + minutes;
      if (finish > toMin(DAY_END)!)
        errors.push(`день ${d.day}: ${place.name} закінчується о ${fromMin(finish)} — пізніше ${DAY_END}`);
      if (!openEnough(place, at, finish))
        errors.push(
          `${it.ref} (${place.name}): за графіком зачинено ${fromMin(at)}–${fromMin(Math.min(finish, 1439))}`,
        );
      for (const s of seasons)
        if (!placeFitsSeason(place, s)) errors.push(`${it.ref} (${place.name}) не підходить для сезону ${s}`);
      const isBig = minutes >= BIG_MIN && ["hike", "tour", "ski"].includes(place.estimate.kind);
      if (isBig) {
        big++;
        if (place.estimate.kind === "hike" && at > BIG_START_MAX)
          errors.push(
            `${it.ref} (${place.name}): похід ${minutes} хв має починатися до 10:00, а не о ${fromMin(at)}`,
          );
      }
      if ((MEAL_CATEGORIES as readonly string[]).includes(place.category)) meal = true;
      if (
        b.theme.rain &&
        !(INDOOR_CATEGORIES as readonly string[]).includes(place.category) &&
        !place.tags.includes("rainy-day")
      )
        errors.push(`${it.ref} (${place.name}): у дощ — лише під дахом`);
      anyAdultsOnly ||= place.adultsOnly;
      if (b.theme.kids && place.adultsOnly) errors.push(`${it.ref} (${place.name}): не для дітей`);
      active += minutes;
      start ??= at;
      end = finish;
      const alternatives: string[] = [];
      for (const a of it.alternatives ?? []) {
        const alt = set.byRef.get(a.trim());
        if (!alt || alt.id === place.id || alternatives.includes(alt.id)) {
          fixes.push(`${it.ref}: альтернатива «${a}» прибрана`);
          continue;
        }
        if (alternatives.length < ALTERNATIVES_MAX) alternatives.push(alt.id);
      }
      const note = clean(it.note_uk ?? "", 200);
      if (note && BAD_TEXT.test(note)) errors.push(`${it.ref}: у примітці посилання, телефон або розмітка`);
      items.push({
        dayNo: d.day,
        placeId: place.id,
        placeName: place.name,
        category: place.category,
        timeHint: fromMin(at),
        durationMin: minutes,
        note: note ? { uk: note } : null,
        alternatives,
      });
      prev = { place, end: finish };
    }
    if (active > DAY_ACTIVE_MAX_MIN)
      errors.push(
        `день ${d.day}: ${Math.round(active / 6) / 10} год на місцях — більше ${DAY_ACTIVE_MAX_MIN / 60} год`,
      );
    if (big > 1)
      errors.push(`день ${d.day}: ${big} великі пункти (похід/екскурсія/лижі) — має бути не більше одного`);
    if (list.length >= 3 && !meal) errors.push(`день ${d.day}: немає де поїсти`);
    dayStats.push({ dayNo: d.day, activeMin: active, start: fromMin(start ?? 0), end: fromMin(end) });
  }

  const title = clean(gen.title_uk, 80);
  const description = clean(gen.description_uk, 400);
  if (title.length < 3) errors.push("назва порожня");
  if (BAD_TEXT.test(title) || BAD_TEXT.test(description))
    errors.push("у назві чи описі посилання або розмітка");
  // Аудитория и формат (діти, без авто, дощ, лижі, дні) — только из заказа; модель добавляет лишь описательные теги.
  const tags = new Set<ScenarioTag>(b.theme.tags);
  for (const t of gen.tags) if ((MODEL_TAGS as readonly string[]).includes(t)) tags.add(t as ScenarioTag);
  tags.delete(b.days === 1 ? "multi_day" : "one_day");
  tags.add(b.days === 1 ? "one_day" : "multi_day");
  if (!b.theme.noCar) tags.delete("no_car");
  if (!b.theme.rain) tags.delete("rain");
  if (b.seasons.length !== 1 || b.seasons[0] !== "winter") tags.delete("ski");
  if (anyAdultsOnly) tags.delete("kids");

  // То же место под разными карточками Google: тот же маршрут или та же точка (до 150 м) той же категории.
  const seen = new Map<string, string>();
  for (const it of items) {
    const p = placesById.get(it.placeId)!;
    const lm = p.estimate.landmark?.code;
    if (lm) {
      if (seen.has(lm)) errors.push(`${p.name}: той самий маршрут, що й ${seen.get(lm)}`);
      seen.set(lm, p.name);
    }
  }
  const nonMeal = items.filter((i) => !(MEAL_CATEGORIES as readonly string[]).includes(i.category));
  for (let i = 0; i < nonMeal.length; i++)
    for (let j = i + 1; j < nonMeal.length; j++) {
      const a = placesById.get(nonMeal[i]!.placeId)!;
      const c = placesById.get(nonMeal[j]!.placeId)!;
      if (a.category === c.category && sphericalMeters(a.location, c.location) < 150)
        errors.push(`${a.name} і ${c.name} — те саме місце (до 150 м), залиш одне`);
    }

  if (errors.length) return { draft: null, errors, fixes };
  return {
    draft: {
      code: b.code,
      title: { uk: title, ...(gen.title_en.trim() ? { en: clean(gen.title_en, 80) } : {}) },
      description: description ? { uk: description } : null,
      days: b.days,
      tags: SCENARIO_TAGS.filter((t) => tags.has(t)),
      seasons: [...b.seasons],
      items,
      dayStats,
    },
    errors,
    fixes,
  };
}

const CODE_RE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Проверка готового сценария (--from-file: файл могли поправить руками): форма как у API (код, теги и сезоны из
 * справочников, дни 1…5 и номер дня каждого пункта, время, длительность 5–1440), места — опубликованные места каталога,
 * длительность — реалистичная для места, место подходит сезонам. Пустой список — можно писать.
 */
export function checkDraft(d: ScenarioDraft, places: ReadonlyMap<string, GenPlace>): string[] {
  const e: string[] = [];
  if (typeof d.code !== "string" || !CODE_RE.test(d.code)) e.push(`код «${String(d.code)}» не латиницею`);
  if (typeof d.title?.uk !== "string" || clean(d.title.uk, 80).length < 3) e.push("немає назви uk");
  if (!Number.isInteger(d.days) || d.days < 1 || d.days > 5) e.push(`днів ${String(d.days)} — має бути 1…5`);
  if (!Array.isArray(d.tags) || d.tags.some((t) => !(SCENARIO_TAGS as readonly string[]).includes(t)))
    e.push(`невідомі теги: ${String(d.tags)}`);
  const seasonsOk =
    Array.isArray(d.seasons) && d.seasons.every((s) => (SCENARIO_SEASONS as readonly string[]).includes(s));
  if (!seasonsOk) e.push(`невідомі сезони: ${String(d.seasons)}`);
  if (!Array.isArray(d.items) || d.items.length === 0 || d.items.length > 40)
    return [...e, "пунктів має бути 1…40"];
  const days = new Set<number>();
  for (const i of d.items) {
    const at = `день ${String(i.dayNo)}, ${i.placeName ?? String(i.placeId)}`;
    if (!Number.isInteger(i.dayNo) || i.dayNo < 1 || i.dayNo > d.days) e.push(`${at}: день поза 1…${d.days}`);
    days.add(i.dayNo);
    if (typeof i.placeId !== "string" || !UUID_RE.test(i.placeId)) {
      e.push(`${at}: placeId не uuid`);
      continue;
    }
    if (typeof i.timeHint !== "string" || toMin(i.timeHint) === null)
      e.push(`${at}: час «${String(i.timeHint)}» не ГГ:ХХ`);
    if (!Number.isInteger(i.durationMin) || i.durationMin < 5 || i.durationMin > 1440)
      e.push(`${at}: тривалість ${String(i.durationMin)} поза 5…1440`);
    if (
      !Array.isArray(i.alternatives) ||
      i.alternatives.length > ALTERNATIVES_MAX ||
      i.alternatives.some((a) => typeof a !== "string" || !UUID_RE.test(a))
    )
      e.push(`${at}: альтернативи — до ${ALTERNATIVES_MAX} uuid`);
    const p = places.get(i.placeId.toLowerCase());
    if (!p) {
      e.push(`${at}: місця немає серед опублікованих у каталозі`);
      continue;
    }
    if (realisticMinutes(p, i.durationMin) !== i.durationMin)
      e.push(`${at}: тривалість ${i.durationMin} хв нереальна (оцінка ${p.estimate.minutes} хв)`);
    if (seasonsOk)
      for (const s of d.seasons.length ? d.seasons : SCENARIO_SEASONS)
        if (!placeFitsSeason(p, s)) e.push(`${at}: не підходить для сезону ${s}`);
  }
  for (let n = 1; n <= d.days; n++) if (!days.has(n)) e.push(`день ${n} без пунктів`);
  return e;
}
