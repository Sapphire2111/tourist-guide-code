// «Відкрито зараз» по графику места (блок 4, ADR-0017 «График», ADR-0019) — без БД и Nest. График — интервалы
// местного времени в таймзоне региона: недельные (1 — понедельник … 7 — воскресенье; closes <= opens — через
// полночь) и исключения на дату (closed — закрыто весь день, иначе интервалы даты вместо недельного графика).

export type WeeklyRow = { dayOfWeek: number; opensAt: string; closesAt: string };
export type ExceptionRow = { date: string; closed: boolean; opensAt: string | null; closesAt: string | null };
export type ScheduleRows = { weekly: readonly WeeklyRow[]; exceptions: readonly ExceptionRow[] };

/** openNow: null — график неизвестен; openUntil — время закрытия текущего интервала (HH:MM), если открыто. */
export type OpenState = { openNow: boolean | null; openUntil: string | null };

export type LocalMoment = {
  /** YYYY-MM-DD местной даты. */
  date: string;
  /** Вчерашняя местная дата (для интервалов через полночь). */
  previousDate: string;
  /** ISO: 1 — понедельник … 7 — воскресенье. */
  dayOfWeek: number;
  /** Минуты от местной полуночи. */
  minutes: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const isoDay = (utcDay: number) => (utcDay === 0 ? 7 : utcDay);

/** Местные дата, день недели и минуты момента `now` в таймзоне IANA. */
export function localMoment(now: Date, timeZone: string): LocalMoment {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const day = new Date(Date.UTC(y, m - 1, d));
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return {
    date: day.toISOString().slice(0, 10),
    previousDate: prev.toISOString().slice(0, 10),
    dayOfWeek: isoDay(day.getUTCDay()),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** "HH:MM" или "HH:MM:SS" → минуты. */
const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (t: string) => t.slice(0, 5);

type Interval = { opens: number; closes: number; closesAt: string };

/** Интервалы даты: исключения даты (closed — пусто) или недельный график её дня. */
function intervalsOn(s: ScheduleRows, date: string, dayOfWeek: number): Interval[] {
  const ex = s.exceptions.filter((e) => e.date === date);
  const rows: { opensAt: string | null; closesAt: string | null }[] =
    ex.length > 0 ? (ex.some((e) => e.closed) ? [] : ex) : s.weekly.filter((w) => w.dayOfWeek === dayOfWeek);
  return rows
    .filter((r): r is { opensAt: string; closesAt: string } => r.opensAt !== null && r.closesAt !== null)
    .map((r) => ({ opens: toMinutes(r.opensAt), closes: toMinutes(r.closesAt), closesAt: hhmm(r.closesAt) }));
}

/**
 * Открыто ли место в момент `at`. Неизвестно (null) — нет недельного графика и нет исключений на сегодня и вчера.
 * Интервал вчерашнего дня через полночь продолжается сегодня до своего закрытия (даже если сегодня — выходной по
 * исключению: смена началась вчера).
 */
export function openState(s: ScheduleRows, at: LocalMoment): OpenState {
  const relevantException = s.exceptions.some((e) => e.date === at.date || e.date === at.previousDate);
  if (s.weekly.length === 0 && !relevantException) return { openNow: null, openUntil: null };
  const t = at.minutes;
  for (const i of intervalsOn(s, at.date, at.dayOfWeek)) {
    const overnight = i.closes <= i.opens;
    if (overnight ? t >= i.opens : t >= i.opens && t < i.closes)
      return { openNow: true, openUntil: i.closesAt };
  }
  const yesterday = at.dayOfWeek === 1 ? 7 : at.dayOfWeek - 1;
  for (const i of intervalsOn(s, at.previousDate, yesterday))
    if (i.closes <= i.opens && t < i.closes) return { openNow: true, openUntil: i.closesAt };
  return { openNow: false, openUntil: null };
}
