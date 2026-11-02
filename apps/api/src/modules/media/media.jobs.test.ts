// Unit: inline-ресайз стартует вне транзакции запроса (свой контекст, свои короткие транзакции) и строго по одному.
import { describe, expect, it, vi } from "vitest";
import type { Storage } from "@tg/media";
import { recordingDb } from "../../../test/support/recording-db.js";
import { currentTenant, regionContext, withTenant } from "../../db/index.js";
import { InlineMediaJobs } from "./media.jobs.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const ID = "0190f5c2-7d3e-7000-8000-0000000000f1";
const storage = { driver: { delete: vi.fn() } } as unknown as Storage;

describe("InlineMediaJobs", () => {
  it("задача из транзакции запроса выполняется в своей транзакции, не в транзакции запроса", async () => {
    const { db } = recordingDb();
    const jobs = new InlineMediaJobs(db, storage);
    const tx = vi.spyOn(db, "transaction");
    await withTenant(db, regionContext(A), async () => {
      expect(currentTenant()).toBeDefined();
      await jobs.enqueueProcessing({ id: ID, regionId: A });
    });
    await jobs.idle();
    // Две транзакции: запроса и задачи (строки нет — задача только прочитала её). Если бы задача унаследовала
    // контекст запроса, withTenant переиспользовал бы его транзакцию — была бы одна.
    expect(tx).toHaveBeenCalledTimes(2);
  });

  it("задачи идут по одной (семафор на 1)", async () => {
    const { db } = recordingDb();
    const jobs = new InlineMediaJobs(db, storage);
    let active = 0;
    let max = 0;
    vi.spyOn(jobs as unknown as { process: () => Promise<void> }, "process").mockImplementation(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await Promise.all([1, 2, 3].map(() => jobs.enqueueProcessing({ id: ID, regionId: A })));
    await jobs.idle();
    expect(max).toBe(1);
  });

  it("гонка: отметка ready не применилась (update вернул пусто) — оригинал не удаляется", async () => {
    const del = vi.fn();
    const st = { driver: { delete: del, read: async () => null } } as unknown as Storage;
    // claim отдаёт processing, а любая отметка не находит строку в processing (её уже отметила другая задача).
    let claimed = false;
    const { db } = recordingDb({}, (q) => {
      if (q.sql.startsWith('update "media_assets"') && !claimed) {
        claimed = true;
        return [
          { id: ID, region_id: A, status: "processing", original_key: "private/k", mime: "image/jpeg" },
        ];
      }
      return [];
    });
    const jobs = new InlineMediaJobs(db, st);
    await jobs.enqueueProcessing({ id: ID, regionId: A });
    await jobs.idle();
    expect(del).not.toHaveBeenCalled();
  });
});
