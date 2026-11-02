// Загрузчики родителя области из БД (ScopeParentLoaders). Читают функциями БД в режиме SYSTEM (миграции 0015, 0017):
// объект может быть в другом регионе, чем транзакция запроса, а вызов идёт и вне неё (guard, назначение роли).
import { sql } from "kysely";
import { currentDb, type Db } from "../../db/index.js";
import { regionScope, scope, type ScopeParentLoader, type ScopeParentLoaders } from "./scope.js";

/** Место → его организация (место партнёра, блок 6) или регион (место админки и импорта). */
export function placeParentLoader(db: Db): ScopeParentLoader {
  return async (id) => {
    // Функция возвращает 0 или 1 строку: место не найдено — строки нет.
    const row = await currentDb(db)
      .selectNoFrom([
        sql<string | null>`(app_place_parent(${id}::uuid)).organization_id`.as("organization_id"),
        sql<string | null>`(app_place_parent(${id}::uuid)).region_id`.as("region_id"),
      ])
      .executeTakeFirst();
    if (!row?.region_id) return undefined;
    return row.organization_id ? scope("ORGANIZATION", row.organization_id) : regionScope(row.region_id);
  };
}

/** Организация → её регион. */
export function organizationParentLoader(db: Db): ScopeParentLoader {
  return async (id) => {
    const row = await currentDb(db)
      .selectNoFrom(sql<string | null>`app_organization_region(${id}::uuid)`.as("region_id"))
      .executeTakeFirst();
    return row?.region_id ? regionScope(row.region_id) : undefined;
  };
}

/** Загрузчики БД для всех уровней с таблицами: PLACE → ORGANIZATION | REGION, ORGANIZATION → REGION. */
export function dbScopeParentLoaders(db: Db): ScopeParentLoaders {
  return { PLACE: placeParentLoader(db), ORGANIZATION: organizationParentLoader(db) };
}
