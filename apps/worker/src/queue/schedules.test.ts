import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_PII_PURGE_EVERY_MS,
  HEARTBEAT_EVERY_MS,
  JOBS,
  baseJobOptions,
  enqueue,
  systemContext,
} from "@tg/queue-contract";
import {
  AUDIT_PII_PURGE_SCHEDULE,
  DEAD_LETTER_PURGE_SCHEDULE,
  SCHEDULES,
  syncSchedules,
  type SchedulerQueue,
} from "./schedules.js";

function schedulerQueue(existing: string[] = []): SchedulerQueue & Record<string, ReturnType<typeof vi.fn>> {
  return {
    upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    getJobSchedulers: vi.fn().mockResolvedValue(existing.map((key) => ({ key }))),
    removeJobScheduler: vi.fn().mockResolvedValue(true),
  };
}

describe("расписания", () => {
  it("heartbeat объявлен с интервалом и контекстом SYSTEM", () => {
    const hb = SCHEDULES.find((s) => s.id === "static.system.heartbeat");
    expect(hb).toMatchObject({
      name: JOBS.heartbeat,
      every: HEARTBEAT_EVERY_MS,
      data: { context: { actor: "SYSTEM", regionId: null } },
    });
  });

  it("очистка ПДн аудита: раз в час, кросс-tenant SYSTEM, проходит проверку id", async () => {
    expect(AUDIT_PII_PURGE_SCHEDULE).toMatchObject({
      id: "static.audit.purge-expired-pii",
      name: JOBS.auditPurgePii,
      every: AUDIT_PII_PURGE_EVERY_MS,
      data: { context: { actor: "SYSTEM", regionId: null }, payload: {} },
    });
    const system = schedulerQueue();
    await syncSchedules({ system }, [AUDIT_PII_PURGE_SCHEDULE]);
    expect(system.upsertJobScheduler).toHaveBeenCalledOnce();
  });

  it("очистка dead-letter: раз в час, кросс-tenant SYSTEM, в очереди system", async () => {
    expect(DEAD_LETTER_PURGE_SCHEDULE).toMatchObject({
      id: "static.dead-letter.purge-expired",
      name: JOBS.deadLetterPurge,
      every: 60 * 60_000,
      data: { context: { actor: "SYSTEM", regionId: null }, payload: {} },
    });
    const system = schedulerQueue();
    await syncSchedules({ system }, [DEAD_LETTER_PURGE_SCHEDULE]);
    expect(system.upsertJobScheduler).toHaveBeenCalledOnce();
  });

  it("syncSchedules: upsert объявленных с опциями задачи", async () => {
    const system = schedulerQueue(["static.system.heartbeat"]);
    await syncSchedules({ system });
    expect(system.upsertJobScheduler).toHaveBeenCalledWith(
      "static.system.heartbeat",
      { every: HEARTBEAT_EVERY_MS },
      { name: JOBS.heartbeat, data: SCHEDULES[0]!.data, opts: baseJobOptions(JOBS.heartbeat) },
    );
    expect(system.removeJobScheduler).not.toHaveBeenCalled();
  });

  it("syncSchedules: удаляет только static.*, убранные из кода; чужие планировщики не трогает", async () => {
    const system = schedulerQueue(["static.system.heartbeat", "static.old.report", "reminder.booking-1"]);
    await syncSchedules({ system });
    expect(system.removeJobScheduler).toHaveBeenCalledExactlyOnceWith("static.old.report");
  });

  it("syncSchedules: id без префикса static. или с «:» отклоняется до обращения к Redis", async () => {
    const system = schedulerQueue();
    const bad = (id: string) => [{ ...SCHEDULES[0]!, id }];
    await expect(syncSchedules({ system }, bad("system.heartbeat"))).rejects.toThrow(/static./);
    await expect(syncSchedules({ system }, bad("static.a:b"))).rejects.toThrow(/«:»/);
    expect(system.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it("syncSchedules: очередь расписания не открыта — ошибка", async () => {
    await expect(syncSchedules({})).rejects.toThrow(/не открыта/);
  });
});

describe("enqueue", () => {
  it("ставит задачу в очередь из контракта с опциями по умолчанию", async () => {
    const add = vi.fn().mockResolvedValue({ id: "1" });
    const data = { context: systemContext("r-1"), payload: { message: "x" } };
    await enqueue({ system: { name: "system", add } }, JOBS.ping, data, { idempotencyKey: "k1", delay: 10 });
    expect(add).toHaveBeenCalledWith(
      JOBS.ping,
      data,
      expect.objectContaining({ attempts: 5, jobId: "system.ping__k1", delay: 10 }),
    );
  });

  it("очередь не открыта — ошибка", async () => {
    await expect(enqueue({}, JOBS.ping, { context: systemContext(), payload: {} })).rejects.toThrow(
      /не открыта/,
    );
  });
});
