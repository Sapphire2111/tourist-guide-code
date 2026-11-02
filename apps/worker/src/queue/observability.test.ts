import type { Job } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { currentLogContext, JsonLogger, type LogContext } from "@tg/server-config";
import { JOBS, systemContext } from "@tg/queue-contract";
import { defaultHandlers, type JobHandlers } from "./handlers.js";
import { correlationIdOf, createProcessor } from "./processor.js";

function fakeJob(data: Record<string, unknown>): Job {
  return {
    id: "42",
    name: JOBS.ping,
    queueName: "system",
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
  } as Job;
}

describe("контекст логов задачи (T1-18)", () => {
  it("обработчик пишет логи с jobId, correlationId и region_id задачи; ПДн маскируются", async () => {
    const lines: string[] = [];
    const json = new JsonLogger({ service: "worker", write: (l) => lines.push(l) });
    const logger = { log: (m: string) => json.log(m), warn: vi.fn(), error: vi.fn() };
    let seen: LogContext | undefined;
    const handlers: JobHandlers = {
      ...defaultHandlers,
      "system.ping": async (_p, ctx) => {
        seen = { ...currentLogContext() };
        ctx.logger.log("отправка на +380671234567");
      },
    };
    await createProcessor(
      handlers,
      { record: vi.fn() },
      logger,
    )(fakeJob({ context: systemContext("r-1"), payload: { message: "hi" }, correlationId: "req-9" }));
    expect(seen).toEqual({ jobId: "42", correlationId: "req-9", regionId: "r-1" });
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({ service: "worker", jobId: "42", correlationId: "req-9", region_id: "r-1" });
    expect(lines[0]).not.toContain("380671234567");
  });

  it("correlationId без продюсера — queue:id; небезопасный — заменяется", () => {
    expect(correlationIdOf(fakeJob({}))).toBe("system:42");
    expect(correlationIdOf(fakeJob({ correlationId: "bad id\n" }))).toBe("system:42");
  });
});
