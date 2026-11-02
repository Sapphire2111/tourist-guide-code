import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import {
  JOBS,
  defaultHandlers,
  startQueueRuntime,
  systemContext,
  type DeadLetterEntry,
  type JobHandlers,
  type QueueRuntime,
  type Schedule,
} from "../../src/queue/index.js";

// Тот же образ, что в infra/docker-compose.yml и интеграционных тестах api.
const REDIS_IMAGE = "redis:7.4-alpine";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const silent = { log() {}, warn() {}, error() {} };
const ping = (message = "hi") => ({ context: systemContext("region-a"), payload: { message } });

/** Ждёт, пока check() вернёт не undefined; иначе ошибка по таймауту. */
async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor: таймаут");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!dockerAvailable)(`Очередь BullMQ на Redis${title}`, () => {
  let redis: StartedRedisContainer | undefined;
  let redisUrl = "";
  const runtimes: QueueRuntime[] = [];

  /** Рантайм с изолированным префиксом ключей (каждый тест — своё пространство в Redis). */
  async function start(
    handlers: JobHandlers,
    schedules: readonly Schedule[] = [],
    prefix = `t${randomUUID()}`,
  ) {
    const runtime = await startQueueRuntime({ redisUrl, handlers, schedules, logger: silent, prefix });
    runtimes.push(runtime);
    return runtime;
  }

  async function finished(runtime: QueueRuntime, id: string, state: "completed" | "failed") {
    // Сначала состояние, потом задача: объект, прочитанный до завершения, хранит returnvalue = null.
    return waitFor(async () => {
      if ((await runtime.queues.system.getJobState(id)) !== state) return undefined;
      return runtime.queues.system.getJob(id);
    });
  }

  beforeAll(async () => {
    redis = await new RedisContainer(REDIS_IMAGE).start();
    redisUrl = redis.getConnectionUrl();
  });

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((r) => r.close()));
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it("тестовая задача выполняется в контексте SYSTEM/region", async () => {
    const runtime = await start(defaultHandlers);
    const job = await runtime.enqueue(JOBS.ping, ping("hello"));
    const done = await finished(runtime, job.id!, "completed");
    expect(done.returnvalue).toEqual({ pong: true, message: "hello", regionId: "region-a" });
    expect(await runtime.deadLetter.getJobCountByTypes("waiting")).toBe(0);
  });

  it("ключ идемпотентности: повторная постановка не создаёт вторую задачу", async () => {
    let calls = 0;
    const runtime = await start({ ...defaultHandlers, "system.ping": async () => ++calls });
    const a = await runtime.enqueue(JOBS.ping, ping(), { idempotencyKey: "order-1", delay: 500 });
    const b = await runtime.enqueue(JOBS.ping, ping(), { idempotencyKey: "order-1", delay: 500 });
    expect(b.id).toBe(a.id);
    await finished(runtime, a.id!, "completed");
    // После выполнения (задача ещё хранится по retention) повтор с тем же ключом тоже не выполняется.
    await runtime.enqueue(JOBS.ping, ping(), { idempotencyKey: "order-1" });
    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toBe(1);
  });

  it("отложенная задача выполняется не раньше delay", async () => {
    const runtime = await start(defaultHandlers);
    const job = await runtime.enqueue(JOBS.ping, ping(), { delay: 1_500 });
    expect(await job.getState()).toBe("delayed");
    const done = await finished(runtime, job.id!, "completed");
    expect(done.processedOn! - done.timestamp).toBeGreaterThanOrEqual(1_500);
  });

  it("временная ошибка: ретрай с backoff и успех без dead-letter", async () => {
    let calls = 0;
    const runtime = await start({
      ...defaultHandlers,
      "system.ping": async () => {
        if (++calls < 2) throw new Error("временный сбой");
        return "ok";
      },
    });
    const job = await runtime.enqueue(JOBS.ping, ping(), {
      overrides: { backoff: { type: "exponential", delay: 50 } },
    });
    const done = await finished(runtime, job.id!, "completed");
    expect(done.returnvalue).toBe("ok");
    expect(calls).toBe(2);
    expect(await runtime.deadLetter.getJobCountByTypes("waiting")).toBe(0);
  });

  it("падающая задача ретраится attempts раз и уходит в dead-letter с причиной", async () => {
    const attempts: number[] = [];
    const runtime = await start({
      ...defaultHandlers,
      "system.ping": async (_p, { attempt }) => {
        attempts.push(attempt);
        throw new Error("всегда падает");
      },
    });
    const job = await runtime.enqueue(JOBS.ping, ping(), {
      overrides: { attempts: 3, backoff: { type: "exponential", delay: 50 } },
    });
    const failed = await finished(runtime, job.id!, "failed");
    expect(failed.attemptsMade).toBe(3);
    expect(attempts).toEqual([1, 2, 3]);

    const [entry] = await waitFor(async () => {
      const jobs = await runtime.deadLetter.getJobs(["waiting"]);
      return jobs.length > 0 ? jobs : undefined;
    });
    expect(entry!.name).toBe(JOBS.ping);
    expect(entry!.data as DeadLetterEntry).toMatchObject({
      queue: "system",
      jobId: job.id,
      failedReason: "всегда падает",
      attemptsMade: 3,
      data: { context: { actor: "SYSTEM", regionId: "region-a" } },
    });
    expect(await runtime.deadLetter.getJobCountByTypes("waiting")).toBe(1);
  });

  it("периодическая задача: два экземпляра воркера, один запуск на тик", async () => {
    const prefix = `t${randomUUID()}`;
    const runs: { instance: string; jobId: string }[] = [];
    const recording = (instance: string): JobHandlers => ({
      ...defaultHandlers,
      "system.heartbeat": async (_p, { jobId }) => {
        runs.push({ instance, jobId });
      },
    });
    const schedule: Schedule = {
      id: "static.test.heartbeat",
      name: JOBS.heartbeat,
      every: 1_000,
      data: { context: systemContext(null), payload: {} },
    };
    // Оба экземпляра одновременно стартуют и делают upsert одного и того же планировщика.
    const [a] = await Promise.all([
      start(recording("A"), [schedule], prefix),
      start(recording("B"), [schedule], prefix),
    ]);
    await waitFor(async () => (runs.length >= 4 ? true : undefined), 15_000);

    expect(await a.queues.system.getJobSchedulersCount()).toBe(1);
    const ids = runs.map((r) => r.jobId);
    expect(new Set(ids).size).toBe(ids.length); // ни один тик не выполнен дважды
    // Время тика из id `repeat:<scheduler>:<ms>` строго растёт (кратность every не проверяем: догоняющий тик
    // после задержки может сместиться).
    const ticks = ids.map((id) => Number(id.split(":").at(-1))).sort((x, y) => x - y);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBeGreaterThan(0);
  });
});
