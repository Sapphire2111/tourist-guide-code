import { describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { parseEnv } from "@tg/server-config";
import { AppModule } from "./app.module.js";
import { workerEnvSchema } from "./config.js";
import {
  AUDIT_PII_PURGE_SCHEDULE,
  DEAD_LETTER_PURGE_SCHEDULE,
  SCHEDULES,
  SERVICE_REQUESTS_ANONYMIZE_SCHEDULE,
  BOOKINGS_PROCESS_DUE_SCHEDULE,
} from "./queue/schedules.js";
import { QueueService, type WorkerDbFactory, type QueueRuntimeFactory } from "./queue/queue.service.js";
import type { QueueRuntime } from "./queue/runtime.js";

const env = parseEnv("worker", workerEnvSchema, { REDIS_URL: "redis://localhost:4304" });

function fakeRuntime() {
  const close = vi.fn().mockResolvedValue(undefined);
  const runtime = { workers: [{ name: "system" }], close } as unknown as QueueRuntime;
  const factory = vi.fn<QueueRuntimeFactory>().mockResolvedValue(runtime);
  return { factory, close, runtime };
}

describe("AppModule", () => {
  it("собирается без подключения к Redis: воркеры стартуют только на bootstrap", async () => {
    const { factory } = fakeRuntime();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env, factory)],
    }).compile();
    expect(moduleRef.get(QueueService)).toBeInstanceOf(QueueService);
    expect(factory).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it("bootstrap запускает рантайм с REDIS_URL и расписаниями, shutdown закрывает его", async () => {
    const { factory, close, runtime } = fakeRuntime();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env, factory)],
    }).compile();
    await moduleRef.init();
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        redisUrl: "redis://localhost:4304",
        schedules: [...SCHEDULES, DEAD_LETTER_PURGE_SCHEDULE],
      }),
    );
    expect(moduleRef.get(QueueService).current).toBe(runtime);
    await moduleRef.close();
    expect(close).toHaveBeenCalledOnce();
    expect(moduleRef.get(QueueService).current).toBeUndefined();
  });

  it("DATABASE_URL задан: очистка ПДн аудита в расписании, пул БД закрывается после воркеров", async () => {
    const { factory, close } = fakeRuntime();
    const order: string[] = [];
    close.mockImplementation(async () => {
      order.push("runtime");
    });
    const closeDb = vi.fn(async () => {
      order.push("db");
    });
    const purgerFactory = vi.fn<WorkerDbFactory>().mockReturnValue({
      purger: { purgeExpired: vi.fn() },
      analytics: { record: vi.fn() },
      media: { claim: vi.fn(), complete: vi.fn(), reject: vi.fn() },
      serviceRequests: { anonymizeExpired: vi.fn() },
      bookings: { processDue: vi.fn() },
      close: closeDb,
    });
    const withDb = parseEnv("worker", workerEnvSchema, {
      REDIS_URL: "redis://localhost:4304",
      DATABASE_URL: "postgres://u:p@localhost:4302/db",
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(withDb, factory, purgerFactory)],
    }).compile();
    await moduleRef.init();
    expect(purgerFactory).toHaveBeenCalledExactlyOnceWith("postgres://u:p@localhost:4302/db", 90);
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        schedules: [
          ...SCHEDULES,
          DEAD_LETTER_PURGE_SCHEDULE,
          AUDIT_PII_PURGE_SCHEDULE,
          SERVICE_REQUESTS_ANONYMIZE_SCHEDULE,
          BOOKINGS_PROCESS_DUE_SCHEDULE,
        ],
      }),
    );
    await moduleRef.close();
    expect(order).toEqual(["runtime", "db"]);
  });

  it("без DATABASE_URL пул БД не создаётся", async () => {
    const { factory } = fakeRuntime();
    const purgerFactory = vi.fn<WorkerDbFactory>();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(env, factory, purgerFactory)],
    }).compile();
    await moduleRef.init();
    expect(purgerFactory).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});
