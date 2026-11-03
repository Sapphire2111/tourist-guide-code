// План отдыха ассистента («склади план на 2 дні з дітьми», «що робити сьогодні ввечері»): по дням и частям дня
// (ранок, день, вечір) из РЕАЛЬНЫХ мест каталога — пам'ятки й природа, активності, обід і вечеря рядом с предыдущей
// точкой, вечером — чан или SPA. Учитывает график работы (место должно быть открыто в это время; график неизвестен —
// допускается с меньшим весом), расстояния (ближайшее хорошее, а не лучшее через всю область), «з дітьми» (без
// «Для дорослих», детские — выше), цены для еды и сезон (лыжи — только зимой). Чистая логика без Nest и БД.
import type { LonLat } from "../../db/index.js";
import { openState, type ScheduleRows } from "../guide/index.js";
import type { DayPart } from "./intent.js";
import { haversineMeters } from "./route.js";

export type PlanRole = "see" | "fun" | "eat" | "relax";
export const PLAN_ROLES: readonly PlanRole[] = ["see", "fun", "eat", "relax"];
export type PlanTravel = "walk" | "car";
export const PLAN_TRAVELS: readonly PlanTravel[] = ["walk", "car"];

/** Категории каталога по роли в плане (коды подкатегорий). */
const SEE = ["sights", "nature", "museums"] as const;
// «Екскурсії» — турфирмы (записаться заранее), не пункт плана на час; в план не берём.
const FUN = ["active", "entertainment", "kids", "adult-fun", "ski-resorts"] as const;
const LUNCH = ["restaurants", "kolyby", "cafes"] as const;
const DINNER = ["restaurants", "kolyby"] as const;
const RELAX = ["chany", "spa"] as const;

/** Разделы каталога, из которых собирается план (коды корневых категорий). */
export const PLAN_SECTIONS = ["nearby", "fun", "eat", "relax", "ski"] as const;

export const ROLE_OF: Readonly<Record<string, PlanRole>> = {
  ...Object.fromEntries(SEE.map((c) => [c, "see"])),
  ...Object.fromEntries(FUN.map((c) => [c, "fun"])),
  ...Object.fromEntries(LUNCH.map((c) => [c, "eat"])),
  ...Object.fromEntries(RELAX.map((c) => [c, "relax"])),
};

/** Сколько времени на месте, мин (оценка по типу места). */
export const DURATION_OF: Readonly<Record<string, number>> = {
  sights: 45,
  nature: 90,
  museums: 60,
  active: 120,
  entertainment: 90,
  kids: 90,
  "adult-fun": 90,
  "ski-resorts": 180,
  restaurants: 75,
  kolyby: 75,
  cafes: 45,
  chany: 120,
  spa: 120,
};

/** Окна частей дня, минуты от полуночи. */
export const PART_WINDOWS: Readonly<Record<DayPart, { from: number; to: number }>> = {
  morning: { from: 9 * 60 + 30, to: 13 * 60 },
  afternoon: { from: 13 * 60, to: 18 * 60 },
  evening: { from: 18 * 60, to: 22 * 60 + 30 },
};
/** Только вечер («що робити ввечері») — начинаем раньше и успеваем прогулку или розвагу до вечері. */
const EVENING_ONLY = { from: 17 * 60, to: 23 * 60 };

type Slot = readonly string[];
/** Порядок пунктов части дня: какие категории подходят на каждый пункт. */
const TEMPLATES: Readonly<Record<DayPart, readonly Slot[]>> = {
  morning: [SEE, [...SEE, ...FUN], SEE],
  afternoon: [LUNCH, [...SEE, ...FUN], [...SEE, ...FUN], SEE],
  evening: [DINNER, RELAX],
};
const EVENING_ONLY_TEMPLATE: readonly Slot[] = [[...FUN, ...SEE], DINNER, RELAX];

/** Пешком — не дальше, м (по прямой); дальше — на авто. Между пунктами дальше MAX_HOP_M не переезжаем. */
export const WALK_MAX_M = 1200;
export const MAX_HOP_M = 30_000;
/** Опоздание за конец части дня, мин, — допустимо (вечеря может затянуться). */
const OVERRUN_MIN = 30;

export type PlanCandidate = {
  id: string;
  /** Код подкатегории (основной категории места). */
  category: string;
  location: LonLat;
  rating: number | null;
  ratingCount: number | null;
  recommended: boolean;
  kidsFriendly: boolean;
  priceLevel: number | null;
  /** График; null — неизвестен. */
  schedule: ScheduleRows | null;
  /** Турист просил именно это (категория запроса, ключевое слово). */
  wanted: boolean;
};

export type PlanDayInput = {
  dayNo: number;
  /** YYYY-MM-DD местной даты. */
  date: string;
  /** ISO: 1 — понедельник … 7 — воскресенье. */
  dayOfWeek: number;
  /** С какой минуты можно начинать (сегодня — с текущего времени), минуты от полуночи. */
  fromMinute: number;
};

export type PlanOptions = {
  days: readonly PlanDayInput[];
  /** Части дня; пусто — все. */
  parts: readonly DayPart[];
  /** Где живёт турист: каждый день начинается отсюда; нет — от лучшей пам'ятки дня. */
  origin?: LonLat;
  withKids: boolean;
  /** Месяц 1–12 (сезон: лыжи — декабрь–март). */
  month: number;
  priceMin: number | null;
  priceMax: number | null;
};

export type PlanStop = {
  placeId: string;
  role: PlanRole;
  /** Начало, минуты от полуночи. */
  startMinute: number;
  durationMin: number;
  /** Переезд от предыдущей точки дня (или от жилья туриста); первая точка без точки отсчёта — null. */
  travelMeters: number | null;
  travelMinutes: number | null;
  travel: PlanTravel | null;
  /** Часы работы в этот день («10:00–18:00»); неизвестно — null. */
  hours: string | null;
};

export type PlanPart = { part: DayPart; stops: PlanStop[] };
export type PlanDay = { dayNo: number; date: string; parts: PlanPart[] };
export type BuiltPlan = { days: PlanDay[]; lengthMeters: number };

const isWinter = (month: number) => month === 12 || month <= 3;

/** Переезд: пешком до WALK_MAX_M (≈ 80 м/мин с поправкой на дорогу), дальше — на авто (≈ 33 км/ч + парковка). */
export function travelOf(meters: number): { travel: PlanTravel; minutes: number } {
  if (meters <= WALK_MAX_M) return { travel: "walk", minutes: Math.max(2, Math.round((meters * 1.3) / 80)) };
  return { travel: "car", minutes: Math.round((meters * 1.35) / 550 / 5) * 5 + 5 };
}

const hhmm = (minutes: number) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
export const formatMinute = hhmm;

const prevDate = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Открыто ли место весь визит (на входе и в последнюю минуту — уйти до закрытия): true/false; график неизвестен —
 * null. Через полночь — по правилам openState.
 */
export function openDuring(
  s: ScheduleRows | null,
  day: Pick<PlanDayInput, "date" | "dayOfWeek">,
  from: number,
  to: number,
): boolean | null {
  if (!s) return null;
  const at = (minutes: number) =>
    openState(s, {
      date: day.date,
      previousDate: prevDate(day.date),
      dayOfWeek: day.dayOfWeek,
      minutes: Math.min(1439, Math.max(0, Math.round(minutes))),
    }).openNow;
  const start = at(from);
  if (start === null) return null;
  return start && at(Math.max(from, to - 1)) === true;
}

/** Часы работы на дату: исключение даты или недельный график («09:00–18:00, 19:00–23:00»); нет — null. */
export function hoursOn(
  s: ScheduleRows | null,
  day: Pick<PlanDayInput, "date" | "dayOfWeek">,
): string | null {
  if (!s) return null;
  const ex = s.exceptions.filter((e) => e.date === day.date);
  const rows: { opensAt: string | null; closesAt: string | null }[] = ex.length
    ? ex.some((e) => e.closed)
      ? []
      : ex
    : s.weekly.filter((w) => w.dayOfWeek === day.dayOfWeek);
  const parts = rows.flatMap((r) =>
    r.opensAt && r.closesAt ? [`${r.opensAt.slice(0, 5)}–${r.closesAt.slice(0, 5)}`] : [],
  );
  return parts.length ? parts.join(", ") : null;
}

/** Качество места без учёта расстояния: рейтинг Google, число отзывов, рекомендация, просьба туриста, дети, цена. */
export function quality(
  c: PlanCandidate,
  o: Pick<PlanOptions, "withKids" | "priceMin" | "priceMax">,
): number {
  let q = (c.rating ?? 4) + 0.4 * Math.log10(1 + (c.ratingCount ?? 0));
  if (c.recommended) q += 0.5;
  if (c.wanted) q += 2;
  if (o.withKids && c.kidsFriendly) q += 0.8;
  if (o.withKids && c.category === "kids") q += 1;
  if (ROLE_OF[c.category] === "eat" && c.priceLevel !== null) {
    if (o.priceMax !== null && c.priceLevel > o.priceMax) q -= 2;
    if (o.priceMin !== null && c.priceLevel < o.priceMin) q -= 1;
  }
  return q;
}

/** Штраф за расстояние: 10 км по прямой «стоят» ≈ 3.5 балла качества — ближнее хорошее лучше дальнего отличного. */
const distancePenalty = (meters: number) => (meters / 1000) * 0.35;

/**
 * План по дням: на каждый пункт части дня — лучшее по качеству минус расстояние от предыдущей точки место нужной
 * категории, которое открыто в это время и ещё не стоит в плане. Пункт, для которого места нет, пропускается.
 */
export function buildPlan(candidates: readonly PlanCandidate[], o: PlanOptions): BuiltPlan {
  const winter = isWinter(o.month);
  const pool = candidates.filter(
    (c) =>
      ROLE_OF[c.category] !== undefined &&
      !(o.withKids && c.category === "adult-fun") &&
      (winter || c.category !== "ski-resorts"),
  );
  const used = new Set<string>();
  const score = new Map(pool.map((c) => [c.id, quality(c, o)]));
  const parts = o.parts.length ? o.parts : (["morning", "afternoon", "evening"] as const);
  const eveningOnly = parts.length === 1 && parts[0] === "evening";
  let lengthMeters = 0;
  const days: PlanDay[] = [];

  for (const day of o.days) {
    let at: LonLat | undefined = o.origin;
    let t = 0;
    const dayCats: string[] = [];
    const planParts: PlanPart[] = [];
    for (const part of parts) {
      const window = eveningOnly ? EVENING_ONLY : PART_WINDOWS[part];
      // Сегодня часть дня, которая уже почти прошла, не планируем.
      if (window.to - 60 <= day.fromMinute) continue;
      t = Math.max(t, window.from, day.fromMinute);
      const stops: PlanStop[] = [];
      for (const slot of eveningOnly ? EVENING_ONLY_TEMPLATE : TEMPLATES[part]) {
        if (t >= window.to) break;
        let best: { c: PlanCandidate; s: number; d: number | null } | undefined;
        for (const c of pool) {
          if (used.has(c.id) || !slot.includes(c.category)) continue;
          // Дальше предела не переезжаем, и от жилья тоже: жильё далеко от пункта плана — сервис не передаёт origin.
          const d = at ? haversineMeters(at, c.location) : null;
          if (d !== null && d > MAX_HOP_M) continue;
          const arrive = t + (d === null ? 0 : travelOf(d).minutes);
          const duration = DURATION_OF[c.category] ?? 60;
          if (arrive + duration > window.to + OVERRUN_MIN) continue;
          const open = openDuring(c.schedule, day, arrive, arrive + duration);
          if (open === false) continue;
          let s = score.get(c.id)! - (d === null ? 0 : distancePenalty(d));
          if (open === null) s -= 0.5;
          // Разнообразие дня: та же категория второй раз — ниже (два музея подряд — скучно).
          if (dayCats.includes(c.category) && ROLE_OF[c.category] !== "eat") s -= 0.8;
          if (!best || s > best.s) best = { c, s, d };
        }
        if (!best) continue;
        const { c, d } = best;
        const move = d === null ? null : travelOf(d);
        const start = t + (move?.minutes ?? 0);
        const duration = DURATION_OF[c.category] ?? 60;
        used.add(c.id);
        dayCats.push(c.category);
        if (d !== null) lengthMeters += d;
        stops.push({
          placeId: c.id,
          role: ROLE_OF[c.category]!,
          startMinute: start,
          durationMin: duration,
          travelMeters: d === null ? null : Math.round(d),
          travelMinutes: move?.minutes ?? null,
          travel: move?.travel ?? null,
          hours: hoursOn(c.schedule, day),
        });
        // Начало — на ближайшие 5 минут (план, а не расписание поезда).
        t = Math.ceil((start + duration) / 5) * 5;
        at = c.location;
      }
      if (stops.length) planParts.push({ part, stops });
    }
    days.push({ dayNo: day.dayNo, date: day.date, parts: planParts });
  }
  return { days, lengthMeters: Math.round(lengthMeters) };
}

/** Первая минута плана сегодня: через 15 минут от «сейчас», на ближайшие четверть часа. */
export function startMinuteFrom(nowMinutes: number): number {
  return Math.ceil((nowMinutes + 15) / 15) * 15;
}

/** Есть ли сегодня ещё время хоть на одну из частей дня. */
export function hasTimeToday(parts: readonly DayPart[], fromMinute: number): boolean {
  const list = parts.length ? parts : (["morning", "afternoon", "evening"] as const);
  const eveningOnly = list.length === 1 && list[0] === "evening";
  return list.some((p) => (eveningOnly ? EVENING_ONLY : PART_WINDOWS[p]).to - 60 > fromMinute);
}
