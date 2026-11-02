/**
 * Dead-letter: задача, исчерпавшая попытки (или упавшая с UnrecoverableError), копируется в очередь
 * `dead-letter` вместе с причиной. У этой очереди нет обработчика: записи лежат в состоянии waiting
 * до ручного разбора (просмотр, повторная постановка, удаление) или до истечения срока хранения своей задачи
 * (DEAD_LETTER_RETENTION_MS: записи analytics.record несут псевдонимные ПДн — удаляются задачей
 * dead-letter.purge-expired). Оригинал также остаётся в failed исходной очереди на срок removeOnFail.
 * Метрика длины dead-letter и алерт — T1-18.
 *
 * Запись делается из двух мест, с одним и тем же детерминированным jobId (повтор — no-op: BullMQ
 * не перезаписывает существующую задачу, а только эмитит «duplicated»):
 * 1. processor — на последней неудачной попытке, до пометки failed (основной путь, с исходным stack);
 * 2. событие worker «failed» — страховка для падений без вызова processor: задача, зависшая (stalled)
 *    больше maxStalledCount раз, получает deferredFailure, и BullMQ при следующей выдаче сразу падает её
 *    с UnrecoverableError, не вызывая обработчик.
 */
import { UnrecoverableError, type Job, type JobType, type JobsOptions } from "bullmq";
import type { JobName } from "@tg/queue-contract";
import type { DeadLetterPurger } from "./handlers.js";

/**
 * Запись dead-letter. Payload копируется как есть — в payload задач не кладём ПДн (только id сущностей); исключение —
 * analytics.record: событие несёт псевдонимные ПДн (anonymousId, sessionId, pseudonymousUserId), поэтому у таких
 * записей срок хранения (DEAD_LETTER_RETENTION_MS).
 */
export interface DeadLetterEntry {
  queue: string;
  jobName: string;
  jobId: string;
  data: unknown;
  failedReason: string;
  stack: string | null;
  /** Сколько попыток было сделано, включая последнюю. */
  attemptsMade: number;
  /** Когда задача была создана (мс epoch) — вместе с queue/jobId однозначно определяет экземпляр задачи. */
  createdAt: number;
  failedAt: string;
}

/** Куда пишутся окончательно упавшие задачи. */
export interface DeadLetterSink {
  record(entry: DeadLetterEntry): Promise<void>;
}

/** Минимум полей задачи, нужный для решения о dead-letter (удобно мокать). */
export type FailedJobView = Pick<
  Job,
  "id" | "name" | "queueName" | "data" | "attemptsMade" | "timestamp" | "opts"
>;

const isUnrecoverable = (err: unknown) =>
  err instanceof UnrecoverableError || (err instanceof Error && err.name === "UnrecoverableError");

/**
 * Последняя ли это попытка. Вызывается внутри обработки: attemptsMade — число уже неудачных попыток
 * до текущей (так считает BullMQ в Job.shouldRetryJob). Без attempts BullMQ не ретраит — попытка одна.
 */
export function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">, err: unknown): boolean {
  return isUnrecoverable(err) || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/**
 * Окончательное ли падение — для события worker «failed». В событии attemptsMade уже включает
 * упавшую попытку (BullMQ увеличивает его в Job.moveToFailed), поэтому сравнение без «+ 1».
 */
export function isFinalFailure(job: Pick<Job, "attemptsMade" | "opts">, err: unknown): boolean {
  return isUnrecoverable(err) || job.attemptsMade >= (job.opts.attempts ?? 1);
}

/** Запись dead-letter внутри обработки (processor): текущая попытка ещё не учтена в attemptsMade. */
export function toDeadLetterEntry(job: FailedJobView, err: unknown, now: Date = new Date()): DeadLetterEntry {
  return buildEntry(job, err, job.attemptsMade + 1, now);
}

/** Запись dead-letter из события «failed»: attemptsMade уже учитывает упавшую попытку. */
export function toDeadLetterEntryAfterFailure(
  job: FailedJobView,
  err: unknown,
  now: Date = new Date(),
): DeadLetterEntry {
  return buildEntry(job, err, job.attemptsMade, now);
}

function buildEntry(job: FailedJobView, err: unknown, attemptsMade: number, now: Date): DeadLetterEntry {
  const error = err instanceof Error ? err : new Error(String(err));
  return {
    queue: job.queueName,
    jobName: job.name,
    jobId: String(job.id),
    data: job.data,
    failedReason: error.message,
    stack: error.stack ?? null,
    attemptsMade,
    createdAt: job.timestamp,
    failedAt: now.toISOString(),
  };
}

/**
 * jobId записи в dead-letter: повторная запись того же экземпляра задачи не создаёт дубль.
 * «:» в id запрещён BullMQ, а id задач планировщика имеют вид `repeat:<id>:<ms>` — заменяем.
 */
export function deadLetterJobId(entry: Pick<DeadLetterEntry, "queue" | "jobId" | "createdAt">): string {
  return `${entry.queue}__${entry.jobId}__${entry.createdAt}`.replaceAll(":", "_");
}

/**
 * Срок хранения записей dead-letter по имени задачи, мс от записи в dead-letter; задачи нет в списке — хранится до
 * ручного разбора. analytics.record — 7 дней (тестовый режим: каркас D-73 (а) — данные устройства/сессии хранятся
 * коротко; окончательный срок — D-73, LEG). Тот же срок, что у failed по умолчанию (DEFAULT_JOB_OPTIONS).
 */
export const DEAD_LETTER_RETENTION_MS: Readonly<Partial<Record<JobName, number>>> = {
  "analytics.record": 7 * 24 * 3600_000,
};

/** Минимальный интерфейс очереди dead-letter для очистки (Queue из bullmq подходит). */
export interface DeadLetterQueueReader {
  getJobs(
    types: JobType[],
    start: number,
    end: number,
    asc: boolean,
  ): Promise<(Pick<Job, "id" | "name" | "timestamp"> | undefined)[]>;
  remove(jobId: string): Promise<number>;
}

export interface DeadLetterPurgeOptions {
  retention?: Readonly<Partial<Record<string, number>>>;
  now?: () => number;
  /** Сколько записей читать за запрос и сколько просмотреть за запуск (остальные — в следующий запуск). */
  pageSize?: number;
  maxScan?: number;
}

/**
 * Очистка dead-letter по сроку (задача dead-letter.purge-expired): просматривает ожидающие записи от старых к новым
 * и удаляет записи задач с истёкшим DEAD_LETTER_RETENTION_MS (timestamp записи = момент попадания в dead-letter).
 * Сначала собирает id, потом удаляет — удаление не сдвигает страницы просмотра. queue — геттер: очередь открывает
 * рантайм после создания обработчиков; не открыта — ошибка (ретрай).
 */
export function deadLetterPurger(
  queue: () => DeadLetterQueueReader | undefined,
  {
    retention = DEAD_LETTER_RETENTION_MS,
    now = Date.now,
    pageSize = 500,
    maxScan = 50_000,
  }: DeadLetterPurgeOptions = {},
): DeadLetterPurger {
  return {
    async purgeExpired() {
      const q = queue();
      if (!q) throw new Error("Очистка dead-letter: очередь ещё не открыта");
      const at = now();
      const expired: string[] = [];
      for (let start = 0; start < maxScan; start += pageSize) {
        const jobs = await q.getJobs(["waiting"], start, start + pageSize - 1, true);
        for (const job of jobs) {
          const ttl = job ? retention[job.name] : undefined;
          if (job?.id && ttl !== undefined && job.timestamp <= at - ttl) expired.push(job.id);
        }
        if (jobs.length < pageSize) break;
      }
      let removed = 0;
      for (const id of expired) removed += await q.remove(id);
      return removed;
    },
  };
}

/** Опции записи в dead-letter: без ретраев и автоудаления (у очереди нет обработчика; срок — deadLetterPurger). */
export const DEAD_LETTER_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: false,
  removeOnFail: false,
};

/** Минимальный интерфейс очереди для sink (Queue из bullmq подходит). */
export interface DeadLetterQueueLike {
  add(name: string, data: DeadLetterEntry, opts: JobsOptions): Promise<unknown>;
}

/** Sink поверх очереди dead-letter; имя записи = имя исходной задачи (фильтр при разборе). */
export function queueDeadLetterSink(queue: DeadLetterQueueLike): DeadLetterSink {
  return {
    async record(entry) {
      await queue.add(entry.jobName, entry, { ...DEAD_LETTER_JOB_OPTIONS, jobId: deadLetterJobId(entry) });
    },
  };
}

/** Минимальный логгер для ошибок записи. */
interface ErrorLogger {
  error(message: string): void;
}

/**
 * Обработчик события worker «failed»: пишет в dead-letter окончательные падения (см. п. 2 в шапке).
 * Событие не ждут, поэтому промис записи отдаётся в track — рантайм дожидается его перед закрытием очередей.
 */
export function deadLetterOnFailed(
  sink: DeadLetterSink,
  logger: ErrorLogger,
  track: (pending: Promise<void>) => void = () => {},
) {
  return (job: FailedJobView | undefined, err: Error): void => {
    if (!job || !isFinalFailure(job, err)) return;
    const pending = sink.record(toDeadLetterEntryAfterFailure(job, err)).catch((dlqErr: unknown) => {
      logger.error(
        `Не удалось записать задачу ${job.queueName}/${String(job.id)} в dead-letter: ${(dlqErr as Error).message}`,
      );
    });
    track(pending);
  };
}
