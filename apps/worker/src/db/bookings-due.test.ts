// Unit (без БД): сроки броней вызывают функции БД пачками, пока пачка полная. Сами функции bookings_expire_due() и
// bookings_auto_complete() на PostgreSQL — apps/api/test/integration/bookings.test.ts.
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "@tg/queue-contract";
import { createHandlers } from "../queue/handlers.js";
import { bookingsDueProcessor } from "./bookings-due.js";

function db(results: number[]) {
  const query = vi.fn();
  for (const n of results) query.mockResolvedValueOnce({ rows: [{ n }] });
  return { query };
}

const ctx = {
  context: systemContext(null),
  jobId: "j1",
  attempt: 1,
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
};

describe("bookingsDueProcessor", () => {
  it("expired и автозавершение — пачками, повтор, пока пачка полная", async () => {
    const q = db([2, 1, 0]);
    await expect(bookingsDueProcessor(q, 12, 2).processDue()).resolves.toEqual({ expired: 3, completed: 0 });
    expect(q.query).toHaveBeenNthCalledWith(1, "SELECT bookings_expire_due($1) AS n", [2]);
    expect(q.query).toHaveBeenNthCalledWith(3, "SELECT bookings_auto_complete($1, $2) AS n", [12, 2]);
  });

  it("по умолчанию — 24 ч и пачка 500; неверные часы — ошибка конфигурации", async () => {
    const q = db([0, 0]);
    await bookingsDueProcessor(q).processDue();
    expect(q.query.mock.calls[1]![1]).toEqual([24, 500]);
    expect(() => bookingsDueProcessor(q, 0)).toThrow();
  });

  it("задача bookings.process-due: без БД — без ретраев; с БД — число истёкших и завершённых", async () => {
    await expect(createHandlers({})["bookings.process-due"]({}, ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    const processDue = vi.fn().mockResolvedValue({ expired: 2, completed: 1 });
    await expect(
      createHandlers({ bookings: { processDue } })["bookings.process-due"]({}, ctx),
    ).resolves.toEqual({
      expired: 2,
      completed: 1,
    });
  });
});
