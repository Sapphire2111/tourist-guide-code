// Обезличивание заявок гостиницы по сроку хранения (D-49, ADR-0020): только вызов функции
// service_requests_anonymize_expired() из миграции api 0015 — она сама выставляет app.actor = 'system' (RLS).
import type { ServiceRequestsAnonymizer } from "../queue/handlers.js";
import type { Queryable } from "./audit-pii-purger.js";

/** Срок хранения заявок по умолчанию, дней (D-49: параметр; значение — LEG/PO, рекомендация тестового режима). */
export const DEFAULT_SERVICE_REQUEST_RETENTION_DAYS = 90;
/** Заявок за один вызов функции. */
export const SERVICE_REQUESTS_ANONYMIZE_BATCH = 1_000;
const MAX_BATCHES = 50;

export function serviceRequestsAnonymizer(
  db: Queryable,
  retentionDays = DEFAULT_SERVICE_REQUEST_RETENTION_DAYS,
  batch = SERVICE_REQUESTS_ANONYMIZE_BATCH,
): ServiceRequestsAnonymizer {
  if (!Number.isInteger(retentionDays) || retentionDays < 1)
    throw new Error(`Срок хранения заявок — целое число дней ≥ 1, получено ${retentionDays}`);
  return {
    async anonymizeExpired() {
      let total = 0;
      for (let i = 0; i < MAX_BATCHES; i++) {
        const { rows } = await db.query("SELECT service_requests_anonymize_expired($1, $2) AS deleted", [
          retentionDays,
          batch,
        ]);
        const n = rows[0]?.deleted ?? 0;
        total += n;
        if (n < batch) break;
      }
      return total;
    },
  };
}
