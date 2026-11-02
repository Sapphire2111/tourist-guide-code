/**
 * Контракт очередей: имена очередей и задач, типы payload, опции по умолчанию.
 * Продюсеры — worker (периодические задачи) и api (аналитические события, T1-25; ресайз фото, T1-20); рантайм — worker
 * (ADR-0008). Контракт не зависит от Nest и не открывает соединений.
 */
import type { AnalyticsEvent } from "@tg/shared";
import type { JobSchedulerTemplateOptions, JobsOptions } from "bullmq";
import type { JobContext } from "./context.js";

/** Имена очередей BullMQ. dead-letter — хранилище окончательно упавших задач (без обработчика). */
export const QUEUES = {
  system: "system",
  /** Запись аналитических событий: отдельная очередь, чтобы поток событий не задерживал системные задачи. */
  analytics: "analytics",
  /** Обработка медиа (ресайз фото, T1-20): отдельная очередь — тяжёлые задачи не задерживают системные. */
  media: "media",
  deadLetter: "dead-letter",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
/** Очереди с обработчиками (всё, кроме dead-letter). */
export type WorkQueueName = Exclude<QueueName, typeof QUEUES.deadLetter>;

/** Имена задач: `<домен>.<действие>`. */
export const JOBS = {
  /** Тестовая задача: проверка, что очередь и воркер работают. */
  ping: "system.ping",
  /** Тестовая периодическая задача (job scheduler). */
  heartbeat: "system.heartbeat",
  /** Удаление ПДн-части аудита с истёкшим сроком хранения (T1-13, D-73). */
  auditPurgePii: "audit.purge-expired-pii",
  /** Запись аналитического события в analytics_events (T1-25, D-56). */
  analyticsRecord: "analytics.record",
  /** Удаление записей dead-letter с истёкшим сроком хранения (T1-25, D-73; срок — worker dead-letter.ts). */
  deadLetterPurge: "dead-letter.purge-expired",
  /** Ресайз загруженного фото в варианты webp, статус ready (T1-20, ADR-0013). */
  mediaProcessImage: "media.process-image",
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** Payload каждой задачи (без контекста — он общий, см. JobData). */
export interface JobPayloads {
  "system.ping": { message?: string };
  "system.heartbeat": Record<string, never>;
  "audit.purge-expired-pii": Record<string, never>;
  /** Событие, уже проверенное продюсером по analyticsEventSchema; worker проверяет повторно (данные из Redis). */
  "analytics.record": { event: AnalyticsEvent };
  "dead-letter.purge-expired": Record<string, never>;
  /** Только id: состояние и ключи worker читает из БД (media_assets) — payload не устаревает. */
  "media.process-image": { assetId: string };
}

/** Данные задачи в Redis: контекст выполнения + payload. Только JSON-сериализуемые значения. */
export interface JobData<N extends JobName = JobName> {
  context: JobContext;
  payload: JobPayloads[N];
}

/** В какую очередь ставится задача. */
export const JOB_QUEUE: Readonly<Record<JobName, WorkQueueName>> = {
  "system.ping": QUEUES.system,
  "system.heartbeat": QUEUES.system,
  "audit.purge-expired-pii": QUEUES.system,
  "analytics.record": QUEUES.analytics,
  "dead-letter.purge-expired": QUEUES.system,
  "media.process-image": QUEUES.media,
};

/**
 * Опции по умолчанию: 5 попыток с экспоненциальной задержкой 1 с → 2 → 4 → 8 с (~15 с до dead-letter).
 * Завершённые задачи хранятся сутки (не больше 1000), упавшие — 7 дней в failed исходной очереди;
 * копия упавшей задачи с причиной уходит в dead-letter (см. dead-letter.ts) и хранится до ручного разбора
 * (записи задач с ПДн-рисками, напр. analytics.record, — не дольше срока хранения, см. DEAD_LETTER_RETENTION_MS).
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const satisfies JobsOptions;

/** Переопределения опций для отдельных задач (jobId/delay задаются при постановке, не здесь). */
export const JOB_OPTIONS: Partial<Record<JobName, JobSchedulerTemplateOptions>> = {
  // Heartbeat повторяется сам по расписанию: ретраи пропущенного тика не нужны.
  "system.heartbeat": { attempts: 1 },
  // Событий много (до 1 млн/мес, ТЗ §13): выполненные не храним, упавшие — сутки (копия — в dead-letter).
  "analytics.record": { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
  // Ресайз: 3 попытки с паузой 5 с → 10 с (первая может застать ещё не закоммиченное подтверждение загрузки).
  "media.process-image": { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
};

/** Расписание периодической тестовой задачи. */
export const HEARTBEAT_EVERY_MS = 5 * 60_000;

/** Очистка ПДн аудита — раз в час: срок хранения считается в днях, точности до часа достаточно. */
export const AUDIT_PII_PURGE_EVERY_MS = 60 * 60_000;

/** Очистка dead-letter по сроку — раз в час (как очистка ПДн аудита). */
export const DEAD_LETTER_PURGE_EVERY_MS = 60 * 60_000;

/** Разделитель частей jobId. В BullMQ «:» в пользовательском id запрещён (это разделитель ключей Redis). */
const ID_SEPARATOR = "__";

export interface EnqueueOptions {
  /**
   * Ключ идемпотентности: из него строится jobId. Дедупликация best-effort: повторная постановка с тем же
   * ключом — тихий no-op, пока задача хранится в Redis (ожидает/выполняется; выполненная — до вытеснения
   * по removeOnComplete: 24 ч, но не более 1000 последних на всю очередь; упавшая — 7 дней в failed).
   * Поэтому: гарантию «эффект один раз» даёт обработчик (см. handlers.ts), а повтор упавшей задачи —
   * retry из failed/dead-letter, не повторный enqueue с тем же ключом.
   * Ключ — стабильный идентификатор эффекта, напр. `booking-123-expire`, а не случайное значение.
   */
  idempotencyKey?: string;
  /** Отложенный запуск, мс. */
  delay?: number;
  /** Точечные переопределения опций по умолчанию. */
  overrides?: Omit<JobsOptions, "jobId" | "delay">;
}

/** jobId из ключа идемпотентности: `<задача>__<ключ>`. */
export function idempotentJobId(name: JobName, key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") throw new Error("Ключ идемпотентности не может быть пустым");
  if (trimmed.includes(":")) throw new Error("Ключ идемпотентности не может содержать «:»");
  return `${name}${ID_SEPARATOR}${trimmed}`;
}

/** Опции задачи без jobId/delay: умолчания + переопределения задачи (шаблон и для планировщиков). */
export function baseJobOptions(name: JobName): JobSchedulerTemplateOptions {
  return { ...DEFAULT_JOB_OPTIONS, ...JOB_OPTIONS[name] };
}

/** Итоговые опции BullMQ для постановки задачи. */
export function jobOptions(name: JobName, options: EnqueueOptions = {}): JobsOptions {
  const result: JobsOptions = { ...baseJobOptions(name), ...options.overrides };
  if (options.idempotencyKey !== undefined) result.jobId = idempotentJobId(name, options.idempotencyKey);
  if (options.delay !== undefined) {
    if (!Number.isFinite(options.delay) || options.delay < 0) throw new Error("delay должен быть ≥ 0 мс");
    result.delay = options.delay;
  }
  return result;
}
