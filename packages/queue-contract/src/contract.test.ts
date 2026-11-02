import { describe, expect, it } from "vitest";
import { isJobContext, systemContext } from "./context.js";
import {
  DEFAULT_JOB_OPTIONS,
  JOB_QUEUE,
  JOBS,
  QUEUES,
  baseJobOptions,
  idempotentJobId,
  jobOptions,
} from "./contract.js";

describe("контракт очередей", () => {
  it("каждая задача привязана к рабочей очереди, не к dead-letter", () => {
    for (const name of Object.values(JOBS)) {
      expect(JOB_QUEUE[name]).toBeDefined();
      expect(JOB_QUEUE[name]).not.toBe(QUEUES.deadLetter);
    }
  });

  it("имена очередей и задач без «:» (запрещено BullMQ)", () => {
    for (const n of [...Object.values(QUEUES), ...Object.values(JOBS)]) expect(n).not.toContain(":");
  });

  it("по умолчанию: 5 попыток, экспоненциальный backoff, retention", () => {
    expect(jobOptions(JOBS.ping)).toEqual({
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800 },
    });
  });

  it("аналитика — своя очередь, выполненные задачи не хранятся", () => {
    expect(JOB_QUEUE[JOBS.analyticsRecord]).toBe(QUEUES.analytics);
    expect(jobOptions(JOBS.analyticsRecord, { idempotencyKey: "e-1" })).toMatchObject({
      attempts: 5,
      removeOnComplete: true,
      jobId: "analytics.record__e-1",
    });
  });

  it("ресайз фото — своя очередь media, 3 попытки, jobId из id файла", () => {
    expect(JOB_QUEUE[JOBS.mediaProcessImage]).toBe(QUEUES.media);
    expect(jobOptions(JOBS.mediaProcessImage, { idempotencyKey: "a-1" })).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      jobId: "media.process-image__a-1",
    });
  });

  it("переопределение задачи: heartbeat без ретраев", () => {
    expect(baseJobOptions(JOBS.heartbeat).attempts).toBe(1);
    expect(baseJobOptions(JOBS.heartbeat).backoff).toEqual(DEFAULT_JOB_OPTIONS.backoff);
  });

  it("ключ идемпотентности → детерминированный jobId", () => {
    const a = jobOptions(JOBS.ping, { idempotencyKey: "booking-1" });
    const b = jobOptions(JOBS.ping, { idempotencyKey: " booking-1 " });
    expect(a.jobId).toBe("system.ping__booking-1");
    expect(b.jobId).toBe(a.jobId);
    expect(jobOptions(JOBS.ping).jobId).toBeUndefined();
  });

  it("некорректный ключ идемпотентности отклоняется", () => {
    expect(() => idempotentJobId(JOBS.ping, "  ")).toThrow(/пустым/);
    expect(() => idempotentJobId(JOBS.ping, "a:b")).toThrow(/«:»/);
  });

  it("отложенная задача: delay ≥ 0", () => {
    expect(jobOptions(JOBS.ping, { delay: 5_000 }).delay).toBe(5_000);
    expect(() => jobOptions(JOBS.ping, { delay: -1 })).toThrow(/delay/);
    expect(() => jobOptions(JOBS.ping, { delay: Number.NaN })).toThrow(/delay/);
  });

  it("overrides не затирают jobId из ключа", () => {
    const opts = jobOptions(JOBS.ping, { idempotencyKey: "k", overrides: { attempts: 2 } });
    expect(opts).toMatchObject({ attempts: 2, jobId: "system.ping__k" });
  });
});

describe("JobContext", () => {
  it("SYSTEM с регионом или кросс-tenant", () => {
    expect(systemContext()).toEqual({ actor: "SYSTEM", regionId: null });
    expect(systemContext("r-1")).toEqual({ actor: "SYSTEM", regionId: "r-1" });
  });

  it("проверка контекста из payload", () => {
    expect(isJobContext({ actor: "SYSTEM", regionId: null })).toBe(true);
    expect(isJobContext({ actor: "SYSTEM", regionId: "r-1" })).toBe(true);
    expect(isJobContext({ actor: "USER", regionId: null })).toBe(false);
    expect(isJobContext({ actor: "SYSTEM", regionId: "" })).toBe(false);
    expect(isJobContext({ actor: "SYSTEM" })).toBe(false);
    expect(isJobContext(null)).toBe(false);
  });
});
