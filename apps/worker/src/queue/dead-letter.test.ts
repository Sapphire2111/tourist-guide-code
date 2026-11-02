// Unit: срок хранения записей dead-letter и задача dead-letter.purge-expired (без Redis).
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "@tg/queue-contract";
import { DEAD_LETTER_RETENTION_MS, deadLetterPurger, type DeadLetterQueueReader } from "./dead-letter.js";
import { createHandlers, defaultHandlers } from "./handlers.js";

const DAY = 24 * 3600_000;
const NOW = Date.parse("2026-11-02T12:00:00Z");

function queue(entries: { id: string; name: string; timestamp: number }[]) {
  const removed: string[] = [];
  const reader = {
    getJobs: vi.fn(async (_types: unknown, start: number, end: number) => entries.slice(start, end + 1)),
    remove: vi.fn(async (id: string) => {
      removed.push(id);
      return 1;
    }),
  } satisfies DeadLetterQueueReader;
  return { reader, removed };
}

describe("dead-letter: срок хранения", () => {
  it("analytics.record — 7 дней; прочие задачи — до ручного разбора", () => {
    expect(DEAD_LETTER_RETENTION_MS["analytics.record"]).toBe(7 * DAY);
    expect(DEAD_LETTER_RETENTION_MS["audit.purge-expired-pii"]).toBeUndefined();
    expect(DEAD_LETTER_RETENTION_MS["system.ping"]).toBeUndefined();
  });

  it("удаляет только истёкшие записи задач со сроком, просматривая все страницы", async () => {
    const entries = [
      { id: "a-old", name: "analytics.record", timestamp: NOW - 8 * DAY },
      { id: "p-old", name: "system.ping", timestamp: NOW - 30 * DAY },
      { id: "a-edge", name: "analytics.record", timestamp: NOW - 7 * DAY },
      { id: "a-new", name: "analytics.record", timestamp: NOW - 6 * DAY },
      { id: "a-old2", name: "analytics.record", timestamp: NOW - 9 * DAY },
    ];
    const { reader, removed } = queue(entries);
    const purger = deadLetterPurger(() => reader, { now: () => NOW, pageSize: 2 });
    await expect(purger.purgeExpired()).resolves.toBe(3);
    expect(removed).toEqual(["a-old", "a-edge", "a-old2"]);
    expect(reader.getJobs).toHaveBeenCalledWith(["waiting"], 0, 1, true);
    expect(reader.getJobs).toHaveBeenCalledTimes(3);
  });

  it("очередь не открыта — обычная ошибка (ретрай)", async () => {
    await expect(deadLetterPurger(() => undefined).purgeExpired()).rejects.toThrow(/не открыта/);
  });

  it("задача dead-letter.purge-expired вызывает очистку; без зависимости — UnrecoverableError", async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = { context: systemContext(null), jobId: "1", attempt: 1, logger };
    const purgeExpired = vi.fn().mockResolvedValue(2);
    await expect(
      createHandlers({ deadLetter: { purgeExpired } })["dead-letter.purge-expired"]({}, ctx),
    ).resolves.toEqual({ removed: 2 });
    await expect(defaultHandlers["dead-letter.purge-expired"]({}, ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
