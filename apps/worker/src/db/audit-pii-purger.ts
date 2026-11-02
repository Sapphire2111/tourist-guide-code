// Первое обращение воркера к БД (T1-13): только вызов функции audit_purge_expired_pii() из миграции api 0004.
// Слоя БД (Kysely + TenantGuardPlugin) у воркера пока нет — он появится, когда воркеру понадобятся
// tenant-данные (ADR-005, «Открытое»). Здесь нет запросов к таблицам: функция сама ограничена истёкшими
// строками audit_log_pii и сама выставляет app.actor = 'system' на время удаления (RLS).
import type { AuditPiiPurger } from "../queue/handlers.js";

/** Строк за один вызов функции (одна короткая транзакция). */
export const AUDIT_PII_PURGE_BATCH = 10_000;
/** Предел вызовов за задачу: остаток удалит следующий тик расписания. */
const MAX_BATCHES = 100;

/** Исполнитель запроса (pg.Pool подходит); тесты подставляют свой. */
export interface Queryable {
  query(text: string, values: unknown[]): Promise<{ rows: { deleted: number }[] }>;
}

/** Удаляет истёкшие ПДн аудита пачками, пока пачка полная. */
export function auditPiiPurger(db: Queryable, batch = AUDIT_PII_PURGE_BATCH): AuditPiiPurger {
  return {
    async purgeExpired() {
      let total = 0;
      for (let i = 0; i < MAX_BATCHES; i++) {
        const { rows } = await db.query("SELECT audit_purge_expired_pii($1) AS deleted", [batch]);
        const deleted = rows[0]?.deleted ?? 0;
        total += deleted;
        if (deleted < batch) break;
      }
      return total;
    },
  };
}
