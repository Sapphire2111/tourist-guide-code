import { UnrecoverableError, type Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { JOBS, systemContext } from "@tg/queue-contract";
import { currentJobContext } from "./context.js";
import {
  DEAD_LETTER_JOB_OPTIONS,
  deadLetterJobId,
  deadLetterOnFailed,
  isFinalAttempt,
  isFinalFailure,
  queueDeadLetterSink,
  toDeadLetterEntry,
  type DeadLetterSink,
} from "./dead-letter.js";
import { defaultHandlers, type JobHandlers } from "./handlers.js";
import { createProcessor } from "./processor.js";

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeJob(over: Partial<Job> = {}): Job {
  return {
    id: "42",
    name: JOBS.ping,
    queueName: "system",
    data: { context: systemContext("r-1"), payload: { message: "hi" } },
    attemptsMade: 0,
    timestamp: 1_700_000_000_000,
    opts: { attempts: 3 },
    ...over,
  } as Job;
}

function sink(): DeadLetterSink & { record: ReturnType<typeof vi.fn> } {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

const handlersWith = (ping: JobHandlers["system.ping"]): JobHandlers => ({
  ...defaultHandlers,
  "system.ping": ping,
});

describe("isFinalAttempt", () => {
  it("последняя попытка — когда attemptsMade + 1 ≥ attempts", () => {
    const err = new Error("x");
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } }, err)).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } }, err)).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } }, err)).toBe(true);
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} }, err)).toBe(true);
  });

  it("UnrecoverableError — сразу последняя", () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 5 } }, new UnrecoverableError("no"))).toBe(
      true,
    );
  });
});

describe("dead-letter", () => {
  it("запись содержит причину, попытки и исходные данные", () => {
    const entry = toDeadLetterEntry(
      fakeJob({ attemptsMade: 2 }),
      new Error("boom"),
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(entry).toMatchObject({
      queue: "system",
      jobName: JOBS.ping,
      jobId: "42",
      failedReason: "boom",
      attemptsMade: 3,
      createdAt: 1_700_000_000_000,
      failedAt: "2026-11-01T00:00:00.000Z",
      data: { context: { actor: "SYSTEM", regionId: "r-1" } },
    });
    expect(entry.stack).toContain("boom");
    expect(toDeadLetterEntry(fakeJob(), "строка").failedReason).toBe("строка");
  });

  it("jobId записи детерминирован и без «:» (id задач планировщика)", () => {
    const id = deadLetterJobId({ queue: "system", jobId: "repeat:system.heartbeat:123", createdAt: 5 });
    expect(id).toBe("system__repeat_system.heartbeat_123__5");
  });

  it("sink ставит запись в очередь dead-letter без ретраев и автоудаления", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };
    const entry = toDeadLetterEntry(fakeJob(), new Error("e"));
    await queueDeadLetterSink(queue).record(entry);
    expect(queue.add).toHaveBeenCalledWith(JOBS.ping, entry, {
      ...DEAD_LETTER_JOB_OPTIONS,
      jobId: "system__42__1700000000000",
    });
  });
});

describe("dead-letter из события worker «failed»", () => {
  // В событии attemptsMade уже включает упавшую попытку (BullMQ увеличивает его в moveToFailed).
  it("isFinalFailure: attemptsMade ≥ attempts или UnrecoverableError", () => {
    const err = new Error("x");
    expect(isFinalFailure({ attemptsMade: 2, opts: { attempts: 3 } }, err)).toBe(false);
    expect(isFinalFailure({ attemptsMade: 3, opts: { attempts: 3 } }, err)).toBe(true);
    expect(isFinalFailure({ attemptsMade: 1, opts: {} }, err)).toBe(true);
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: 5 } }, new UnrecoverableError("u"))).toBe(
      true,
    );
  });

  it("stalled > maxStalledCount (deferredFailure): processor не вызывался, запись делает событие", async () => {
    const dlq = sink();
    const tracked: Promise<void>[] = [];
    const onFailed = deadLetterOnFailed(dlq, logger, (p) => tracked.push(p));
    // BullMQ: handleFailed(new UnrecoverableError(job.deferredFailure)) без вызова processor; attemptsMade 0 → 1.
    const job = fakeJob({ attemptsMade: 1, opts: { attempts: 5 } });
    onFailed(job, new UnrecoverableError("job stalled more than allowable limit"));
    await Promise.all(tracked);
    expect(dlq.record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        jobId: "42",
        failedReason: "job stalled more than allowable limit",
        attemptsMade: 1,
      }),
    );
  });

  it("исчерпаны попытки: attemptsMade в записи без сдвига, jobId записи тот же, что у processor", async () => {
    const dlq = sink();
    const onFailed = deadLetterOnFailed(dlq, logger);
    onFailed(fakeJob({ attemptsMade: 3 }), new Error("final"));
    await vi.waitFor(() => expect(dlq.record).toHaveBeenCalledOnce());
    const fromEvent = dlq.record.mock.calls[0]![0];
    expect(fromEvent.attemptsMade).toBe(3);
    // processor на той же (последней) попытке видит attemptsMade = 2 → та же запись, тот же jobId.
    const fromProcessor = toDeadLetterEntry(fakeJob({ attemptsMade: 2 }), new Error("final"));
    expect(fromProcessor.attemptsMade).toBe(3);
    expect(deadLetterJobId(fromEvent)).toBe(deadLetterJobId(fromProcessor));
  });

  it("не последняя попытка или нет job — ничего не пишет", () => {
    const dlq = sink();
    const onFailed = deadLetterOnFailed(dlq, logger);
    onFailed(fakeJob({ attemptsMade: 1 }), new Error("temp"));
    onFailed(undefined, new Error("?"));
    expect(dlq.record).not.toHaveBeenCalled();
  });

  it("сбой записи логируется, промис не отклоняется", async () => {
    const dlq = { record: vi.fn().mockRejectedValue(new Error("redis down")) };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tracked: Promise<void>[] = [];
    deadLetterOnFailed(dlq, log, (p) => tracked.push(p))(fakeJob({ attemptsMade: 3 }), new Error("final"));
    await expect(Promise.all(tracked)).resolves.toBeDefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("redis down"));
  });
});

describe("createProcessor", () => {
  it("выполняет обработчик в контексте задачи и возвращает результат", async () => {
    const ping = vi.fn(async () => currentJobContext());
    const dlq = sink();
    const result = await createProcessor(handlersWith(ping), dlq, logger)(fakeJob({ attemptsMade: 1 }));
    expect(result).toEqual({ actor: "SYSTEM", regionId: "r-1" });
    expect(ping).toHaveBeenCalledWith(
      { message: "hi" },
      expect.objectContaining({ jobId: "42", attempt: 2, context: { actor: "SYSTEM", regionId: "r-1" } }),
    );
    expect(dlq.record).not.toHaveBeenCalled();
  });

  it("ошибка на не последней попытке — пробрасывается для ретрая, без dead-letter", async () => {
    const dlq = sink();
    const run = createProcessor(
      handlersWith(() => Promise.reject(new Error("temp"))),
      dlq,
      logger,
    );
    await expect(run(fakeJob({ attemptsMade: 0 }))).rejects.toThrow("temp");
    expect(dlq.record).not.toHaveBeenCalled();
  });

  it("ошибка на последней попытке — запись в dead-letter, затем проброс", async () => {
    const dlq = sink();
    const run = createProcessor(
      handlersWith(() => Promise.reject(new Error("final"))),
      dlq,
      logger,
    );
    await expect(run(fakeJob({ attemptsMade: 2 }))).rejects.toThrow("final");
    expect(dlq.record).toHaveBeenCalledWith(
      expect.objectContaining({ failedReason: "final", attemptsMade: 3 }),
    );
  });

  it("сбой записи в dead-letter логируется, исходная ошибка сохраняется", async () => {
    const dlq = { record: vi.fn().mockRejectedValue(new Error("redis down")) };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const run = createProcessor(
      handlersWith(() => Promise.reject(new Error("final"))),
      dlq,
      log,
    );
    await expect(run(fakeJob({ attemptsMade: 2 }))).rejects.toThrow("final");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("redis down"));
  });

  it("неизвестная задача — обычная ошибка с ретраями (rolling deploy), dead-letter только на последней", async () => {
    const dlq = sink();
    const run = createProcessor(defaultHandlers, dlq, logger);
    const first = run(fakeJob({ name: "nope.unknown" }));
    await expect(first).rejects.toThrow(/Нет обработчика/);
    await expect(first).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(dlq.record).not.toHaveBeenCalled();
    await expect(run(fakeJob({ name: "nope.unknown", attemptsMade: 2 }))).rejects.toThrow(/Нет обработчика/);
    expect(dlq.record).toHaveBeenCalledOnce();
  });

  it("нет корректного контекста — UnrecoverableError, обработчик не вызывается", async () => {
    const ping = vi.fn();
    const dlq = sink();
    const run = createProcessor(handlersWith(ping), dlq, logger);
    const job = fakeJob({ data: { context: { actor: "USER", regionId: null }, payload: {} } });
    await expect(run(job)).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(run(fakeJob({ data: null }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(ping).not.toHaveBeenCalled();
    expect(dlq.record).toHaveBeenCalledTimes(2);
  });
});

describe("defaultHandlers", () => {
  const ctx = { context: systemContext("r-9"), jobId: "1", attempt: 1, logger };

  it("system.ping отвечает pong с регионом", async () => {
    await expect(defaultHandlers["system.ping"]({ message: "m" }, ctx)).resolves.toEqual({
      pong: true,
      message: "m",
      regionId: "r-9",
    });
  });

  it("system.heartbeat возвращает время и логирует", async () => {
    const res = (await defaultHandlers["system.heartbeat"]({}, ctx)) as { at: string };
    expect(Number.isNaN(Date.parse(res.at))).toBe(false);
    expect(logger.log).toHaveBeenCalled();
  });
});
