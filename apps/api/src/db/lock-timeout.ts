import { sql } from "kysely";
import type { Db } from "./database.js";

/**
 * `SET LOCAL lock_timeout` для текущей транзакции (`set_config(…, true)`): короткая транзакция не ждёт чужую
 * блокировку строки дольше `ms` — ошибка 55P03 вместо зависшего соединения пула. Вне транзакции — ошибка.
 */
export async function setLocalLockTimeout(trx: Db, ms: number): Promise<void> {
  if (!trx.isTransaction) throw new Error("setLocalLockTimeout: нужна транзакция");
  if (!Number.isInteger(ms) || ms < 1) throw new Error(`lock_timeout — целое число мс ≥ 1, получено ${ms}`);
  await sql`SELECT set_config('lock_timeout', ${`${ms}ms`}, true)`.execute(trx);
}
