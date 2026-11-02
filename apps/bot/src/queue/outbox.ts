import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { BotApiError, type BotApiClient } from "../telegram/bot-api.js";
import { BOT_JOB_OPTIONS, BOT_JOBS, BOT_QUEUE, type SendMessageJob } from "./contract.js";

/** Минимальный логгер (совместим с Nest Logger). */
export interface OutboxLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Таймаут постановки задачи и шага остановки, мс. */
export const OUTBOX_TIMEOUT_MS = 5_000;

const TIMEOUT = Symbol("timeout");

/** Ждёт промис не дольше ms; таймер не держит процесс. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Очередь исходящих сообщений: обработчик апдейта только ставит задачу. */
export interface Outbox {
  sendMessage(job: SendMessageJob, jobId?: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Обработчик задачи sendMessage. 4xx Bot API (кроме 429) — UnrecoverableError: повтор бессмыслен
 * (бот заблокирован, чат не найден). Логи — без текста и chat_id.
 */
export function createSendMessageProcessor(client: BotApiClient) {
  return async (data: SendMessageJob): Promise<void> => {
    try {
      await client.sendMessage(data);
    } catch (err) {
      if (err instanceof BotApiError && !err.retryable) throw new UnrecoverableError(err.message);
      throw err;
    }
  };
}

/** Очередь BullMQ в Redis + воркер в процессе бота. */
export class BullOutbox implements Outbox {
  private readonly queue: Queue;
  private readonly worker: Worker;

  constructor(
    redisUrl: string,
    processJob: (data: SendMessageJob) => Promise<void>,
    private readonly logger: OutboxLogger,
    private readonly timeoutMs = OUTBOX_TIMEOUT_MS,
  ) {
    const connection = { url: redisUrl };
    this.queue = new Queue(BOT_QUEUE, { connection });
    this.worker = new Worker(BOT_QUEUE, (job: Job) => processJob(job.data as SendMessageJob), {
      connection,
      concurrency: 5,
    });
    this.queue.on("error", (err) => logger.error(`Очередь ${BOT_QUEUE}: ${err.message}`));
    this.worker.on("error", (err) => logger.error(`Воркер ${BOT_QUEUE}: ${err.message}`));
    this.worker.on("failed", (job, err) =>
      logger.warn(`Задача ${BOT_QUEUE}/${job?.name ?? "?"}#${job?.id ?? "?"} упала: ${err.message}`),
    );
  }

  /** Постановка не дольше timeoutMs: при недоступном Redis webhook быстро отвечает 500, Telegram повторит. */
  async sendMessage(job: SendMessageJob, jobId?: string): Promise<void> {
    const added = this.queue.add(BOT_JOBS.sendMessage, job, {
      ...BOT_JOB_OPTIONS,
      ...(jobId ? { jobId } : {}),
    });
    added.catch(() => {}); // результат после таймаута не нужен, но и unhandled rejection не нужен
    if ((await within(added, this.timeoutMs)) === TIMEOUT) {
      throw new Error(`Очередь ${BOT_QUEUE}: постановка не уложилась в ${this.timeoutMs} мс`);
    }
  }

  /**
   * Остановка по образцу apps/worker/src/queue/close.ts: каждый шаг (воркер, затем очередь) ограничен
   * таймаутом, по истечении — принудительный disconnect. Прерванная задача станет stalled и повторится.
   */
  async close(): Promise<void> {
    for (const [kind, item] of [
      ["воркер", this.worker],
      ["очередь", this.queue],
    ] as const) {
      const graceful = await within(
        item.close().catch((err: Error) => this.logger.error(`Закрытие (${kind}): ${err.message}`)),
        this.timeoutMs * 2,
      );
      if (graceful !== TIMEOUT) continue;
      this.logger.warn(`${kind} ${BOT_QUEUE}: штатное закрытие не уложилось — принудительный disconnect`);
      if (
        (await within(
          item.disconnect().catch(() => {}),
          this.timeoutMs,
        )) === TIMEOUT
      ) {
        this.logger.error(`${kind} ${BOT_QUEUE}: disconnect не завершился`);
      }
    }
  }
}

/**
 * Очередь в памяти — только local без Redis: задача выполняется асинхронно после ответа webhook,
 * один повтор не делается, ошибка только логируется.
 */
export class MemoryOutbox implements Outbox {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly processJob: (data: SendMessageJob) => Promise<void>,
    private readonly logger: OutboxLogger,
  ) {}

  async sendMessage(job: SendMessageJob): Promise<void> {
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.processJob(job))
      .catch((err: Error) => this.logger.warn(`Отправка (memory) не удалась: ${err.message}`))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async close(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
