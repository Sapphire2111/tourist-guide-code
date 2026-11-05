// Unit (без БД): стирание ПДн заявок «Це мій заклад» вызывает функцию БД со сроком 90 дней, пока пачка полная, и
// выполняется в суточной задаче сроков хранения. Сама функция — apps/api/test/integration/place-claims.test.ts.
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "@tg/queue-contract";
import { createHandlers } from "../queue/handlers.js";
import { placeClaimsPiiPurger } from "./place-claims-pii-purger.js";

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

describe("placeClaimsPiiPurger", () => {
  it("срок 90 дней по умолчанию; повтор, пока пачка полная", async () => {
    const q = db([2, 1]);
    await expect(placeClaimsPiiPurger(q, 90, 2).purgeExpired()).resolves.toBe(3);
    expect(q.query).toHaveBeenCalledWith("SELECT place_claims_purge_expired_pii($1, $2) AS deleted", [90, 2]);
    const d = db([0]);
    await placeClaimsPiiPurger(d).purgeExpired();
    expect(d.query.mock.calls[0]![1]).toEqual([90, 1000]);
  });

  it("суточная задача сроков хранения стирает и ПДн заявок", async () => {
    const purgeExpired = vi.fn().mockResolvedValue(4);
    const result = await createHandlers({
      serviceRequests: { anonymizeExpired: vi.fn().mockResolvedValue(1) },
      placeClaims: { purgeExpired },
    })["service-requests.anonymize-expired"]({} as never, ctx as never);
    expect(result).toEqual({ anonymized: 1, claimsPurged: 4 });
  });
});
