// Загрузчики родителя области из БД (ScopeParentLoaders). Читают функцией БД в режиме SYSTEM (миграция 0015): объект
// может быть в другом регионе, чем транзакция запроса, а вызов идёт и вне неё (guard, назначение роли).
import { sql } from "kysely";
import { currentDb, type Db } from "../../db/index.js";
import { regionScope, type ScopeParentLoader } from "./scope.js";

/** Место → его регион (организаций пока нет — блок 6 вставит ORGANIZATION между ними). */
export function placeParentLoader(db: Db): ScopeParentLoader {
  return async (id) => {
    const row = await currentDb(db)
      .selectNoFrom(sql<string | null>`app_place_region(${id}::uuid)`.as("region_id"))
      .executeTakeFirst();
    return row?.region_id ? regionScope(row.region_id) : undefined;
  };
}
