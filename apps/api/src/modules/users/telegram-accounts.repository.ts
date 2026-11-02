import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  type Db,
  type NewTelegramAccount,
  type TelegramAccount,
  type TelegramAccountUpdate,
} from "../../db/index.js";

/**
 * Доступ к telegram_accounts (global, миграция 0010): привязка пользователя к Telegram, 1:1. ПДн — не логировать.
 * Запросы — через currentDb(): внутри withTenant() это транзакция запроса.
 */
@Injectable()
export class TelegramAccountsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  findByTelegramUserId(telegramUserId: number): Promise<TelegramAccount | undefined> {
    return currentDb(this.db)
      .selectFrom("telegram_accounts")
      .selectAll()
      .where("telegram_user_id", "=", String(telegramUserId))
      .executeTakeFirst();
  }

  findByUserId(userId: string): Promise<TelegramAccount | undefined> {
    return currentDb(this.db)
      .selectFrom("telegram_accounts")
      .selectAll()
      .where("user_id", "=", userId)
      .executeTakeFirst();
  }

  /** Уже есть аккаунт с этим telegram_user_id или user_id — ошибка 23505 (вызывающий повторяет вход). */
  create(account: NewTelegramAccount): Promise<TelegramAccount> {
    return currentDb(this.db)
      .insertInto("telegram_accounts")
      .values(account)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  update(id: string, patch: TelegramAccountUpdate): Promise<TelegramAccount | undefined> {
    return currentDb(this.db)
      .updateTable("telegram_accounts")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }
}
