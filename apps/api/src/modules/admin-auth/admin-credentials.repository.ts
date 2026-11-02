import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  InjectDb,
  type AdminCredential,
  type AdminLoginFailure,
  type Db,
  type NewAdminCredential,
  type UserStatus,
} from "../../db/index.js";

/** Блокировка пары «логин + адрес»: 5 неудач за 15 минут → 15 минут (ADR-0018). */
export const PAIR_MAX_FAILED_ATTEMPTS = 5;
export const PAIR_WINDOW_MINUTES = 15;
export const PAIR_LOCK_MINUTES = 15;
/** Глобальная блокировка учётки: 50 неудач за час со всех адресов → 15 минут. */
export const LOGIN_MAX_FAILED_ATTEMPTS = 50;
export const LOGIN_WINDOW_MINUTES = 60;
export const LOGIN_LOCK_MINUTES = 15;
/** Строки admin_login_failures старше суток удаляются при записи неудачи. */
export const FAILURE_RETENTION_HOURS = 24;

export type CredentialForLogin = AdminCredential & { user_status: UserStatus };

export type FailureResult = {
  /** Счётчик пары после этой неудачи; null — пара уже заблокирована (параллельная попытка), счётчик не менялся. */
  pairAttempts: number | null;
  /** Этой неудачей пара заблокирована. */
  pairLocked: boolean;
  /** Этой неудачей заблокирована учётка (глобальный порог); false и для несуществующего логина. */
  loginLocked: boolean;
};

/**
 * Учётки входа админа и счётчики неудач (global, миграция 0013). Чтение для проверки — без блокировки и вне
 * транзакции (scrypt не держит соединение пула); счётчики меняются атомарными UPDATE/UPSERT с условием блокировки
 * в том же операторе — параллельные попытки не теряют приращение и блокируют ровно один раз.
 */
@Injectable()
export class AdminCredentialsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Учётка с статусом пользователя и счётчик пары — два коротких запроса для каждого логина, даже несуществующего. */
  async lookup(
    login: string,
    loginHash: Buffer,
    clientHash: Buffer,
  ): Promise<{ credential: CredentialForLogin | undefined; pair: AdminLoginFailure | undefined }> {
    const db = currentDb(this.db);
    const credential = await db
      .selectFrom("admin_credentials")
      .innerJoin("users", "users.id", "admin_credentials.user_id")
      .selectAll("admin_credentials")
      .select("users.status as user_status")
      .where("admin_credentials.login", "=", login)
      .executeTakeFirst();
    const pair = await db
      .selectFrom("admin_login_failures")
      .selectAll()
      .where("login_hash", "=", loginHash)
      .where("client_hash", "=", clientHash)
      .executeTakeFirst();
    return { credential, pair };
  }

  /**
   * Неудача: приращение счётчика пары (UPSERT) и глобального счётчика учётки (UPDATE, для несуществующего логина —
   * 0 строк). Уже заблокированные пара/учётка не меняются (условие в операторе).
   * Вызывать в транзакции.
   */
  async recordFailure(login: string, loginHash: Buffer, clientHash: Buffer): Promise<FailureResult> {
    const db = currentDb(this.db);
    const pairBase = sql<number>`CASE WHEN admin_login_failures.locked_until IS NOT NULL
      OR admin_login_failures.last_failed_at < now() - make_interval(mins => ${PAIR_WINDOW_MINUTES})
      THEN 0 ELSE admin_login_failures.failed_attempts END`;
    const pairNext = sql<number>`(${pairBase}) + 1`;
    const pair = await db
      .insertInto("admin_login_failures")
      .values({ login_hash: loginHash, client_hash: clientHash, failed_attempts: 1, locked_until: null })
      .onConflict((oc) =>
        oc
          .columns(["login_hash", "client_hash"])
          .doUpdateSet({
            failed_attempts: pairNext,
            locked_until: sql`CASE WHEN ${pairNext} >= ${PAIR_MAX_FAILED_ATTEMPTS}
              THEN now() + make_interval(mins => ${PAIR_LOCK_MINUTES}) ELSE NULL END`,
            last_failed_at: sql`now()`,
          })
          .where(
            sql<boolean>`(admin_login_failures.locked_until IS NULL OR admin_login_failures.locked_until <= now())`,
          ),
      )
      .returning(["failed_attempts"])
      .executeTakeFirst();

    const reset = sql<boolean>`(failure_window_started_at IS NULL
      OR failure_window_started_at < now() - make_interval(mins => ${LOGIN_WINDOW_MINUTES})
      OR locked_until IS NOT NULL)`;
    const loginNext = sql<number>`CASE WHEN ${reset} THEN 1 ELSE failed_attempts + 1 END`;
    const global = await db
      .updateTable("admin_credentials")
      .set({
        failed_attempts: loginNext,
        failure_window_started_at: sql`CASE WHEN ${reset} THEN now() ELSE failure_window_started_at END`,
        locked_until: sql`CASE WHEN ${loginNext} >= ${LOGIN_MAX_FAILED_ATTEMPTS}
          THEN now() + make_interval(mins => ${LOGIN_LOCK_MINUTES}) ELSE NULL END`,
      })
      .where("login", "=", login)
      .where(sql<boolean>`(locked_until IS NULL OR locked_until <= now())`)
      .returning(["failed_attempts"])
      .executeTakeFirst();

    // Первая неудача пары (вставка) — 1; иначе — новое значение или нет строки (пара уже заблокирована).
    const pairAttempts = pair?.failed_attempts ?? null;
    return {
      pairAttempts,
      pairLocked: pairAttempts !== null && pairAttempts >= PAIR_MAX_FAILED_ATTEMPTS,
      loginLocked: global !== undefined && global.failed_attempts >= LOGIN_MAX_FAILED_ATTEMPTS,
    };
  }

  /**
   * Успешный вход в транзакции, с повторной проверкой блокировок (между чтением и scrypt могла сработать параллельная
   * неудача). Порядок блокировок строк — как в recordFailure: сначала пара, потом учётка (без взаимоблокировки).
   * false — пара или учётка заблокированы: ничего не меняется.
   */
  async recordSuccess(credentialId: string, loginHash: Buffer, clientHash: Buffer): Promise<boolean> {
    const db = currentDb(this.db);
    const pair = await db
      .selectFrom("admin_login_failures")
      .select(sql<boolean>`coalesce(locked_until > now(), false)`.as("locked"))
      .where("login_hash", "=", loginHash)
      .where("client_hash", "=", clientHash)
      .forUpdate()
      .executeTakeFirst();
    if (pair?.locked) return false;
    const cred = await db
      .updateTable("admin_credentials")
      .set({
        failed_attempts: 0,
        failure_window_started_at: null,
        locked_until: null,
        last_login_at: sql`now()`,
      })
      .where("id", "=", credentialId)
      .where(sql<boolean>`(locked_until IS NULL OR locked_until <= now())`)
      .returning("id")
      .executeTakeFirst();
    if (!cred) return false;
    await db
      .deleteFrom("admin_login_failures")
      .where("login_hash", "=", loginHash)
      .where("client_hash", "=", clientHash)
      .execute();
    return true;
  }

  /**
   * Удаляет до `limit` строк admin_login_failures старше FAILURE_RETENTION_HOURS — отдельным оператором вне
   * транзакции попытки; строки, занятые параллельной попыткой, пропускаются (SKIP LOCKED). Возвращает число удалённых.
   */
  async purgeStaleFailures(limit = 100): Promise<number> {
    const res = await currentDb(this.db)
      .deleteFrom("admin_login_failures")
      .where((eb) =>
        eb(
          eb.refTuple("login_hash", "client_hash"),
          "in",
          eb
            .selectFrom("admin_login_failures as stale")
            .select(["stale.login_hash", "stale.client_hash"])
            .where(
              "stale.last_failed_at",
              "<",
              sql<Date>`now() - make_interval(hours => ${FAILURE_RETENTION_HOURS})`,
            )
            .limit(limit)
            .forUpdate()
            .skipLocked()
            .$asTuple("login_hash", "client_hash"),
        ),
      )
      .executeTakeFirst();
    return Number(res.numDeletedRows);
  }

  findByLogin(login: string): Promise<AdminCredential | undefined> {
    return currentDb(this.db)
      .selectFrom("admin_credentials")
      .selectAll()
      .where("login", "=", login)
      .executeTakeFirst();
  }

  create(row: NewAdminCredential): Promise<AdminCredential> {
    return currentDb(this.db)
      .insertInto("admin_credentials")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
