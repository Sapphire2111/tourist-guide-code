// Фоновые задачи воркера в процессе api (staging, Render free: отдельный Background Worker платный).
// Включается WORKER_IN_PROCESS=true. Сейчас — только bookings.process-due (сроки броней, напоминания, отправка
// outbox воркера) раз в минуту, тем же кодом, что и воркер (@tg/queue-contract → bookingsDueProcessor).
//
// Несколько экземпляров api (или api + воркер) не выполняют тик одновременно: транзакционный advisory lock
// (pg_try_advisory_xact_lock) на отдельном соединении держится, пока идёт тик; кто не взял — пропускает тик.
// Транзакционный, а не сессионный: с пулером Neon (PgBouncer, transaction mode) сессионный lock не держится, а открытая
// транзакция закрепляет за собой серверное соединение. Сама обработка — на другом соединении, своими короткими
// транзакциями функций БД (как в воркере: отметки outbox фиксируются сразу, повтор не дублирует отправку).
//
// HTTP не блокируется: тик — асинхронные запросы в БД и fetch к Bot API на отдельном маленьком пуле; таймер unref.
// Засыпание Render free: пока api спит (15 мин без HTTP), тиков нет — сроки и напоминания обработаются после
// пробуждения (функции БД наверстают пропущенное, напоминания — в пределах своих окон). Нужен внешний keep-alive.
import {
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import pg from "pg";
import {
  BOOKINGS_PROCESS_DUE_EVERY_MS,
  BotApiTelegramSender,
  bookingsDueProcessor,
  type BookingsDueProcessor,
  type RowsQueryable,
} from "@tg/queue-contract";
import { onActiveClientError, onIdleClientError } from "./database.js";

/** Ключ advisory lock тика (произвольная константа проекта; одна на все экземпляры). */
export const IN_PROCESS_JOBS_LOCK_KEY = 7_340_001;

/** Соединение, на котором держится транзакционный lock. */
export interface LockClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(err?: Error | boolean): void;
}

export interface InProcessJobsDeps {
  /** Отдельное соединение под lock. */
  connect(): Promise<LockClient>;
  bookings: BookingsDueProcessor;
  logger: Pick<Logger, "log" | "warn" | "error">;
  everyMs?: number;
}

export type TickResult = "done" | "locked" | "busy" | "failed";

/** Периодический запуск задач под advisory lock; тик не перекрывается следующим в этом же процессе. */
export class InProcessJobsRunner {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<TickResult> | null = null;

  constructor(private readonly deps: InProcessJobsDeps) {}

  start(): void {
    if (this.timer) return;
    const every = this.deps.everyMs ?? BOOKINGS_PROCESS_DUE_EVERY_MS;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
    this.deps.logger.log(
      `Фоновые задачи в процессе api включены: bookings.process-due каждые ${every / 1000} с`,
    );
  }

  /** Остановка: новые тики не начинаются, текущий дожидаемся. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  tick(): Promise<TickResult> {
    if (this.running) return Promise.resolve("busy");
    this.running = this.runLocked().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runLocked(): Promise<TickResult> {
    let client: LockClient;
    try {
      client = await this.deps.connect();
    } catch (err) {
      this.deps.logger.warn(`bookings.process-due: нет соединения с БД (${errorText(err)})`);
      return "failed";
    }
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [
        IN_PROCESS_JOBS_LOCK_KEY,
      ]);
      if (rows[0]?.ok !== true) {
        await client.query("ROLLBACK");
        return "locked";
      }
      try {
        const r = await this.deps.bookings.processDue();
        const n = r.notifications;
        if (r.expired + r.completed + r.reminded + n.sent + n.failed + n.skipped + n.retried > 0)
          this.deps.logger.log(
            `bookings.process-due: expired=${r.expired} completed=${r.completed} reminded=${r.reminded} ` +
              `sent=${n.sent} failed=${n.failed} skipped=${n.skipped} retried=${n.retried}`,
          );
        return "done";
      } catch (err) {
        this.deps.logger.error(`bookings.process-due: ошибка (${errorText(err)})`);
        return "failed";
      } finally {
        await client.query("COMMIT"); // снимает lock
      }
    } catch (err) {
      broken = err instanceof Error ? err : new Error(String(err));
      this.deps.logger.warn(`bookings.process-due: advisory lock (${errorText(err)})`);
      return "failed";
    } finally {
      client.release(broken);
    }
  }
}

/** Текст ошибки без секретов: только сообщение, обрезанное (Bot API уже без токена, pg — без строки подключения). */
function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export type InProcessJobsOptions = { connectionString: string; telegramBotToken?: string };

const RUNNER = Symbol("IN_PROCESS_JOBS_RUNNER");

@Injectable()
class InProcessJobsLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly runner: InProcessJobsRunner,
    private readonly pool: pg.Pool,
  ) {}

  onApplicationBootstrap(): void {
    this.runner.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runner.stop();
    await this.pool.end();
  }
}

/** Модуль фоновых задач в процессе api: подключается в AppModule только при WORKER_IN_PROCESS=true. */
@Module({})
export class InProcessJobsModule {
  static forRoot(options: InProcessJobsOptions): DynamicModule {
    return {
      module: InProcessJobsModule,
      providers: [
        {
          provide: pg.Pool,
          useFactory: () => {
            // Свой маленький пул: lock + обработка; запросы HTTP идут через основной пул и не ждут тик.
            const pool = new pg.Pool({
              connectionString: options.connectionString,
              max: 2,
              application_name: "tg-api-jobs",
              keepAlive: true,
              connectionTimeoutMillis: 10_000,
            });
            pool.on("error", onIdleClientError);
            pool.on("connect", (client) => client.on("error", onActiveClientError));
            return pool;
          },
        },
        {
          provide: RUNNER,
          inject: [pg.Pool],
          useFactory: (pool: pg.Pool) =>
            new InProcessJobsRunner({
              connect: () => pool.connect(),
              bookings: bookingsDueProcessor(pool as RowsQueryable, {
                sender: options.telegramBotToken ? new BotApiTelegramSender(options.telegramBotToken) : null,
              }),
              logger: new Logger("InProcessJobs"),
            }),
        },
        {
          provide: InProcessJobsLifecycle,
          inject: [RUNNER, pg.Pool],
          useFactory: (runner: InProcessJobsRunner, pool: pg.Pool) =>
            new InProcessJobsLifecycle(runner, pool),
        },
      ],
    };
  }
}
