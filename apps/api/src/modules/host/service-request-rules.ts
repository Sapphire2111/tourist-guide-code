// Правила заявки гостиницы (states-and-rules §2, S-03; D-55) — без Nest и БД: переходы статусов, часы приёма,
// SLA и просрочка.
import type { ServiceRequestStatus } from "../../db/index.js";
import { localMoment } from "../guide/index.js";

/** Переходы персонала: new → accepted → in_progress → done; new|accepted → rejected (с причиной). */
const STAFF_TRANSITIONS: Readonly<Record<ServiceRequestStatus, readonly ServiceRequestStatus[]>> = {
  new: ["accepted", "rejected"],
  accepted: ["in_progress", "rejected"],
  in_progress: ["done"],
  done: [],
  rejected: [],
  cancelled_by_guest: [],
};

/** Гость отменяет заявку до начала выполнения (new, accepted) — states-and-rules §2. */
const GUEST_CANCELLABLE: ReadonlySet<ServiceRequestStatus> = new Set(["new", "accepted"]);

export const OPEN_STATUSES: readonly ServiceRequestStatus[] = ["new", "accepted", "in_progress"];
export const FINAL_STATUSES: ReadonlySet<ServiceRequestStatus> = new Set([
  "done",
  "rejected",
  "cancelled_by_guest",
]);

export function staffTransitions(from: ServiceRequestStatus): readonly ServiceRequestStatus[] {
  return STAFF_TRANSITIONS[from];
}

export function canStaffMove(from: ServiceRequestStatus, to: ServiceRequestStatus): boolean {
  return STAFF_TRANSITIONS[from].includes(to);
}

export function canGuestCancel(status: ServiceRequestStatus): boolean {
  return GUEST_CANCELLABLE.has(status);
}

/** Просрочен SLA: заявка не закрыта, срок прошёл (флаг, не статус — states-and-rules §2). */
export function isOverdue(status: ServiceRequestStatus, slaDueAt: Date | null, now: Date): boolean {
  return slaDueAt !== null && !FINAL_STATUSES.has(status) && slaDueAt.getTime() < now.getTime();
}

/** Часы приёма «HH:MM[:SS]» → минуты от полуночи. */
export function toMinutes(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
}

export type Hours = { from: string; to: string } | null;

/** Внутри ли местного времени `minutes` окно приёма (to <= from — через полночь). null — круглосуточно. */
export function withinHours(hours: Hours, minutes: number): boolean {
  if (!hours) return true;
  const from = toMinutes(hours.from);
  const to = toMinutes(hours.to);
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** Смещение часового пояса в момент `at`, мс (местное − UTC). */
function offsetMs(at: Date, timeZone: string): number {
  const m = localMoment(at, timeZone);
  const [y, mo, d] = m.date.split("-").map(Number);
  const localAsUtc = Date.UTC(y!, mo! - 1, d!, Math.floor(m.minutes / 60), m.minutes % 60);
  return localAsUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** Момент UTC для местной даты YYYY-MM-DD и минут от полуночи в таймзоне (DST — по смещению около момента). */
export function zonedInstant(date: string, minutes: number, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, Math.floor(minutes / 60), minutes % 60);
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Сейчас часы приёма — null; иначе ближайшее начало приёма (D-55: «буде оброблено з …»). */
export function nextOpening(hours: Hours, now: Date, timeZone: string): Date | null {
  if (!hours) return null;
  const at = localMoment(now, timeZone);
  if (withinHours(hours, at.minutes)) return null;
  const from = toMinutes(hours.from);
  // Вне окна: если начало сегодня ещё впереди — сегодня, иначе завтра.
  const date = at.minutes < from ? at.date : addDays(at.date, 1);
  return zonedInstant(date, from, timeZone);
}

/** Срок SLA: от начала обработки (создание или открытие приёма) + минуты услуги. */
export function slaDueAt(start: Date, slaMinutes: number | null): Date | null {
  return slaMinutes === null ? null : new Date(start.getTime() + slaMinutes * 60_000);
}
