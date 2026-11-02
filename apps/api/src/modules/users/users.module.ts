import { Module } from "@nestjs/common";
import { TelegramAccountsRepository } from "./telegram-accounts.repository.js";
import { UsersRepository } from "./users.repository.js";

/** Контекст users: пользователи (T1-09) и привязка к Telegram (блок 2); Db — из глобального DatabaseModule. */
@Module({
  providers: [UsersRepository, TelegramAccountsRepository],
  exports: [UsersRepository, TelegramAccountsRepository],
})
export class UsersModule {}
