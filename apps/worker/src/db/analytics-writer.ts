// Запись аналитических событий (T1-25): только вызов функции analytics_record_event(jsonb) из миграции api 0007.
// Как и очистка ПДн аудита — без запросов к таблицам: функция сама вставляет строку (идемпотентно по id)
// и на время INSERT выставляет app.actor = 'system' (RLS: событие гостя без региона).
import type { AnalyticsEventRow } from "@tg/queue-contract";
import type { AnalyticsWriter } from "../queue/handlers.js";

/** Исполнитель запроса (pg.Pool подходит); тесты подставляют свой. */
export interface AnalyticsQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: { inserted: boolean }[] }>;
}

export function analyticsWriter(db: AnalyticsQueryable): AnalyticsWriter {
  return {
    async record(row: AnalyticsEventRow) {
      const { rows } = await db.query("SELECT analytics_record_event($1::jsonb) AS inserted", [
        JSON.stringify(row),
      ]);
      return rows[0]?.inserted === true;
    },
  };
}
