// Сроки броней (блок 7): только вызовы функций bookings_expire_due() и bookings_auto_complete() из миграции api 0022 —
// они сами выставляют app.actor = 'system' (RLS) и пишут историю брони и аналитику.
import type { BookingsDueProcessor } from "../queue/handlers.js";

/** Броней за один вызов функции (одна короткая транзакция). */
export const BOOKINGS_DUE_BATCH = 500;
/**
 * Автозавершение confirmed через столько часов после окончания, если партнёр не отметил no_show (C-27 (а), принята
 * рекомендация; значение — параметр тестового режима).
 */
export const DEFAULT_BOOKING_AUTO_COMPLETE_HOURS = 24;
/** Предел вызовов за задачу: остаток обработает следующий тик. */
const MAX_BATCHES = 20;

/** Исполнитель запроса (pg.Pool подходит); тесты подставляют свой. */
export interface CountQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: { n: number }[] }>;
}

async function drain(db: CountQueryable, text: string, values: unknown[], batch: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { rows } = await db.query(text, values);
    const n = rows[0]?.n ?? 0;
    total += n;
    if (n < batch) break;
  }
  return total;
}

export function bookingsDueProcessor(
  db: CountQueryable,
  autoCompleteHours = DEFAULT_BOOKING_AUTO_COMPLETE_HOURS,
  batch = BOOKINGS_DUE_BATCH,
): BookingsDueProcessor {
  if (!Number.isInteger(autoCompleteHours) || autoCompleteHours < 1)
    throw new Error(`Автозавершение броней — целое число часов ≥ 1, получено ${autoCompleteHours}`);
  return {
    async processDue() {
      const expired = await drain(db, "SELECT bookings_expire_due($1) AS n", [batch], batch);
      const completed = await drain(
        db,
        "SELECT bookings_auto_complete($1, $2) AS n",
        [autoCompleteHours, batch],
        batch,
      );
      return { expired, completed };
    },
  };
}
