// Проверка роли БД при старте api (T1-11): RLS не применяется к SUPERUSER и ролям с BYPASSRLS — если
// DATABASE_URL указывает на такую роль, второй рубеж изоляции молча не действует.
import { sql } from "kysely";
import type { Db } from "./database.js";

export type DbRoleStatus = { role: string; bypassesRls: boolean };

export type RoleCheckLogger = { warn(message: string): void; log(message: string): void };

export type RoleCheckOptions = {
  /** APP_ENV: в staging/prod роль в обход RLS — отказ запуска, в local — предупреждение. */
  appEnv: "local" | "staging" | "prod";
  /** Чтение статуса роли (readDbRoleStatus или подмена в тестах). */
  read: () => Promise<DbRoleStatus>;
  logger: RoleCheckLogger;
  /** Сколько ждать БД, мс (по умолчанию 5000): пул ленивый, недоступная БД не должна держать старт. */
  timeoutMs?: number;
};

/** Текущая роль соединения и обходит ли она RLS (SUPERUSER или BYPASSRLS). */
export async function readDbRoleStatus(db: Db): Promise<DbRoleStatus> {
  const { rows } = await sql<{ role: string; bypass: boolean }>`
    SELECT current_user AS role, (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user
  `.execute(db);
  const row = rows[0];
  if (!row) throw new Error("роль current_user не найдена в pg_roles");
  return { role: row.role, bypassesRls: row.bypass };
}

export class RlsBypassRoleError extends Error {
  override readonly name = "RlsBypassRoleError";
}

/**
 * Вызывается в bootstrap до listen. Поведение:
 * - роль без обхода RLS — запись в лог, старт;
 * - роль SUPERUSER/BYPASSRLS: staging/prod — RlsBypassRoleError (main.ts завершает процесс), local — предупреждение;
 * - БД недоступна, ошибка или таймаут — предупреждение «проверка пропущена» и старт, как без проверки (пул
 *   ленивый; api с недоступной БД запускается, /health отвечает). Проверка тогда не повторяется.
 */
export async function checkDbRole({
  appEnv,
  read,
  logger,
  timeoutMs = 5000,
}: RoleCheckOptions): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`нет ответа БД за ${timeoutMs} мс`)), timeoutMs);
  });
  let status: DbRoleStatus;
  try {
    status = await Promise.race([read(), timeout]);
  } catch (err) {
    logger.warn(`Проверка роли БД (RLS) пропущена: ${(err as Error).message}`);
    return;
  } finally {
    clearTimeout(timer);
  }
  if (!status.bypassesRls) {
    logger.log(`Роль БД ${status.role}: RLS применяется`);
    return;
  }
  const message =
    `Роль БД ${status.role} — SUPERUSER или BYPASSRLS: RLS (второй рубеж изоляции регионов) к ней не применяется. ` +
    "В DATABASE_URL нужна логин-роль группы app (apps/api/README.md, «Роли БД»).";
  if (appEnv === "local") logger.warn(message);
  else throw new RlsBypassRoleError(message);
}
