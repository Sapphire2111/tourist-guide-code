// Unit (без БД): очистка ПДн аудита вызывает функцию БД пачками, пока пачка полная. Сама функция
// audit_purge_expired_pii() на реальной PostgreSQL — apps/api/test/integration/audit.test.ts.
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "@tg/queue-contract";
import { createHandlers, defaultHandlers } from "../queue/handlers.js";
import { auditPiiPurger, type Queryable } from "./audit-pii-purger.js";

function db(results: number[]): Queryable & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn();
  for (const deleted of results) query.mockResolvedValueOnce({ rows: [{ deleted }] });
  return { query } as never;
}

describe("auditPiiPurger", () => {
  it("повторяет вызов, пока удаляется полная пачка; возвращает сумму", async () => {
    const q = db([3, 3, 1]);
    await expect(auditPiiPurger(q, 3).purgeExpired()).resolves.toBe(7);
    expect(q.query).toHaveBeenCalledTimes(3);
    expect(q.query).toHaveBeenCalledWith("SELECT audit_purge_expired_pii($1) AS deleted", [3]);
  });

  it("нечего удалять — один вызов", async () => {
    const q = db([0]);
    await expect(auditPiiPurger(q).purgeExpired()).resolves.toBe(0);
    expect(q.query).toHaveBeenCalledOnce();
  });

  it("ошибка БД пробрасывается (ретрай задачи)", async () => {
    const q = { query: vi.fn().mockRejectedValue(new Error("connection refused")) };
    await expect(auditPiiPurger(q).purgeExpired()).rejects.toThrow(/connection refused/);
  });
});

describe("задача audit.purge-expired-pii", () => {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = { context: systemContext(null), jobId: "1", attempt: 1, logger };

  it("вызывает очистку и возвращает число удалённых", async () => {
    const purgeExpired = vi.fn().mockResolvedValue(5);
    const handlers = createHandlers({ auditPii: { purgeExpired } });
    await expect(handlers["audit.purge-expired-pii"]({}, ctx)).resolves.toEqual({ deleted: 5 });
    expect(purgeExpired).toHaveBeenCalledOnce();
  });

  it("без подключения к БД — UnrecoverableError (без ретраев)", async () => {
    await expect(defaultHandlers["audit.purge-expired-pii"]({}, ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
