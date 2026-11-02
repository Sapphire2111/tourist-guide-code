import type * as BullMq from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  added: [] as unknown[][],
  addHangs: false,
  closeHangs: false,
  disconnected: [] as string[],
};
const hang = () => new Promise<never>(() => {});

vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof BullMq>();
  class Queue {
    on() {}
    async add(...args: unknown[]) {
      if (state.addHangs) return hang();
      state.added.push(args);
    }
    close() {
      return state.closeHangs ? hang() : Promise.resolve();
    }
    async disconnect() {
      state.disconnected.push("queue");
    }
  }
  class Worker {
    on() {}
    close() {
      return state.closeHangs ? hang() : Promise.resolve();
    }
    async disconnect() {
      state.disconnected.push("worker");
    }
  }
  return { ...actual, Queue, Worker };
});

const { BullOutbox } = await import("./outbox.js");
const { BOT_JOB_OPTIONS, botIdFromToken, replyJobId } = await import("./contract.js");
const logger = { log() {}, warn: vi.fn(), error: vi.fn() };

describe("BullOutbox", () => {
  beforeEach(() => {
    Object.assign(state, { added: [], addHangs: false, closeHangs: false, disconnected: [] });
  });

  it("ставит задачу telegram.sendMessage с опциями и jobId", async () => {
    const outbox = new BullOutbox("redis://localhost:6379", async () => {}, logger);
    const jobId = replyJobId(botIdFromToken("123456:ABC"), 5);
    await outbox.sendMessage({ chat_id: 1, text: "x" }, jobId);
    expect(jobId).toBe("telegram.sendMessage__123456-5");
    expect(state.added).toEqual([
      ["telegram.sendMessage", { chat_id: 1, text: "x" }, { ...BOT_JOB_OPTIONS, jobId }],
    ]);
    await outbox.close();
    expect(state.disconnected).toEqual([]);
  });

  it("Redis не отвечает → sendMessage бросает по таймауту", async () => {
    state.addHangs = true;
    const outbox = new BullOutbox("redis://localhost:6379", async () => {}, logger, 20);
    await expect(outbox.sendMessage({ chat_id: 1, text: "x" })).rejects.toThrow(/не уложилась в 20 мс/);
  });

  it("зависшее закрытие → принудительный disconnect воркера и очереди", async () => {
    state.closeHangs = true;
    const outbox = new BullOutbox("redis://localhost:6379", async () => {}, logger, 10);
    await outbox.close();
    expect(state.disconnected).toEqual(["worker", "queue"]);
  });

  it("bot id без токена — 0", () => expect(botIdFromToken(undefined)).toBe("0"));
});
