// Время в поясе региона, тексты статусов и причин брони, телефон E.164. Время API — UTC (RFC 3339), правила
// доступности и экраны — местное время региона.
import type { MessageKey } from "@tg/i18n";
import type { BookingStatus } from "./bookings-api.js";

/** Пояс, который понимает движок: tz → Europe/Kiev (старые ICU не знают Europe/Kyiv) → пояс устройства. */
export function zoneOf(tz: string): string | undefined {
  for (const zone of [tz, "Europe/Kiev"]) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return zone;
    } catch {
      // неизвестная зона — следующая
    }
  }
  return undefined;
}

function parts(instant: number, tz: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zoneOf(tz),
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
}

function offset(instant: number, tz: string): number {
  const p = parts(instant, tz);
  const local = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return local - Math.floor(instant / 1000) * 1000;
}

/** Местные дата "YYYY-MM-DD" и время "HH:MM" в поясе tz → ISO UTC. */
export function zonedIso(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  const first = guess - offset(guess, tz);
  return new Date(guess - offset(first, tz)).toISOString();
}

/** ISO → местная дата "YYYY-MM-DD" в поясе tz. */
export function localDate(iso: string | number, tz: string): string {
  const p = parts(typeof iso === "number" ? iso : Date.parse(iso), tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** ISO → местное время "HH:MM" в поясе tz. */
export function localTime(iso: string, tz: string): string {
  const p = parts(Date.parse(iso), tz);
  return `${p.hour}:${p.minute}`;
}

/** Сегодня в поясе tz. */
export function today(tz: string, now = Date.now()): string {
  return localDate(now, tz);
}

/** Сдвиг даты "YYYY-MM-DD" на n дней. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** "2026-11-05" → «чт, 5 листопада» (локаль интерфейса). */
export function dayLabel(date: string, locale: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "uk-UA", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** Начало брони: «чт, 5 листопада, 10:00». */
export function whenLabel(iso: string, tz: string, locale: string): string {
  return `${dayLabel(localDate(iso, tz), locale)}, ${localTime(iso, tz)}`;
}

// --- статусы и причины ---

export const STATUS_TONE: Partial<Record<BookingStatus, "accent" | "accent2" | "outline">> = {
  confirmed: "accent",
  alternative_proposed: "accent2",
  pending_partner: "outline",
  new: "outline",
};

/** Статус для туриста («Мої бронювання») и для партнёра (P04/P05) — разные формулировки отмен. */
export const statusKey = (s: BookingStatus, who: "user" | "partner") =>
  `miniapp.booking.${who === "user" ? "status" : "pstatus"}.${s}` as MessageKey;

/** Служебные коды причин (сервер, воркер) — человеческим текстом; не показываем сырые коды. */
const REASON_CODES: Record<string, MessageKey> = {
  alternative_declined: "miniapp.booking.reason.alternative_declined",
  customer_timeout: "miniapp.booking.reason.customer_timeout",
  customer_response_timeout: "miniapp.booking.reason.customer_timeout",
  alternative_expired: "miniapp.booking.reason.customer_timeout",
  partner_timeout: "miniapp.booking.reason.partner_timeout",
  partner_response_timeout: "miniapp.booking.reason.partner_timeout",
  partner_response_overdue: "miniapp.booking.reason.partner_timeout",
  sla_expired: "miniapp.booking.reason.partner_timeout",
  delivered_to_partner: "miniapp.booking.reason.delivered_to_partner",
  auto_confirm: "miniapp.booking.reason.auto_confirm",
  auto_completed: "miniapp.booking.reason.auto_completed",
};

const CODE_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Причина статуса для показа: известный код — ключ перевода; неизвестный служебный код — null (не показываем);
 * текст партнёра (причина отказа) — как есть.
 */
export function reasonText(reason: string | null | undefined, t: (key: MessageKey) => string): string | null {
  const r = reason?.trim();
  if (!r) return null;
  const key = REASON_CODES[r];
  if (key) return t(key);
  return CODE_RE.test(r) ? null : r;
}

// --- телефон ---

export const PHONE_E164_RE = /^\+[1-9][0-9]{7,14}$/;

/**
 * Номер, введённый вручную или из Telegram (без «+»), → E.164; украинские «0XXXXXXXXX» и «380…» дополняются.
 * null — не похоже на номер.
 */
export function normalizePhone(raw: string): string | null {
  const plus = raw.trim().startsWith("+");
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (!plus && digits.length === 10 && digits.startsWith("0")) digits = `38${digits}`;
  const e164 = `+${digits}`;
  return PHONE_E164_RE.test(e164) ? e164 : null;
}
