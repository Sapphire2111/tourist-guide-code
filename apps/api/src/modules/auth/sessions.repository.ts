import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  InjectDb,
  type Db,
  type NewSession,
  type Session,
  type SessionChannel,
  type SessionRevokeReason,
} from "../../db/index.js";

/** Действующая сессия — то, что нужно принципалу запроса. */
export type ActiveSession = {
  readonly id: string;
  readonly userId: string;
  readonly channel: SessionChannel;
  readonly activeRegionId: string | null;
};

/**
 * Доступ к sessions (global, миграция 0006). Сроки сравниваются с now() БД — одни часы для всех реплик api.
 * Запросы — через currentDb(): внутри withTenant() это транзакция запроса; своя db.transaction() там запрещена.
 */
@Injectable()
export class SessionsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  create(session: NewSession): Promise<Session> {
    return currentDb(this.db).insertInto("sessions").values(session).returningAll().executeTakeFirstOrThrow();
  }

  findById(id: string): Promise<Session | undefined> {
    return currentDb(this.db).selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /**
   * Сессия по sha256 токена, если она действует: не отозвана, не истекла, пользователь в статусе active
   * (заблокированный или анонимизированный — нет: его запросы анонимны, защищённые эндпоинты — 401).
   */
  async findActiveByTokenHash(tokenHash: Buffer): Promise<ActiveSession | undefined> {
    const row = await currentDb(this.db)
      .selectFrom("sessions")
      .innerJoin("users", "users.id", "sessions.user_id")
      .select(["sessions.id", "sessions.user_id", "sessions.channel", "sessions.active_region_id"])
      .where("sessions.token_hash", "=", tokenHash)
      .where("sessions.revoked_at", "is", null)
      .where("sessions.expires_at", ">", sql<Date>`now()`)
      .where("users.status", "=", "active")
      .executeTakeFirst();
    return (
      row && {
        id: row.id,
        userId: row.user_id,
        channel: row.channel,
        activeRegionId: row.active_region_id,
      }
    );
  }

  /** Отзыв действующей сессии; уже отозванная или несуществующая — undefined. */
  revoke(id: string, reason: SessionRevokeReason): Promise<Session | undefined> {
    return currentDb(this.db)
      .updateTable("sessions")
      .set({ revoked_at: sql<Date>`now()`, revoke_reason: reason })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
  }

  /** Выбранный регион режима партнёра/админа (null — не выбран); только у действующей сессии. */
  setActiveRegion(id: string, regionId: string | null): Promise<Session | undefined> {
    return currentDb(this.db)
      .updateTable("sessions")
      .set({ active_region_id: regionId })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Удаляет истёкшие и отозванные сессии (не больше limit за вызов); возвращает число удалённых. Факт выдачи и отзыва
   * остаётся в аудите. TODO: периодический вызов — задача воркера (как очистка ключей идемпотентности).
   */
  async deleteInactive(limit = 10_000): Promise<number> {
    const db = currentDb(this.db);
    const result = await db
      .deleteFrom("sessions")
      .where(
        "id",
        "in",
        db
          .selectFrom("sessions")
          .select("id")
          .where((eb) => eb.or([eb("expires_at", "<=", sql<Date>`now()`), eb("revoked_at", "is not", null)]))
          .limit(limit),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
