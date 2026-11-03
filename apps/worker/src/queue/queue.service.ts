import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { createStorage } from "@tg/media";
import { createErrorTracker, type ErrorTracker } from "@tg/server-config";
import type { WorkerEnv } from "../config.js";
import { createWorkerDb, type WorkerDb, type WorkerDbOptions } from "../db/worker-db.js";
import { deadLetterPurger } from "./dead-letter.js";
import { createHandlers } from "./handlers.js";
import { startQueueRuntime, type QueueRuntime, type QueueRuntimeOptions } from "./runtime.js";
import {
  AUDIT_PII_PURGE_SCHEDULE,
  BOOKINGS_PROCESS_DUE_SCHEDULE,
  DEAD_LETTER_PURGE_SCHEDULE,
  SCHEDULES,
  SERVICE_REQUESTS_ANONYMIZE_SCHEDULE,
} from "./schedules.js";

export const WORKER_ENV = Symbol("WORKER_ENV");
export const QUEUE_RUNTIME_FACTORY = Symbol("QUEUE_RUNTIME_FACTORY");
export const WORKER_DB_FACTORY = Symbol("WORKER_DB_FACTORY");
export type QueueRuntimeFactory = (options: QueueRuntimeOptions) => Promise<QueueRuntime>;
/** Доступ к БД по строке подключения (очистка ПДн аудита, запись событий); тесты подменяют. */
export type WorkerDbFactory = (databaseUrl: string, options?: WorkerDbOptions) => WorkerDb;

/**
 * Запускает воркеры при старте приложения и закрывает их при остановке (SIGTERM → app.close()).
 * Открытые соединения Redis удерживают процесс, пока воркеры не закрыты.
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Queue");
  private runtime: QueueRuntime | undefined;
  private closeDb: (() => Promise<void>) | undefined;

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(QUEUE_RUNTIME_FACTORY) private readonly factory: QueueRuntimeFactory,
    @Inject(WORKER_DB_FACTORY) private readonly dbFactory: WorkerDbFactory,
  ) {
    this.errorTracker = createErrorTracker({
      service: "worker",
      environment: env.APP_ENV,
      dsn: env.SENTRY_DSN,
      logger: this.logger,
    });
  }

  /** Трекер ошибок воркера (T1-18): окончательно упавшие задачи; main.ts — необработанные ошибки процесса. */
  readonly errorTracker: ErrorTracker;

  async onApplicationBootstrap(): Promise<void> {
    // Задачи с БД (очистка ПДн аудита, запись событий) — только при DATABASE_URL; без него расписание очистки
    // не ставится, а задачи analytics.record падают без ретраев в dead-letter.
    const db = this.env.DATABASE_URL
      ? this.dbFactory(this.env.DATABASE_URL, {
          serviceRequestRetentionDays: this.env.SERVICE_REQUEST_RETENTION_DAYS,
          telegramBotToken: this.env.TELEGRAM_BOT_TOKEN,
        })
      : undefined;
    if (!db)
      this.logger.warn(
        "DATABASE_URL не задан: очистка ПДн аудита не запускается, события аналитики не пишутся",
      );
    this.closeDb = db?.close;
    try {
      this.runtime = await this.factory({
        redisUrl: this.env.REDIS_URL,
        handlers: createHandlers({
          auditPii: db?.purger,
          serviceRequests: db?.serviceRequests,
          bookings: db?.bookings,
          analytics: db?.analytics,
          // Очередь dead-letter открывает рантайм — геттер читает её на момент задачи.
          deadLetter: deadLetterPurger(() => this.runtime?.deadLetter),
          // Ресайз фото (T1-20): хранилище из STORAGE_*/S3_* (ссылок worker не выдаёт — адрес api не нужен).
          media: db
            ? { assets: db.media, storage: createStorage(this.env, "http://worker.invalid").driver }
            : undefined,
        }),
        schedules: [
          ...SCHEDULES,
          DEAD_LETTER_PURGE_SCHEDULE,
          ...(db
            ? [AUDIT_PII_PURGE_SCHEDULE, SERVICE_REQUESTS_ANONYMIZE_SCHEDULE, BOOKINGS_PROCESS_DUE_SCHEDULE]
            : []),
        ],
        logger: this.logger,
        errorTracker: this.errorTracker,
        metricsIntervalMs: this.env.QUEUE_METRICS_INTERVAL_MS,
      });
    } catch (err) {
      await this.closeDatabase();
      throw err;
    }
    this.logger.log(`Воркеры запущены: ${this.runtime.workers.map((w) => w.name).join(", ")}`);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (this.runtime) {
      this.logger.log(`Остановка воркеров${signal ? ` (${signal})` : ""}…`);
      await this.runtime.close();
      this.runtime = undefined;
    }
    // После воркеров: текущие задачи могли ещё обращаться к БД.
    await this.closeDatabase();
    await this.errorTracker.flush(2000);
  }

  private async closeDatabase(): Promise<void> {
    const close = this.closeDb;
    this.closeDb = undefined;
    await close?.();
  }

  /** Рантайм после старта (для продюсеров внутри worker). */
  get current(): QueueRuntime | undefined {
    return this.runtime;
  }
}

export const defaultQueueRuntimeFactory: QueueRuntimeFactory = startQueueRuntime;
export const defaultWorkerDbFactory: WorkerDbFactory = createWorkerDb;
