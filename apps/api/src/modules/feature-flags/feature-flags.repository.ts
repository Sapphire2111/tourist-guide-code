import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  type Db,
  type FeatureFlagGateMark,
  type FeatureFlagRow,
} from "../../db/index.js";

/**
 * Переопределения фича-флагов и отметки финансового гейта (global-таблицы, миграция 0008). Без правил: кто и когда
 * может менять — FeatureFlagsService. Запросы — через currentDb(): внутри withTenant() — транзакция запроса.
 */
@Injectable()
export class FeatureFlagsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Переопределения на окружение (target_region_id NULL) и, если задан, на регион. */
  overridesFor(regionId: string | null): Promise<FeatureFlagRow[]> {
    return currentDb(this.db)
      .selectFrom("feature_flags")
      .selectAll()
      .where((eb) =>
        regionId === null
          ? eb("target_region_id", "is", null)
          : eb.or([eb("target_region_id", "is", null), eb("target_region_id", "=", regionId)]),
      )
      .orderBy("key")
      .execute();
  }

  /** Все переопределения (админский список; флагов и регионов немного — без пагинации). */
  listAll(): Promise<FeatureFlagRow[]> {
    return currentDb(this.db)
      .selectFrom("feature_flags")
      .selectAll()
      .orderBy("key")
      .orderBy("target_region_id", (ob) => ob.nullsFirst())
      .execute();
  }

  /**
   * Транзакционная advisory-блокировка пары (флаг, регион) до конца транзакции: изменения одной пары идут по
   * очереди, поэтому старое значение для аудита читается верно и при первой установке (строки ещё нет — FOR UPDATE
   * её не заблокирует).
   */
  async lock(key: string, regionId: string | null): Promise<void> {
    await currentDb(this.db)
      .selectNoFrom((eb) =>
        eb
          .fn("pg_advisory_xact_lock", [eb.fn("hashtext", [eb.val(`feature_flag:${key}:${regionId ?? ""}`)])])
          .as("locked"),
      )
      .execute();
  }

  /** Переопределение (флаг, регион) с блокировкой строки до конца транзакции. */
  find(key: string, regionId: string | null): Promise<FeatureFlagRow | undefined> {
    return currentDb(this.db)
      .selectFrom("feature_flags")
      .selectAll()
      .where("key", "=", key)
      .where("target_region_id", regionId === null ? "is" : "=", regionId)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Создать или изменить переопределение (уникальный индекс (key, target_region_id) NULLS NOT DISTINCT). */
  upsert(key: string, regionId: string | null, enabled: boolean, by: string | null): Promise<FeatureFlagRow> {
    return currentDb(this.db)
      .insertInto("feature_flags")
      .values({ key, target_region_id: regionId, enabled, updated_by: by })
      .onConflict((oc) => oc.columns(["key", "target_region_id"]).doUpdateSet({ enabled, updated_by: by }))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Удалить переопределение (сброс к значению по умолчанию окружения); удалённая строка или undefined. */
  remove(key: string, regionId: string | null): Promise<FeatureFlagRow | undefined> {
    return currentDb(this.db)
      .deleteFrom("feature_flags")
      .where("key", "=", key)
      .where("target_region_id", regionId === null ? "is" : "=", regionId)
      .returningAll()
      .executeTakeFirst();
  }

  gateMarks(): Promise<FeatureFlagGateMark[]> {
    return currentDb(this.db).selectFrom("feature_flag_gate_marks").selectAll().orderBy("decision").execute();
  }

  /** Отметка о закрытии решения; уже отмеченное — undefined (отметка неизменяема). */
  addGateMark(
    decision: string,
    documentRef: string,
    by: string | null,
  ): Promise<FeatureFlagGateMark | undefined> {
    return currentDb(this.db)
      .insertInto("feature_flag_gate_marks")
      .values({ decision, document_ref: documentRef, marked_by: by })
      .onConflict((oc) => oc.column("decision").doNothing())
      .returningAll()
      .executeTakeFirst();
  }
}
