import type { Job } from "bullmq";
import {
  JOB_QUEUE,
  jobOptions,
  type EnqueueOptions,
  type JobData,
  type JobName,
  type WorkQueueName,
} from "./contract.js";

/** Минимальный интерфейс очереди продюсера (Queue из bullmq подходит). */
export interface ProducerQueue {
  readonly name: string;
  add(name: string, data: unknown, opts: ReturnType<typeof jobOptions>): Promise<Job>;
}

/**
 * Типизированная постановка задачи: проверяет, что очередь соответствует контракту, и применяет
 * опции по умолчанию. С idempotencyKey дедупликация best-effort: пока задача с тем же jobId хранится
 * в Redis, повторный add — тихий no-op, а возвращённый Job — локальный объект с переданными data/opts,
 * а не сохранённая задача (её состояние читать через queue.getJob(job.id)).
 */
export async function enqueue<N extends JobName>(
  queues: Readonly<Partial<Record<WorkQueueName, ProducerQueue>>>,
  name: N,
  data: JobData<N>,
  options?: EnqueueOptions,
): Promise<Job> {
  const queueName = JOB_QUEUE[name];
  const queue = queues[queueName];
  if (!queue) throw new Error(`Очередь «${queueName}» для задачи «${name}» не открыта`);
  return queue.add(name, data, jobOptions(name, options));
}
