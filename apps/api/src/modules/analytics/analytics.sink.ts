import { Logger, type OnApplicationShutdown } from "@nestjs/common";
import {
  JOBS,
  QUEUES,
  enqueue,
  systemContext,
  toAnalyticsEventRow,
  type ProducerQueue,
} from "@tg/queue-contract";
import type { AnalyticsEvent } from "@tg/shared";
import { Queue } from "bullmq";
import { currentDb, type Db } from "../../db/index.js";
import { AnalyticsEventsRepository } from "./analytics-events.repository.js";

/**
 * Куда уходит проверенное событие. regionId всего пакета проверяется до записи (несуществующий —
 * AnalyticsUnknownRegionError, ничего не пишется). direct — пакет одной транзакцией; queue — задача на событие
 * (сбой Redis посреди пакета может оставить часть задач: повтор клиента с теми же eventId дублей не создаёт).
 */
export interface AnalyticsSink {
  write(events: readonly AnalyticsEvent[]): Promise<void>;
}
export const ANALYTICS_SINK = Symbol("ANALYTICS_SINK");

/**
 * queue — задача analytics.record в очередь BullMQ (Redis), запись в БД делает worker (prod, local с worker).
 * direct — запись в БД сразу в процессе api (staging на Render free: отдельного worker нет; тесты без Redis).
 */
export type AnalyticsSinkMode = "queue" | "direct";

/** В событиях пакета указан несуществующий regionId (indices — номера событий в пакете). Ничего не записано. */
export class AnalyticsUnknownRegionError extends Error {
  override readonly name = "AnalyticsUnknownRegionError";
  constructor(readonly indices: readonly number[]) {
    super(`Несуществующий regionId в событиях пакета: ${indices.join(", ")}`);
  }
}

/** Какие регионы из набора существуют (id в нижнем регистре). */
type RegionLookup = (ids: readonly string[]) => Promise<ReadonlySet<string>>;

/** Проверка regionId всех событий пакета одним запросом; есть несуществующие — AnalyticsUnknownRegionError. */
async function assertRegionsExist(events: readonly AnalyticsEvent[], lookup: RegionLookup): Promise<void> {
  const ids = events.flatMap((e) => (e.regionId == null ? [] : [e.regionId]));
  if (ids.length === 0) return;
  const existing = await lookup(ids);
  const missing = events.flatMap((e, i) =>
    e.regionId != null && !existing.has(e.regionId.toLowerCase()) ? [i] : [],
  );
  if (missing.length) throw new AnalyticsUnknownRegionError(missing);
}

/**
 * Очередь: одна задача на событие, jobId из eventId — повтор отправки того же события не ставит вторую задачу,
 * пока первая хранится в Redis; окончательная защита от дубля — ON CONFLICT (id) в БД.
 * Контекст задачи — SYSTEM региона события (актор пользователя в очередь не передаётся, ADR-0008).
 * regionId проверяется до постановки (весь пакет отклоняется); регион, удалённый между проверкой и записью,
 * worker получит как нарушение FK (23503) — постоянная ошибка, задача сразу уходит в dead-letter.
 */
export class QueueAnalyticsSink implements AnalyticsSink, OnApplicationShutdown {
  constructor(
    private readonly queue: ProducerQueue & { close?(): Promise<void> },
    private readonly regions: RegionLookup,
  ) {}

  static open(
    redisUrl: string,
    repo: Pick<AnalyticsEventsRepository, "existingRegionIds">,
  ): QueueAnalyticsSink {
    const queue = new Queue(QUEUES.analytics, { connection: { url: redisUrl } });
    const logger = new Logger("AnalyticsQueue");
    queue.on("error", (err) => logger.error(`Очередь ${QUEUES.analytics}: ${err.message}`));
    return new QueueAnalyticsSink(queue, (ids) => repo.existingRegionIds(ids));
  }

  async write(events: readonly AnalyticsEvent[]): Promise<void> {
    await assertRegionsExist(events, this.regions);
    await Promise.all(
      events.map((event) =>
        enqueue(
          { [QUEUES.analytics]: this.queue },
          JOBS.analyticsRecord,
          { context: systemContext(event.regionId), payload: { event } },
          { idempotencyKey: event.eventId },
        ),
      ),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close?.();
  }
}

/**
 * Прямая запись функцией БД (идемпотентно по eventId) — пакет одной транзакцией: проверка regionId с блокировкой
 * регионов (FOR KEY SHARE: удалить их до COMMIT нельзя — без гонок) и вставка всех событий; любая ошибка —
 * ROLLBACK всего пакета. Внутри уже открытой транзакции (withTenant() запроса) пишет в ней.
 */
export class DirectAnalyticsSink implements AnalyticsSink {
  constructor(private readonly db: Db) {}

  async write(events: readonly AnalyticsEvent[]): Promise<void> {
    const run = async (trx: Db) => {
      const repo = new AnalyticsEventsRepository(trx);
      await assertRegionsExist(events, (ids) => repo.existingRegionIds(ids, { lock: true }));
      for (const e of events) await repo.record(toAnalyticsEventRow(e));
    };
    const outer = currentDb(this.db);
    await (outer.isTransaction ? run(outer) : this.db.transaction().execute(run));
  }
}
