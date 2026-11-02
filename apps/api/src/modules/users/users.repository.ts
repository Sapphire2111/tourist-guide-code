import { Injectable } from "@nestjs/common";
import {
  currentDb,
  hasValues,
  InjectDb,
  type Db,
  type NewUser,
  type User,
  type UserUpdate,
} from "../../db/index.js";

/**
 * Доступ к users (глобальная сущность). Без бизнес-правил: блокировка, анонимизация и связь с Telegram —
 * в задачах блоков 1–2.
 * Запросы — через currentDb(): внутри withTenant() это транзакция запроса; своя db.transaction() там запрещена.
 */
@Injectable()
export class UsersRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Без полей — `INSERT ... DEFAULT VALUES` (все колонки по умолчанию: язык uk, статус active). */
  create(user: NewUser = {}): Promise<User> {
    const insert = currentDb(this.db).insertInto("users");
    return (hasValues(user) ? insert.values(user) : insert.defaultValues())
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  findById(id: string): Promise<User | undefined> {
    return currentDb(this.db).selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /**
   * Блокировка строки пользователя до конца транзакции (FOR NO KEY UPDATE: не мешает вставкам со ссылкой на users —
   * FK берут KEY SHARE). Сериализует изменения состояния пользователя, которые читают и пишут несколько строк
   * (разрешения боту: service/marketing). Только внутри транзакции; нет пользователя — false.
   */
  async lockForUpdate(id: string): Promise<boolean> {
    const row = await currentDb(this.db)
      .selectFrom("users")
      .select("id")
      .where("id", "=", id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Пустой patch (нет полей или все undefined) ничего не меняет и возвращает текущую запись. */
  update(id: string, patch: UserUpdate): Promise<User | undefined> {
    if (!hasValues(patch)) return this.findById(id);
    return currentDb(this.db)
      .updateTable("users")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }
}
