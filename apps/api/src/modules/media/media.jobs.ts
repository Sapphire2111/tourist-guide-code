import { AsyncResource } from "node:async_hooks";
import { Logger, type OnApplicationShutdown } from "@nestjs/common";
import { ImageRejectError, INLINE_MAX_INPUT_PIXELS, processImage, type Storage } from "@tg/media";
import { enqueue, JOBS, QUEUES, systemContext, type ProducerQueue } from "@tg/queue-contract";
import { Queue } from "bullmq";
import { regionContext, withTenant, type Db } from "../../db/index.js";
import { MediaRepository } from "./media.repository.js";

/**
 * Режим ресайза фото после подтверждения загрузки: queue — задача media.process-image в worker; inline — фоновая
 * обработка в процессе api (staging на Render free: отдельного worker нет).
 */
export type MediaProcessingMode = "queue" | "inline";

export const MEDIA_JOBS = Symbol("MEDIA_JOBS");

export interface MediaJobRef {
  id: string;
  regionId: string;
  /** Повторный запуск зависшей обработки: новая задача, а не no-op по старому jobId. */
  restart?: boolean;
}

/** Постановка ресайза. Вызывается внутри транзакции запроса; сама обработка — после неё. */
export interface MediaJobs {
  enqueueProcessing(asset: MediaJobRef): Promise<void>;
}

/**
 * Очередь media (Redis). jobId из id файла: повторное подтверждение не ставит вторую задачу; перезапуск зависшей —
 * с суффиксом времени. Задача может начаться до COMMIT подтверждения — worker видит pending и повторяет попытку.
 */
export class QueueMediaJobs implements MediaJobs, OnApplicationShutdown {
  constructor(private readonly queue: ProducerQueue & { close?(): Promise<void> }) {}

  static open(redisUrl: string): QueueMediaJobs {
    const queue = new Queue(QUEUES.media, { connection: { url: redisUrl } });
    const logger = new Logger("MediaQueue");
    queue.on("error", (err) => logger.error(`Очередь ${QUEUES.media}: ${err.message}`));
    return new QueueMediaJobs(queue);
  }

  async enqueueProcessing({ id, regionId, restart }: MediaJobRef): Promise<void> {
    await enqueue(
      { [QUEUES.media]: this.queue },
      JOBS.mediaProcessImage,
      { context: systemContext(regionId), payload: { assetId: id } },
      { idempotencyKey: restart ? `${id}-r${Date.now()}` : id },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close?.();
  }
}

/** Пауза между попытками, пока подтверждение не закоммичено (pending), и их число. */
const PENDING_RETRY_MS = 500;
const PENDING_RETRIES = 20;

/**
 * Ресайз в процессе api (inline) — то же, что задача worker, но:
 * - строго по одному (семафор на 1: на Render free 512 МБ), sharp — один поток без кеша, предел 24 Мпикс;
 * - вне транзакции запроса: задача стартует в «чистом» асинхронном контексте (без tenant-контекста запроса), строка
 *   меняется короткими транзакциями региона, ресайз — между ними, без занятого соединения с БД;
 * - оригинал удаляется после COMMIT отметки ready/rejected.
 * Сбой процесса посреди обработки оставит uploaded/processing — повторное подтверждение через 10 мин запустит заново.
 */
export class InlineMediaJobs implements MediaJobs, OnApplicationShutdown {
  private readonly logger = new Logger("MediaInline");
  /** Контекст на момент создания провайдера — без транзакции и tenant-контекста запроса. */
  private readonly root = new AsyncResource("media-inline");
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms).unref()),
  ) {}

  async enqueueProcessing(asset: MediaJobRef): Promise<void> {
    if (this.closed) return;
    this.root.runInAsyncScope(() => {
      this.tail = this.tail.then(() =>
        this.process(asset).catch((err: Error) =>
          this.logger.error(`Ресайз ${asset.id} не выполнен: ${err.message}`),
        ),
      );
    });
  }

  /** Дождаться текущих задач (тесты, остановка). */
  idle(): Promise<void> {
    return this.tail;
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  private inRegion<T>(regionId: string, fn: (repo: MediaRepository) => Promise<T>): Promise<T> {
    return withTenant(this.db, regionContext(regionId), () => fn(new MediaRepository(this.db)));
  }

  private async process({ id, regionId }: MediaJobRef): Promise<void> {
    let row;
    for (let attempt = 0; ; attempt++) {
      row = await this.inRegion(regionId, (repo) => repo.claim(id));
      if (row?.status !== "pending" || attempt >= PENDING_RETRIES) break;
      await this.sleep(PENDING_RETRY_MS);
    }
    if (!row) return;
    const driver = this.storage.driver;
    if (row.status === "ready") return driver.delete(row.original_key);
    if (row.status !== "processing") return;
    let marked;
    try {
      const result = await processImage(
        driver,
        { id, regionId, originalKey: row.original_key, mime: row.mime },
        { maxPixels: INLINE_MAX_INPUT_PIXELS },
      );
      marked = await this.inRegion(regionId, (repo) =>
        repo.update(id, ["processing"], {
          status: "ready",
          width: result.width,
          height: result.height,
          variants: result.variants,
        }),
      );
    } catch (err) {
      if (!(err instanceof ImageRejectError)) throw err;
      this.logger.warn(`Файл ${id} отклонён: ${err.reason}`);
      marked = await this.inRegion(regionId, (repo) =>
        repo.update(id, ["processing"], { status: "rejected", reject_reason: err.reason }),
      );
    }
    // Только если отметка применилась (иначе строку уже отметила другая задача — она и удалит) и после её COMMIT:
    // откат не оставит строку без исходника.
    if (marked) await driver.delete(row.original_key);
  }
}
