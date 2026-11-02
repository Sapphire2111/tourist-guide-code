/**
 * Периодические задачи через BullMQ job schedulers. Планировщик хранится в Redis и создаёт следующую
 * задачу с детерминированным id `repeat:<schedulerId>:<время тика>`, поэтому сколько бы экземпляров
 * воркера ни вызвали upsert, на один тик в очереди одна задача, и её забирает ровно один воркер.
 */
import type { JobSchedulerTemplateOptions } from "bullmq";
import {
  systemContext,
  AUDIT_PII_PURGE_EVERY_MS,
  DEAD_LETTER_PURGE_EVERY_MS,
  SERVICE_REQUESTS_ANONYMIZE_EVERY_MS,
  HEARTBEAT_EVERY_MS,
  JOB_QUEUE,
  JOBS,
  baseJobOptions,
  type JobData,
  type JobName,
  type WorkQueueName,
} from "@tg/queue-contract";

/**
 * Пространство id статических (объявленных в коде) планировщиков. syncSchedules удаляет из Redis только
 * планировщики с этим префиксом, которых нет в коде; остальные (будущие динамические, напр. напоминания
 * по сущности) не трогает. Разделитель — «.», не «:»: id задачи тика — `repeat:<id>:<ms>`.
 */
export const STATIC_SCHEDULE_PREFIX = "static.";

export interface Schedule<N extends JobName = JobName> {
  /** Id планировщика в Redis: `static.<…>`; стабилен между релизами (смена id = новый планировщик). */
  id: string;
  name: N;
  /** Интервал, мс. Cron-выражения (pattern) добавим, когда понадобятся отчёты «в 9:00». */
  every: number;
  data: JobData<N>;
}

export const SCHEDULES: readonly Schedule[] = [
  {
    id: `${STATIC_SCHEDULE_PREFIX}system.heartbeat`,
    name: JOBS.heartbeat,
    every: HEARTBEAT_EVERY_MS,
    data: { context: systemContext(null), payload: {} },
  } satisfies Schedule<typeof JOBS.heartbeat>,
];

/**
 * Очистка ПДн аудита (T1-13). Не входит в SCHEDULES: нужна БД, поэтому QueueService добавляет её, только если
 * задан DATABASE_URL. Кросс-tenant (SYSTEM без региона): функция БД сама выставляет app.actor на время удаления.
 */
export const AUDIT_PII_PURGE_SCHEDULE = {
  id: `${STATIC_SCHEDULE_PREFIX}audit.purge-expired-pii`,
  name: JOBS.auditPurgePii,
  every: AUDIT_PII_PURGE_EVERY_MS,
  data: { context: systemContext(null), payload: {} },
} as const satisfies Schedule<typeof JOBS.auditPurgePii>;

/**
 * Обезличивание заявок гостиницы по сроку хранения (D-49, ADR-0020). Как очистка ПДн аудита — только при
 * DATABASE_URL; кросс-tenant: функция БД сама выставляет app.actor.
 */
export const SERVICE_REQUESTS_ANONYMIZE_SCHEDULE = {
  id: `${STATIC_SCHEDULE_PREFIX}service-requests.anonymize-expired`,
  name: JOBS.serviceRequestsAnonymize,
  every: SERVICE_REQUESTS_ANONYMIZE_EVERY_MS,
  data: { context: systemContext(null), payload: {} },
} as const satisfies Schedule<typeof JOBS.serviceRequestsAnonymize>;

/**
 * Очистка dead-letter по сроку хранения (T1-25, D-73). Не входит в SCHEDULES: обработчику нужна очередь dead-letter
 * рантайма — QueueService добавляет расписание вместе с этой зависимостью.
 */
export const DEAD_LETTER_PURGE_SCHEDULE = {
  id: `${STATIC_SCHEDULE_PREFIX}dead-letter.purge-expired`,
  name: JOBS.deadLetterPurge,
  every: DEAD_LETTER_PURGE_EVERY_MS,
  data: { context: systemContext(null), payload: {} },
} as const satisfies Schedule<typeof JOBS.deadLetterPurge>;

/** Минимальный интерфейс очереди для планировщиков (Queue из bullmq подходит). */
export interface SchedulerQueue {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data: unknown; opts: JobSchedulerTemplateOptions },
  ): Promise<unknown>;
  getJobSchedulers(): Promise<{ key: string }[]>;
  removeJobScheduler(id: string): Promise<boolean>;
}

/**
 * Приводит статические планировщики в Redis к списку из кода: upsert объявленных (идемпотентно, безопасно
 * при одновременном старте нескольких экземпляров) и удаление тех `static.*`, что из кода убраны.
 * При rolling deploy старый и новый экземпляр могут кратко «перетягивать» планировщик, который есть только
 * в одной версии: удалённый из кода исчезнет окончательно, когда старых экземпляров не останется.
 */
export async function syncSchedules(
  queues: Readonly<Partial<Record<WorkQueueName, SchedulerQueue>>>,
  schedules: readonly Schedule[] = SCHEDULES,
): Promise<void> {
  for (const s of schedules) {
    if (!s.id.startsWith(STATIC_SCHEDULE_PREFIX) || s.id.includes(":")) {
      throw new Error(
        `Id расписания «${s.id}» должен начинаться с «${STATIC_SCHEDULE_PREFIX}» и не содержать «:»`,
      );
    }
  }
  for (const s of schedules) {
    const queue = queues[JOB_QUEUE[s.name]];
    if (!queue) throw new Error(`Очередь «${JOB_QUEUE[s.name]}» для расписания «${s.id}» не открыта`);
    await queue.upsertJobScheduler(
      s.id,
      { every: s.every },
      { name: s.name, data: s.data, opts: baseJobOptions(s.name) },
    );
  }
  const declared = new Set(schedules.map((s) => s.id));
  for (const queue of Object.values(queues)) {
    if (!queue) continue;
    for (const { key } of await queue.getJobSchedulers()) {
      if (key.startsWith(STATIC_SCHEDULE_PREFIX) && !declared.has(key)) await queue.removeJobScheduler(key);
    }
  }
}
