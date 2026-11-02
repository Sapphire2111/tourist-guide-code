import { Injectable } from "@nestjs/common";
import type { AnalyticsEventRow } from "@tg/queue-contract";
import { currentDb, InjectDb, type AnalyticsEvent, type Db, type NewAnalyticsEvent } from "../../db/index.js";

export type ListAnalyticsEventsOptions = {
  /** occurred_at >= since. */
  since?: Date;
  /** occurred_at < until. */
  until?: Date;
  /** По умолчанию 100. */
  limit?: number;
};

/**
 * Запись и чтение продуктовых событий. Tenant-optional (ADR-006): вызывается в withTenant() — контекст региона
 * пишет и читает только свой регион (region_id из контекста), события гостя без региона (NULL) пишет и видит
 * только SYSTEM/PLATFORM. Каталог и валидация событий — @tg/shared (analytics.ts), запись — AnalyticsService (T1-25).
 */
@Injectable()
export class AnalyticsEventsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  insert(event: NewAnalyticsEvent): Promise<AnalyticsEvent> {
    return currentDb(this.db)
      .insertInto("analytics_events")
      .values(event)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Запись проверенного события функцией БД analytics_record_event (миграция 0007): идемпотентно по id,
   * от имени SYSTEM (RLS), без tenant-контекста. true — вставлено, false — уже было.
   */
  async record(row: AnalyticsEventRow): Promise<boolean> {
    const result = await currentDb(this.db)
      .selectNoFrom((eb) =>
        eb.fn<boolean>("analytics_record_event", [eb.val(JSON.stringify(row))]).as("inserted"),
      )
      .executeTakeFirstOrThrow();
    return result.inserted === true;
  }

  /**
   * Какие из регионов существуют (regions — global, без tenant-фильтра). lock — FOR KEY SHARE до конца транзакции:
   * найденный регион нельзя удалить, пока не записаны ссылающиеся на него события (вызывать в транзакции).
   */
  async existingRegionIds(
    ids: readonly string[],
    { lock = false }: { lock?: boolean } = {},
  ): Promise<Set<string>> {
    const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
    if (unique.length === 0) return new Set();
    let q = currentDb(this.db).selectFrom("regions").select("id").where("id", "in", unique);
    if (lock) q = q.forKeyShare();
    return new Set((await q.execute()).map((r) => r.id.toLowerCase()));
  }

  /** События одного имени по времени (индекс event_name, occurred_at). */
  listByName(
    eventName: string,
    { since, until, limit = 100 }: ListAnalyticsEventsOptions = {},
  ): Promise<AnalyticsEvent[]> {
    let q = currentDb(this.db).selectFrom("analytics_events").selectAll().where("event_name", "=", eventName);
    if (since) q = q.where("occurred_at", ">=", since);
    if (until) q = q.where("occurred_at", "<", until);
    return q.orderBy("occurred_at").orderBy("id").limit(limit).execute();
  }
}
