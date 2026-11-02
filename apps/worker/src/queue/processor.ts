import { runWithLogContext, setLogContext } from "@tg/server-config";
import { UnrecoverableError, type Job } from "bullmq";
import { isJobContext, type JobData, type JobName } from "@tg/queue-contract";
import { runInJobContext } from "./context.js";
import { isFinalAttempt, toDeadLetterEntry, type DeadLetterSink } from "./dead-letter.js";
import type { JobHandler, JobHandlers, JobLogger } from "./handlers.js";

/**
 * Processor BullMQ: проверяет задачу, выполняет обработчик в контексте SYSTEM/region, а на последней
 * неудачной попытке пишет запись в dead-letter до того, как BullMQ пометит задачу failed.
 * Это основной путь записи в dead-letter (с исходным stack); событие worker «failed» — страховка для падений
 * без вызова processor (stalled → deferredFailure), см. dead-letter.ts. Сбой записи виден в логе, а исходная
 * задача всё равно остаётся в failed.
 */
export function createProcessor(handlers: JobHandlers, deadLetter: DeadLetterSink, logger: JobLogger) {
  return (job: Job): Promise<unknown> =>
    // Контекст логов (T1-18): jobId и correlationId задачи (из data.correlationId продюсера, иначе queue:id);
    // region_id — после проверки context. JSON-логгер добавляет их к каждой записи обработчика.
    runWithLogContext({ jobId: String(job.id), correlationId: correlationIdOf(job) }, () => run(job));

  async function run(job: Job): Promise<unknown> {
    try {
      const handler = (handlers as Partial<Record<string, JobHandler<JobName>>>)[job.name];
      // Обычная ошибка, не Unrecoverable: при rolling deploy задачу нового типа может взять старый экземпляр —
      // ретраи с backoff дают новому экземпляру шанс её забрать; не забрал — dead-letter после attempts.
      if (!handler) throw new Error(`Нет обработчика для задачи «${job.name}»`);
      const data = job.data as Partial<JobData> | null;
      if (!isJobContext(data?.context)) {
        throw new UnrecoverableError(
          `Задача «${job.name}»: нет корректного context { actor: "SYSTEM", regionId }`,
        );
      }
      const context = data.context;
      setLogContext({ regionId: context.regionId });
      return await runInJobContext(context, () =>
        handler(data.payload as JobData["payload"], {
          context,
          jobId: String(job.id),
          attempt: job.attemptsMade + 1,
          logger,
        }),
      );
    } catch (err) {
      if (isFinalAttempt(job, err)) {
        try {
          await deadLetter.record(toDeadLetterEntry(job, err));
        } catch (dlqErr) {
          logger.error(
            `Не удалось записать задачу ${job.queueName}/${String(job.id)} в dead-letter: ${(dlqErr as Error).message}`,
          );
        }
      }
      throw err;
    }
  }
}

const SAFE_ID = /^[\w.:-]{1,128}$/;

/** correlationId задачи: переданный продюсером (api) в data.correlationId или `<queue>:<id>`. */
export function correlationIdOf(job: Pick<Job, "queueName" | "id" | "data">): string {
  const given = (job.data as { correlationId?: unknown } | null)?.correlationId;
  return typeof given === "string" && SAFE_ID.test(given) ? given : `${job.queueName}:${String(job.id)}`;
}
