// Чистая логика бронирований (блок 7; states-and-rules §3, BR-04, BR-08; D-04, D-43, D-44, D-66, D-78, C-27):
// переходы статусов, вычисление слотов из правил доступности в таймзоне региона, сроки ответа, «Доступно зараз».
// Без Nest и БД.
import type { BookingStatus, ManualAvailability } from "../../db/index.js";
import { localMoment } from "../guide/index.js";
import { zonedInstant } from "../host/index.js";
import type { PermissionCode } from "../rbac/index.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Статусы, в которых бронь занимает интервал ресурса (states-and-rules §3.3; = WHERE ограничения bookings_no_overlap). */
export const OCCUPYING_STATUSES = [
  "new",
  "pending_partner",
  "alternative_proposed",
  "confirmed",
  "completed",
  "no_show",
] as const satisfies readonly BookingStatus[];

/** Активные (ещё не завершённые и не освобождённые) — для лимита и списков «очікує». */
export const ACTIVE_STATUSES = [
  "new",
  "pending_partner",
  "alternative_proposed",
  "confirmed",
] as const satisfies readonly BookingStatus[];

/** Ожидающие ответа — лимит одновременных броней без подтверждения на пользователя (BR-14, Предложение). */
export const UNCONFIRMED_STATUSES = [
  "new",
  "pending_partner",
  "alternative_proposed",
] as const satisfies readonly BookingStatus[];

/** Параметры тестового режима (значения — PO; принятые рекомендации отмечены у каждого). */
export const BOOKING_PARAMS = {
  /** D-44 А: порог no_show пользователя, после которого онлайн-бронь недоступна (только «зателефонувати»). */
  noShowLimit: 3,
  /** BR-14: не больше стольких броней без подтверждения на пользователя одновременно. */
  maxUnconfirmedPerUser: 3,
  /** D-43 А: нижняя граница SLA ответа партнёра, мин (бронь «на через час» требует быстрого ответа). */
  minPartnerSlaMin: 5,
  /** D-66: фиксированный таймаут ответа туриста на альтернативу, мин… */
  customerResponseMin: 120,
  /** …и не позже чем за столько минут до начала предложенного слота (берётся меньшее). */
  customerResponseBeforeStartMin: 60,
  /** D-44: no_show отмечается не раньше чем через столько минут после начала (grace). */
  noShowGraceMin: 15,
  /** states-and-rules §3.4: окно исправления no_show → completed партнёром, ч. */
  noShowCorrectionHours: 48,
  /** BR-04: горизонт «зараз» — свободный слот, начинающийся в ближайшие столько минут. */
  availableNowHorizonMin: 120,
  /** D-78 А: TTL ручного статуса «Доступно зараз» по умолчанию и пределы, мин. */
  manualTtlDefaultMin: 60,
  manualTtlMinMin: 15,
  manualTtlMaxMin: 240,
  /** Окно запроса слотов, дней. */
  slotsMaxDays: 14,
  /**
   * states-and-rules §3.4: турист отменяет confirmed не позже чем за столько часов до начала (параметр, значение не
   * задано в decisions — тестовый режим); неподтверждённую — до начала.
   */
  userCancelBeforeStartHours: 2,
  /** Ручная запись: длительность не больше, мин. */
  manualMaxDurationMin: 24 * 60,
  /** Имя клиента в онлайн-брони (необязательное): длиннее — обрезается до стольких символов (CHECK БД — 200). */
  customerNameMax: 200,
} as const;

/** Действия туриста-владельца брони. */
const USER_TRANSITIONS: Partial<Record<BookingStatus, readonly BookingStatus[]>> = {
  new: ["cancelled_by_user"],
  pending_partner: ["cancelled_by_user"],
  alternative_proposed: ["confirmed", "cancelled_by_user"],
  confirmed: ["cancelled_by_user"],
};

/**
 * Действия партнёра (states-and-rules §3.4). completed → no_show запрещён (C-27 (в)); no_show → completed —
 * исправление (Предложение, принято) в окне noShowCorrectionHours.
 */
const PARTNER_TRANSITIONS: Partial<Record<BookingStatus, readonly BookingStatus[]>> = {
  pending_partner: ["confirmed", "alternative_proposed", "cancelled_by_partner"],
  alternative_proposed: ["cancelled_by_partner"],
  confirmed: ["completed", "no_show", "cancelled_by_partner"],
  no_show: ["completed"],
};

export type BookingActorKind = "user" | "partner";

/**
 * Может ли турист отменить бронь сейчас (states-and-rules §3.4): confirmed — не позже чем за userCancelBeforeStartHours
 * до начала; new, pending_partner, alternative_proposed — до начала.
 */
export function userCancelAllowed(status: BookingStatus, startsAt: Date, now: Date): boolean {
  const before = status === "confirmed" ? BOOKING_PARAMS.userCancelBeforeStartHours * 3_600_000 : 0;
  return now.getTime() < startsAt.getTime() - before;
}

/**
 * Срок, до которого турист может отменить бронь (тот же расчёт, что userCancelAllowed): confirmed — за
 * userCancelBeforeStartHours до начала; new, pending_partner — начало; alternative_proposed — начало предложенного
 * слота. null — турист бронь не отменяет (закрыта или ещё не его ход).
 */
export function userCancelDeadline(
  status: BookingStatus,
  startsAt: Date,
  alternativeStartsAt: Date | null,
): Date | null {
  if (!userTransitions(status).includes("cancelled_by_user")) return null;
  const start = status === "alternative_proposed" && alternativeStartsAt ? alternativeStartsAt : startsAt;
  const before = status === "confirmed" ? BOOKING_PARAMS.userCancelBeforeStartHours * 3_600_000 : 0;
  return new Date(start.getTime() - before);
}

/**
 * Имя клиента онлайн-брони: пробелы схлопываются, длиннее customerNameMax — обрезается (по символам Unicode, как
 * char_length в БД); пустое — null (партнёр увидит имя из профиля).
 */
export function normalizeCustomerName(raw: string | null | undefined): string | null {
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  return Array.from(name).slice(0, BOOKING_PARAMS.customerNameMax).join("").trim() || null;
}

export function userTransitions(from: BookingStatus): readonly BookingStatus[] {
  return USER_TRANSITIONS[from] ?? [];
}

export function partnerTransitions(from: BookingStatus): readonly BookingStatus[] {
  return PARTNER_TRANSITIONS[from] ?? [];
}

/**
 * Кто выполняет переход: confirmed из alternative_proposed и cancelled_by_user — турист; остальные — партнёр.
 * undefined — переход недопустим ни для кого.
 */
export function transitionActor(from: BookingStatus, to: BookingStatus): BookingActorKind | undefined {
  if (userTransitions(from).includes(to)) return "user";
  if (partnerTransitions(from).includes(to)) return "partner";
  return undefined;
}

/**
 * Право партнёра на переход. Исправление no_show → completed и отказ/альтернатива — ORG_MANAGER+ (право
 * booking.reject — у менеджера и владельца, не у сотрудника).
 */
export function partnerPermission(from: BookingStatus, to: BookingStatus): PermissionCode {
  if (from === "no_show" && to === "completed") return "booking.reject";
  switch (to) {
    case "confirmed":
      return "booking.confirm";
    case "alternative_proposed":
      return "booking.propose_alternative";
    case "completed":
      return "booking.complete";
    case "no_show":
      return "booking.no_show";
    default:
      return "booking.reject";
  }
}

/** Интервал занятости [start − buffer_before, end + buffer_after) (states-and-rules §3.3, BR-08). */
export function occupiedRange(
  startsAt: Date,
  endsAt: Date,
  r: { buffer_before_min: number; buffer_after_min: number },
): { from: Date; until: Date } {
  return {
    from: new Date(startsAt.getTime() - r.buffer_before_min * MIN),
    until: new Date(endsAt.getTime() + r.buffer_after_min * MIN),
  };
}

/**
 * Срок ответа партнёра (D-43, принята рекомендация А): SLA ресурса, но не больше половины времени до начала (и не
 * меньше minPartnerSlaMin) и не позже начала слота.
 */
export function partnerResponseDue(now: Date, startsAt: Date, confirmSlaMin: number): Date {
  const untilStart = startsAt.getTime() - now.getTime();
  const half = Math.max(BOOKING_PARAMS.minPartnerSlaMin * MIN, Math.floor(untilStart / 2));
  const due = now.getTime() + Math.min(confirmSlaMin * MIN, half);
  return new Date(
    Math.min(due, Math.max(startsAt.getTime(), now.getTime() + BOOKING_PARAMS.minPartnerSlaMin * MIN)),
  );
}

/**
 * Срок ответа туриста на альтернативу (D-66, принята рекомендация): меньшее из фиксированного таймаута и «за X ч до
 * начала»; null — предложенный слот слишком близко (ответить уже некогда).
 */
export function customerResponseDue(now: Date, alternativeStartsAt: Date): Date | null {
  const due = Math.min(
    now.getTime() + BOOKING_PARAMS.customerResponseMin * MIN,
    alternativeStartsAt.getTime() - BOOKING_PARAMS.customerResponseBeforeStartMin * MIN,
  );
  return due > now.getTime() ? new Date(due) : null;
}

/** Правило доступности в виде для расчёта (минуты местного времени, дата "YYYY-MM-DD"). */
export type RuleInput = {
  dayOfWeek: number | null;
  date: string | null;
  closed: boolean;
  opensMin: number | null;
  closesMin: number | null;
};

export type SlotResource = {
  slot_duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  lead_time_min: number;
  horizon_days: number;
};

export type Slot = { startsAt: Date; endsAt: Date; occupiedFrom: Date; occupiedUntil: Date };
export type BusyRange = { from: Date; until: Date };

/** Окна даты: правила на дату перекрывают недельные (closed — выходной). */
export function windowsOn(rules: readonly RuleInput[], date: string, dayOfWeek: number): [number, number][] {
  const dated = rules.filter((r) => r.date === date);
  const source = dated.length > 0 ? dated : rules.filter((r) => r.dayOfWeek === dayOfWeek);
  if (source.some((r) => r.closed)) return [];
  return source
    .filter((r) => r.opensMin !== null && r.closesMin !== null)
    .map((r): [number, number] => [r.opensMin!, r.closesMin!])
    .sort((a, b) => a[0] - b[0]);
}

/** Проверка набора правил: окна одного дня (или даты) не пересекаются, на дату — либо closed, либо окна. */
export function rulesProblems(rules: readonly RuleInput[]): string[] {
  const problems: string[] = [];
  const groups = new Map<string, RuleInput[]>();
  for (const r of rules) {
    const key = r.date ?? `dow:${r.dayOfWeek}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, list] of groups) {
    if (list.some((r) => r.closed) && list.length > 1) problems.push(`${key}: closed_with_windows`);
    const windows = list
      .filter((r) => !r.closed)
      .map((r) => [r.opensMin!, r.closesMin!] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < windows.length; i++)
      if (windows[i]![0] < windows[i - 1]![1]) problems.push(`${key}: overlap`);
  }
  return problems;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

function dayOfWeekOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Местная дата момента в таймзоне. */
export function localDate(at: Date, timeZone: string): string {
  return localMoment(at, timeZone).date;
}

/**
 * Слоты ресурса на местные даты [fromDate, fromDate + days) в таймзоне региона (D-04 А: почасовые слоты, одна бронь
 * на слот). Шаг сетки — длительность + buffer до и после: соседние брони с buffer не пересекаются (BR-08). Слоты
 * раньше now + lead_time и позже now + horizon_days не возвращаются.
 */
export function generateSlots(
  resource: SlotResource,
  rules: readonly RuleInput[],
  fromDate: string,
  days: number,
  timeZone: string,
  now: Date,
): Slot[] {
  const out: Slot[] = [];
  const earliest = now.getTime() + resource.lead_time_min * MIN;
  const latest = now.getTime() + resource.horizon_days * DAY;
  const step = resource.slot_duration_min + resource.buffer_before_min + resource.buffer_after_min;
  const seen = new Set<number>();
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    for (const [opens, closes] of windowsOn(rules, date, dayOfWeekOf(date))) {
      for (let t = opens; t + resource.slot_duration_min <= closes; t += step) {
        const startsAt = zonedInstant(date, t, timeZone);
        if (startsAt.getTime() < earliest || startsAt.getTime() > latest) continue;
        // DST: местного времени нет (весенний перевод, 03:00–03:59 в Europe/Kyiv) — zonedInstant сдвигает его на
        // соседний час, и слот совпал бы с другим; такой слот пропускается. Осенью повтор часа — один момент.
        const local = localMoment(startsAt, timeZone);
        if (local.date !== date || local.minutes !== t || seen.has(startsAt.getTime())) continue;
        seen.add(startsAt.getTime());
        const endsAt = new Date(startsAt.getTime() + resource.slot_duration_min * MIN);
        const occ = occupiedRange(startsAt, endsAt, resource);
        out.push({ startsAt, endsAt, occupiedFrom: occ.from, occupiedUntil: occ.until });
      }
    }
  }
  return out;
}

/** Свободен ли слот: его интервал занятости не пересекается ни с одним занятым (полуинтервалы). */
export function isFree(slot: Slot, busy: readonly BusyRange[]): boolean {
  return !busy.some(
    (b) => b.from.getTime() < slot.occupiedUntil.getTime() && slot.occupiedFrom.getTime() < b.until.getTime(),
  );
}

/** Слот сетки, начинающийся ровно в startsAt (онлайн-бронь — только на слот из правил). */
export function findSlot(
  resource: SlotResource,
  rules: readonly RuleInput[],
  startsAt: Date,
  timeZone: string,
  now: Date,
): Slot | undefined {
  const date = localDate(startsAt, timeZone);
  // Окно, начавшееся накануне, через полночь не переходит (closes_min ≤ 1440) — достаточно даты начала.
  return generateSlots(resource, rules, date, 1, timeZone, now).find(
    (s) => s.startsAt.getTime() === startsAt.getTime(),
  );
}

export type AvailabilityNow = {
  /** «Доступно зараз» (иначе клиент показывает «Уточнити доступність»). */
  availableNow: boolean;
  /** Основание: реальный свободный слот, ручной статус партнёра; null — не доступно. */
  source: "slot" | "manual" | null;
  /** Ручной статус действует до (если действует). */
  manualExpiresAt: Date | null;
};

/**
 * «Доступно зараз» (BR-04, ТЗ §10.3): ручной статус с неистёкшим TTL (D-78) — его значение (busy — партнёр явно
 * сказал «мест нет»); иначе — есть ли свободный слот, начинающийся в горизонте «зараз». «Відкрито» ≠ «Доступно».
 */
export function availabilityNow(
  manual: { status: ManualAvailability; expiresAt: Date | null },
  freeSlots: readonly Slot[],
  now: Date,
): AvailabilityNow {
  const manualActive = manual.status !== "unknown" && manual.expiresAt !== null && manual.expiresAt > now;
  if (manualActive)
    return manual.status === "available_now"
      ? { availableNow: true, source: "manual", manualExpiresAt: manual.expiresAt }
      : { availableNow: false, source: null, manualExpiresAt: manual.expiresAt };
  const horizon = now.getTime() + BOOKING_PARAMS.availableNowHorizonMin * MIN;
  const slot = freeSlots.some(
    (s) => s.startsAt.getTime() >= now.getTime() && s.startsAt.getTime() <= horizon,
  );
  return { availableNow: slot, source: slot ? "slot" : null, manualExpiresAt: null };
}
