// Unit (без БД): обезличивание заявок гостиницы вызывает функцию БД со сроком и пачкой, пока пачка полная.
// Сама функция service_requests_anonymize_expired() на PostgreSQL — apps/api/test/integration/host.test.ts.
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "@tg/queue-contract";
import { createHandlers } from "../queue/handlers.js";
import { serviceRequestsAnonymizer } from "./service-requests-anonymizer.js";

function db(results: number[]) {
  const query = vi.fn();
  for (const deleted of results) query.mockResolvedValueOnce({ rows: [{ deleted }] });
  return { query };
}

const ctx = {
  context: systemContext(null),
  jobId: "j1",
  attempt: 1,
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
};

describe("serviceRequestsAnonymizer", () => {
  it("срок и пачка — параметры функции БД; повтор, пока пачка полная", async () => {
    const q = db([2, 2, 1]);
    await expect(serviceRequestsAnonymizer(q, 30, 2).anonymizeExpired()).resolves.toBe(5);
    expect(q.query).toHaveBeenCalledTimes(3);
    expect(q.query).toHaveBeenCalledWith(
      "SELECT service_requests_anonymize_expired($1, $2) AS deleted",
      [30, 2],
    );
  });

  it("срок по умолчанию — 90 дней; неверный срок — ошибка конфигурации", async () => {
    const q = db([0]);
    await serviceRequestsAnonymizer(q).anonymizeExpired();
    expect(q.query.mock.calls[0]![1]).toEqual([90, 1000]);
    expect(() => serviceRequestsAnonymizer(q, 0)).toThrow();
  });

  it("задача service-requests.anonymize-expired: без БД — без ретраев; с БД — число обезличенных", async () => {
    await expect(createHandlers({})["service-requests.anonymize-expired"]({}, ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    const anonymizeExpired = vi.fn().mockResolvedValue(3);
    await expect(
      createHandlers({ serviceRequests: { anonymizeExpired } })["service-requests.anonymize-expired"](
        {},
        ctx,
      ),
    ).resolves.toEqual({ anonymized: 3 });
  });
});
