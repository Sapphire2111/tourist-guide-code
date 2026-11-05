// Стирание ПДн заявок «Це мій заклад» по сроку хранения (0031): только вызов функции place_claims_purge_expired_pii()
// из миграции api 0031 — она сама выставляет app.actor = 'system' (RLS). Телефон и комментарий заявителя решённой
// заявки стираются через 90 дней после последнего изменения.
import type { PlaceClaimsPiiPurger } from "../queue/handlers.js";
import type { Queryable } from "./audit-pii-purger.js";

/** Срок хранения телефона заявителя после решения, дней. */
export const PLACE_CLAIM_PII_RETENTION_DAYS = 90;
export const PLACE_CLAIMS_PURGE_BATCH = 1_000;
const MAX_BATCHES = 50;

export function placeClaimsPiiPurger(
  db: Queryable,
  retentionDays = PLACE_CLAIM_PII_RETENTION_DAYS,
  batch = PLACE_CLAIMS_PURGE_BATCH,
): PlaceClaimsPiiPurger {
  return {
    async purgeExpired() {
      let total = 0;
      for (let i = 0; i < MAX_BATCHES; i++) {
        const { rows } = await db.query("SELECT place_claims_purge_expired_pii($1, $2) AS deleted", [
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
