// Часы работы: быстрые варианты («Щодня», «Пн–Пт», «Пн–Сб», «Цілодобово»), дни-чипы, одно время для выбранных
// дней и «Різний час по днях». Значение — те же недельные интервалы, что уходят в PUT /schedule.
import { useId } from "react";
import type { MessageKey } from "@tg/i18n";
import { Button, useT } from "@tg/ui";

export type Row = { dayOfWeek: number; opensAt: string; closesAt: string };
export type Time = { opensAt: string; closesAt: string };
export type PresetId = "daily" | "weekdays" | "sixdays" | "allday";

export const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const DEFAULT_TIME: Time = { opensAt: "09:00", closesAt: "18:00" };
/** Круглосуточно: 00:00–23:59 на все дни (так же хранит график импорт Google). */
export const ALL_DAY: Time = { opensAt: "00:00", closesAt: "23:59" };

export const PRESET_DAYS: Record<PresetId, readonly number[]> = {
  daily: DAYS,
  weekdays: [1, 2, 3, 4, 5],
  sixdays: [1, 2, 3, 4, 5, 6],
  allday: DAYS,
};
const PRESETS: PresetId[] = ["daily", "weekdays", "sixdays", "allday"];

const sameTime = (a: Time, b: Time) => a.opensAt === b.opensAt && a.closesAt === b.closesAt;
const isAllDay = (t: Time) => sameTime(t, ALL_DAY);

/** Дни недели, в которые есть хотя бы один интервал. */
export function openDays(rows: readonly Row[]): number[] {
  return DAYS.filter((d) => rows.some((r) => r.dayOfWeek === d));
}

/** Общее время всех интервалов: Time — одинаковое, "mixed" — разное, null — графика нет. */
export function commonTime(rows: readonly Row[]): Time | "mixed" | null {
  const first = rows[0];
  if (!first) return null;
  const time = { opensAt: first.opensAt, closesAt: first.closesAt };
  return rows.every((r) => sameTime(r, time)) && openDays(rows).length === rows.length ? time : "mixed";
}

/** Время для новых дней: общее, если оно есть и не «цілодобово», иначе 09:00–18:00. */
export function baseTime(rows: readonly Row[]): Time {
  const c = commonTime(rows);
  if (c && c !== "mixed" && !isAllDay(c)) return c;
  const first = rows.find((r) => !isAllDay(r));
  return first ? { opensAt: first.opensAt, closesAt: first.closesAt } : DEFAULT_TIME;
}

/** Быстрый вариант → интервалы: по одному на день. */
export function presetRows(id: PresetId, time: Time = DEFAULT_TIME): Row[] {
  const t = id === "allday" ? ALL_DAY : time;
  return PRESET_DAYS[id].map((dayOfWeek) => ({ dayOfWeek, ...t }));
}

/** Какой быстрый вариант сейчас выбран (по дням и времени), если какой-то. */
export function activePreset(rows: readonly Row[]): PresetId | null {
  const c = commonTime(rows);
  if (!c || c === "mixed") return null;
  const days = openDays(rows).join();
  if (isAllDay(c)) return days === PRESET_DAYS.allday.join() ? "allday" : null;
  return PRESETS.find((p) => p !== "allday" && PRESET_DAYS[p].join() === days) ?? null;
}

/** Выбранные дни: у оставшихся интервалы сохраняются, новые получают time, снятые — пропадают. */
export function withDays(rows: readonly Row[], days: readonly number[], time: Time): Row[] {
  const kept = rows.filter((r) => days.includes(r.dayOfWeek));
  const added = DAYS.filter((d) => days.includes(d) && !kept.some((r) => r.dayOfWeek === d));
  return [...kept, ...added.map((dayOfWeek) => ({ dayOfWeek, ...time }))].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek,
  );
}

/** Одно время для всех рабочих дней (по одному интервалу на день). */
export function withCommonTime(rows: readonly Row[], time: Time): Row[] {
  return openDays(rows).map((dayOfWeek) => ({ dayOfWeek, ...time }));
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Новый интервал дня после последнего: от его закрытия на 2 часа (до 23:59); места нет — null. */
export function nextInterval(dayRows: readonly Row[]): Time | null {
  const last = dayRows.reduce<Row | null>(
    (a, r) => (!a || toMin(r.closesAt) > toMin(a.closesAt) ? r : a),
    null,
  );
  if (!last) return DEFAULT_TIME;
  const from = toMin(last.closesAt);
  // Закрытие после полуночи (closes <= opens) или конец суток — добавить некуда.
  if (toMin(last.closesAt) <= toMin(last.opensAt) || from >= 23 * 60 + 58) return null;
  return { opensAt: fromMin(from), closesAt: fromMin(Math.min(from + 120, 23 * 60 + 59)) };
}

/** Сравнение без учёта порядка: «изменён ли график». */
export function sameSchedule(a: readonly Row[], b: readonly Row[]): boolean {
  const key = (rs: readonly Row[]) =>
    rs
      .map((r) => `${r.dayOfWeek}|${r.opensAt.slice(0, 5)}|${r.closesAt.slice(0, 5)}`)
      .sort()
      .join(";");
  return key(a) === key(b);
}

export function ScheduleForm({
  rows,
  onChange,
  disabled = false,
}: {
  rows: readonly Row[];
  onChange: (rows: Row[]) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const ids = { opens: useId(), closes: useId() };
  const common = commonTime(rows);
  const active = activePreset(rows);
  const days = openDays(rows);
  const dayName = (d: number) => t(`common.weekday.${d}` as MessageKey);
  const dayShort = (d: number) => t(`miniapp.partner.schedule.dayShort.${d}` as MessageKey);
  const update = (i: number, patch: Partial<Row>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggleDay = (d: number) =>
    onChange(
      withDays(
        rows,
        days.includes(d) ? days.filter((x) => x !== d) : [...days, d],
        common && common !== "mixed" ? common : baseTime(rows),
      ),
    );
  const time = common && common !== "mixed" ? common : baseTime(rows);

  return (
    <fieldset disabled={disabled} className="partner-fieldset" data-testid="schedule-form">
      <div className="partner-group">
        <strong id={`${ids.opens}-presets`}>{t("miniapp.partner.schedule.presets")}</strong>
        <div className="partner-chips" role="group" aria-labelledby={`${ids.opens}-presets`}>
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className="partner-chip"
              aria-pressed={active === p}
              onClick={() => onChange(presetRows(p, baseTime(rows)))}
            >
              {t(`miniapp.partner.schedule.preset.${p}` as MessageKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="partner-group">
        <strong id={`${ids.opens}-days`}>{t("miniapp.partner.schedule.days")}</strong>
        <div className="partner-chips" role="group" aria-labelledby={`${ids.opens}-days`}>
          {DAYS.map((d) => (
            <button
              key={d}
              type="button"
              className="partner-chip"
              aria-pressed={days.includes(d)}
              aria-label={dayName(d)}
              onClick={() => toggleDay(d)}
            >
              {dayShort(d)}
            </button>
          ))}
        </div>
        {!days.length && <p className="partner-field-hint">{t("miniapp.partner.schedule.noDays")}</p>}
      </div>

      {days.length > 0 && (
        <div className="partner-group">
          <strong>{t("miniapp.partner.schedule.commonTime")}</strong>
          {common === "mixed" && (
            <p className="partner-field-hint" data-testid="schedule-mixed">
              {t("miniapp.partner.schedule.mixed")}
            </p>
          )}
          <div className="partner-row">
            <div className="partner-field partner-field-time">
              <label htmlFor={ids.opens}>{t("miniapp.partner.schedule.opens")}</label>
              <input
                id={ids.opens}
                type="time"
                value={time.opensAt}
                disabled={common === "mixed"}
                onChange={(e) =>
                  e.target.value && onChange(withCommonTime(rows, { ...time, opensAt: e.target.value }))
                }
              />
            </div>
            <div className="partner-field partner-field-time">
              <label htmlFor={ids.closes}>{t("miniapp.partner.schedule.closes")}</label>
              <input
                id={ids.closes}
                type="time"
                value={time.closesAt}
                disabled={common === "mixed"}
                onChange={(e) =>
                  e.target.value && onChange(withCommonTime(rows, { ...time, closesAt: e.target.value }))
                }
              />
            </div>
          </div>
        </div>
      )}

      <details className="partner-details" open={common === "mixed" || undefined}>
        <summary>{t("miniapp.partner.schedule.perDay")}</summary>
        <ul className="partner-list" data-testid="schedule-rows">
          {DAYS.map((d) => {
            const mine = rows.map((r, i) => ({ r, i })).filter((x) => x.r.dayOfWeek === d);
            return (
              <li key={d} className="partner-day" data-day={d}>
                <div className="partner-row">
                  <strong className="partner-day-name">{dayName(d)}</strong>
                  <label className="partner-check">
                    <input
                      type="checkbox"
                      checked={!mine.length}
                      aria-label={`${t("miniapp.partner.schedule.closed")}: ${dayName(d)}`}
                      onChange={(e) =>
                        onChange(
                          e.target.checked
                            ? rows.filter((r) => r.dayOfWeek !== d)
                            : withDays(rows, [...days, d], time),
                        )
                      }
                    />
                    {t("miniapp.partner.schedule.closed")}
                  </label>
                </div>
                {mine.map(({ r, i }) => (
                  <div key={i} className="partner-row">
                    <input
                      type="time"
                      className="partner-time"
                      aria-label={`${t("miniapp.partner.schedule.opens")}, ${dayName(d)}`}
                      value={r.opensAt}
                      onChange={(e) => e.target.value && update(i, { opensAt: e.target.value })}
                    />
                    <span aria-hidden="true">–</span>
                    <input
                      type="time"
                      className="partner-time"
                      aria-label={`${t("miniapp.partner.schedule.closes")}, ${dayName(d)}`}
                      value={r.closesAt}
                      onChange={(e) => e.target.value && update(i, { closesAt: e.target.value })}
                    />
                    <Button
                      aria-label={`${t("miniapp.partner.schedule.remove")}, ${dayName(d)}`}
                      onClick={() => onChange(rows.filter((_, j) => j !== i))}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                {mine.length > 0 && (
                  <Button
                    aria-label={`${t("miniapp.partner.schedule.add")}, ${dayName(d)}`}
                    disabled={!nextInterval(mine.map((x) => x.r))}
                    onClick={() => {
                      const next = nextInterval(mine.map((x) => x.r));
                      if (next) onChange([...rows, { dayOfWeek: d, ...next }]);
                    }}
                  >
                    {t("miniapp.partner.schedule.add")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </fieldset>
  );
}
