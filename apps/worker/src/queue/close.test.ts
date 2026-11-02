import { describe, expect, it, vi } from "vitest";
import { closeRuntime, type Closable } from "./close.js";

const never = () => new Promise<void>(() => {});

function fake(name: string, close: () => Promise<void> = () => Promise.resolve()) {
  return { name, close: vi.fn(close), disconnect: vi.fn(() => Promise.resolve()) } satisfies Closable;
}

const logger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe("closeRuntime", () => {
  it("штатно: воркеры, затем фоновые записи, затем очереди; без disconnect", async () => {
    const order: string[] = [];
    const worker = fake("system", async () => void order.push("worker"));
    const queue = fake("dead-letter", async () => void order.push("queue"));
    const pending = Promise.resolve().then(() => void order.push("pending"));
    await closeRuntime({
      workers: [worker],
      queues: [queue],
      pending: () => [pending],
      timeoutMs: 1_000,
      logger: logger(),
    });
    expect(order).toEqual(["worker", "pending", "queue"]);
    expect(worker.disconnect).not.toHaveBeenCalled();
    expect(queue.disconnect).not.toHaveBeenCalled();
  });

  it("Redis недоступен: зависший close() → по таймауту принудительный disconnect, close не висит", async () => {
    const worker = fake("system", never);
    const queue = fake("system", never);
    const log = logger();
    const started = Date.now();
    await closeRuntime({
      workers: [worker],
      queues: [queue],
      pending: () => [never()],
      timeoutMs: 50,
      logger: log,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(worker.disconnect).toHaveBeenCalledOnce();
    expect(queue.disconnect).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("принудительный disconnect"));
  });

  it("disconnect тоже завис — ошибка в лог, close всё равно завершается", async () => {
    const worker = { name: "system", close: vi.fn(never), disconnect: vi.fn(never) };
    const log = logger();
    await closeRuntime({ workers: [worker], queues: [], pending: () => [], timeoutMs: 20, logger: log });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("disconnect не завершился"));
  });

  it("ошибка close() логируется, остальные закрываются", async () => {
    const bad = fake("a", () => Promise.reject(new Error("boom")));
    const good = fake("b");
    const log = logger();
    await closeRuntime({
      workers: [],
      queues: [bad, good],
      pending: () => [],
      timeoutMs: 1_000,
      logger: log,
    });
    expect(good.close).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
