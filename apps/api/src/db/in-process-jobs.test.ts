// Unit (без БД): тик под транзакционным advisory lock, пропуск при занятом lock и при незавершённом тике.
import { describe, expect, it, vi } from "vitest";
import type { BookingsDueResult } from "@tg/queue-contract";
import { IN_PROCESS_JOBS_LOCK_KEY, InProcessJobsRunner, type LockClient } from "./in-process-jobs.js";

const ZERO: BookingsDueResult = {
  expired: 0,
  completed: 0,
  reminded: 0,
  notifications: { sent: 0, failed: 0, skipped: 0 },
};

function setup(lockOk = true, processDue = vi.fn(async () => ZERO)) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push(text);
      if (text.includes("advisory")) {
        expect(values).toEqual([IN_PROCESS_JOBS_LOCK_KEY]);
        return { rows: [{ ok: lockOk }] };
      }
      return { rows: [] };
    }),
    release: vi.fn<LockClient["release"]>(),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runner = new InProcessJobsRunner({
    connect: async () => client,
    bookings: { processDue },
    logger,
  });
  return { runner, client, queries, logger, processDue };
}

describe("InProcessJobsRunner", () => {
  it("под lock выполняет задачу и снимает lock коммитом", async () => {
    const { runner, queries, client, processDue } = setup();
    await expect(runner.tick()).resolves.toBe("done");
    expect(processDue).toHaveBeenCalledOnce();
    expect(queries).toEqual(["BEGIN", "SELECT pg_try_advisory_xact_lock($1) AS ok", "COMMIT"]);
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it("lock у другого экземпляра — тик пропускается", async () => {
    const { runner, queries, processDue } = setup(false);
    await expect(runner.tick()).resolves.toBe("locked");
    expect(processDue).not.toHaveBeenCalled();
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("предыдущий тик не закончен — новый не начинается", async () => {
    let finish!: () => void;
    const processDue = vi.fn(() => new Promise<BookingsDueResult>((r) => (finish = () => r(ZERO))));
    const { runner } = setup(true, processDue);
    const first = runner.tick();
    await vi.waitFor(() => expect(processDue).toHaveBeenCalled());
    await expect(runner.tick()).resolves.toBe("busy");
    finish();
    await expect(first).resolves.toBe("done");
  });

  it("ошибка задачи логируется, lock снимается, процесс не падает", async () => {
    const { runner, queries, logger } = setup(
      true,
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    await expect(runner.tick()).resolves.toBe("failed");
    expect(queries.at(-1)).toBe("COMMIT");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("пишет итог только при ненулевых числах", async () => {
    const { runner, logger } = setup(
      true,
      vi.fn(async () => ({ ...ZERO, expired: 2 })),
    );
    await runner.tick();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("expired=2"));
  });

  it("start/stop: таймер с unref, stop дожидается тика", async () => {
    vi.useFakeTimers();
    try {
      const { runner, processDue } = setup();
      runner.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(processDue).toHaveBeenCalledOnce();
      await runner.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(processDue).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
