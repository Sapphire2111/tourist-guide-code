/**
 * Рантайм очередей: открывает очереди и воркеры BullMQ, синхронизирует расписания, закрывает всё
 * при остановке. Соединения Redis создаёт и закрывает сам BullMQ (connection: { url }).
 */
import { MetricsRegistry, type ErrorTracker } from "@tg/server-config";
import { Queue, Worker } from "bullmq";
import {
  QUEUES,
  enqueue,
  type EnqueueOptions,
  type JobData,
  type JobName,
  type WorkQueueName,
} from "@tg/queue-contract";
import { DEFAULT_CLOSE_TIMEOUT_MS, closeRuntime } from "./close.js";
import { deadLetterOnFailed, isFinalFailure, queueDeadLetterSink } from "./dead-letter.js";
import type { JobHandlers, JobLogger } from "./handlers.js";
import { createProcessor } from "./processor.js";
import { syncSchedules, type Schedule } from "./schedules.js";

export interface QueueRuntimeOptions {
  redisUrl: string;
  handlers: JobHandlers;
  schedules?: readonly Schedule[];
  logger: JobLogger;
  /** Параллельных задач на воркер (на очередь). */
  concurrency?: number;
  /** Префикс ключей Redis (по умолчанию "bull"); тесты используют свой для изоляции. */
  prefix?: string;
  /** Таймаут каждого шага остановки, мс (по умолчанию 10 с; меньше stop_grace_period в compose). */
  closeTimeoutMs?: number;
  /** Метрики (T1-18): задачи по исходу, длительность, длина очередей. */
  metrics?: MetricsRegistry;
  /** Окончательно упавшие задачи (→ dead-letter) уходят в трекер ошибок. */
  errorTracker?: ErrorTracker;
  /** Период снимка длины очередей в метрики и лог, мс (по умолчанию 10 мин; 0 — выключено). */
  metricsIntervalMs?: number;
}

export interface QueueRuntime {
  readonly queues: Readonly<Record<WorkQueueName, Queue>>;
  readonly deadLetter: Queue;
  readonly workers: readonly Worker[];
  readonly metrics: MetricsRegistry;
  /** Снять длину очередей в gauge `queue_jobs{queue,state}` (и вернуть снимок). */
  sampleQueues(): Promise<Record<string, Record<string, number>>>;
  enqueue<N extends JobName>(name: N, data: JobData<N>, options?: EnqueueOptions): ReturnType<typeof enqueue>;
  /** Дождаться текущих задач и закрыть воркеры, затем очереди (с таймаутом). Повторный вызов безопасен. */
  close(): Promise<void>;
}

const WORK_QUEUES: readonly WorkQueueName[] = [QUEUES.system, QUEUES.analytics, QUEUES.media];

/** Предел параллельности по очереди: ресайз держит в памяти исходник и варианты — не больше 2 одновременно. */
const QUEUE_CONCURRENCY_CAP: Partial<Record<WorkQueueName, number>> = { [QUEUES.media]: 2 };

export async function startQueueRuntime(options: QueueRuntimeOptions): Promise<QueueRuntime> {
  const {
    redisUrl,
    handlers,
    logger,
    schedules = [],
    concurrency = 5,
    prefix,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    metrics = new MetricsRegistry(),
    errorTracker,
    metricsIntervalMs = 600_000,
  } = options;
  const jobsTotal = metrics.counter("worker_jobs_total", "Задачи воркера по очереди, типу и исходу");
  const jobErrors = metrics.counter("worker_job_errors_total", "Окончательно упавшие задачи (→ dead-letter)");
  const jobDuration = metrics.histogram("worker_job_duration_seconds", "Длительность выполнения задачи, с");
  const queueJobs = metrics.gauge("queue_jobs", "Задачи в очереди по состоянию");
  const base = { connection: { url: redisUrl }, ...(prefix ? { prefix } : {}) };

  const deadLetter = new Queue(QUEUES.deadLetter, base);
  const queues = Object.fromEntries(WORK_QUEUES.map((name) => [name, new Queue(name, base)])) as Record<
    WorkQueueName,
    Queue
  >;
  const sink = queueDeadLetterSink(deadLetter);
  const processor = createProcessor(handlers, sink, logger);
  const workers: Worker[] = [];
  const pending = new Set<Promise<void>>();
  const onFailed = deadLetterOnFailed(sink, logger, (p) => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });

  const allQueues = () => [...Object.values(queues), deadLetter];
  const sampleQueues = async () => {
    const snapshot: Record<string, Record<string, number>> = {};
    for (const q of allQueues()) {
      const counts = await q.getJobCounts("waiting", "active", "delayed", "failed");
      snapshot[q.name] = counts;
      for (const [state, n] of Object.entries(counts)) queueJobs.set({ queue: q.name, state }, n);
    }
    return snapshot;
  };
  // Без HTTP у воркера метрики видны через лог: периодический снимок длины очередей (T1-18, ADR-0010).
  let sampler: NodeJS.Timeout | undefined;
  if (metricsIntervalMs > 0) {
    sampler = setInterval(() => {
      sampleQueues().then(
        (s) => logger.log(`Метрики очередей: ${JSON.stringify(s)}`),
        (err: Error) => logger.warn(`Снимок очередей не снят: ${err.message}`),
      );
    }, metricsIntervalMs);
    sampler.unref();
  }

  let closing: Promise<void> | undefined;
  const close = () => {
    clearInterval(sampler);
    return (closing ??= closeRuntime({
      workers,
      queues: [...Object.values(queues), deadLetter],
      pending: () => [...pending],
      timeoutMs: closeTimeoutMs,
      logger,
    }));
  };

  try {
    for (const q of [...Object.values(queues), deadLetter]) {
      q.on("error", (err) => logger.error(`Очередь ${q.name}: ${err.message}`));
    }
    await syncSchedules(queues, schedules);
    for (const name of WORK_QUEUES) {
      const worker = new Worker(name, processor, {
        ...base,
        concurrency: Math.min(concurrency, QUEUE_CONCURRENCY_CAP[name] ?? concurrency),
      });
      worker.on("error", (err) => logger.error(`Воркер ${name}: ${err.message}`));
      worker.on("completed", (job) => {
        jobsTotal.inc({ queue: name, name: job.name, result: "completed" });
        if (job.processedOn && job.finishedOn)
          jobDuration.observe({ queue: name, name: job.name }, (job.finishedOn - job.processedOn) / 1000);
      });
      worker.on("failed", (job, err) => {
        logger.warn(`Задача ${name}/${job?.name ?? "?"}#${job?.id ?? "?"} упала: ${err.message}`);
        jobsTotal.inc({ queue: name, name: job?.name ?? "?", result: "failed" });
        if (!job || isFinalFailure(job, err)) {
          jobErrors.inc({ queue: name, name: job?.name ?? "?" });
          errorTracker?.captureException(err, { queue: name, job: job?.name, jobId: job?.id });
        }
        onFailed(job, err);
      });
      workers.push(worker);
    }
    await Promise.all(workers.map((w) => w.waitUntilReady()));
  } catch (err) {
    await close();
    throw err;
  }

  return {
    queues,
    deadLetter,
    workers,
    metrics,
    sampleQueues,
    enqueue: (name, data, opts) => enqueue(queues, name, data, opts),
    close,
  };
}
