import { Injectable } from "@nestjs/common";
import {
  currentDb,
  hasValues,
  InjectDb,
  type Db,
  type NewRegion,
  type Region,
  type RegionUpdate,
} from "../../db/index.js";

/**
 * Доступ к regions (глобальный справочник, PLATFORM). Без бизнес-правил: переходы статусов, запрет
 * удаления (только suspend) и права — в сервисах блока 3.
 * Запросы — через currentDb(): внутри withTenant() это транзакция запроса; своя db.transaction() там запрещена.
 */
@Injectable()
export class RegionsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  create(region: NewRegion): Promise<Region> {
    return currentDb(this.db).insertInto("regions").values(region).returningAll().executeTakeFirstOrThrow();
  }

  findById(id: string): Promise<Region | undefined> {
    return currentDb(this.db).selectFrom("regions").selectAll().where("id", "=", id).executeTakeFirst();
  }

  findByCode(code: string): Promise<Region | undefined> {
    return currentDb(this.db).selectFrom("regions").selectAll().where("code", "=", code).executeTakeFirst();
  }

  /** Все регионы по коду (справочник небольшой — без пагинации). */
  list(): Promise<Region[]> {
    return currentDb(this.db).selectFrom("regions").selectAll().orderBy("code").execute();
  }

  /** Пустой patch (нет полей или все undefined) ничего не меняет и возвращает текущую запись. */
  update(id: string, patch: RegionUpdate): Promise<Region | undefined> {
    if (!hasValues(patch)) return this.findById(id);
    return currentDb(this.db)
      .updateTable("regions")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }
}
