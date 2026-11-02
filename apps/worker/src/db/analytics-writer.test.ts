// Unit (без БД): задача analytics.record проверяет событие схемой и пишет его через функцию БД.
// Сама функция analytics_record_event() на реальной PostgreSQL — apps/api/test/integration/analytics.test.ts.
import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "@tg/queue-contract";
import { ANALYTICS_SCHEMA_VERSION, type AnalyticsEvent } from "@tg/shared";
import { createHandlers, defaultHandlers } from "../queue/handlers.js";
import { analyticsWriter } from "./analytics-writer.js";

const U = "0192f0c1-7a2b-7c3d-8e4f-0a1b2c3d4e5f";
const event: AnalyticsEvent = {
  eventId: "0192f0c1-7a2b-7c3d-8e4f-000000000001",
  schemaVersion: ANALYTICS_SCHEMA_VERSION,
  occurredAt: "2026-11-02T10:00:00.000Z",
  anonymousId: U,
  regionId: null,
  source: "qr",
  event: "place_viewed",
  props: { placeId: U },
};

describe("analyticsWriter", () => {
  it("вызывает analytics_record_event со строкой в snake_case", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ inserted: true }] });
    const writer = analyticsWriter({ query });
    const row = { id: "x" } as never;
    await expect(writer.record(row)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith("SELECT analytics_record_event($1::jsonb) AS inserted", [
      '{"id":"x"}',
    ]);
  });
});

describe("задача analytics.record", () => {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = { context: systemContext(null), jobId: "7", attempt: 1, logger };

  it("валидное событие пишется строкой журнала", async () => {
    const record = vi.fn().mockResolvedValue(true);
    const handlers = createHandlers({ analytics: { record } });
    await expect(handlers["analytics.record"]({ event }, ctx)).resolves.toEqual({
      eventId: event.eventId,
      inserted: true,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        id: event.eventId,
        event_name: "place_viewed",
        schema_version: 1,
        anonymous_id: U,
        pseudonymous_user_id: null,
        source: "qr",
        properties: { placeId: U },
      }),
    );
  });

  it("невалидное событие — UnrecoverableError и предупреждение в логе без значений полей", async () => {
    const record = vi.fn();
    const handlers = createHandlers({ analytics: { record } });
    const bad = { ...event, props: { placeId: U, phone: "+380501234567" } } as never;
    await expect(handlers["analytics.record"]({ event: bad }, ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(record).not.toHaveBeenCalled();
    const warned = String(logger.warn.mock.calls.at(-1)?.[0]);
    expect(warned).toMatch(/analytics\.record 7: событие отклонено схемой: props: unrecognized_keys/);
    expect(warned).not.toContain("+380");
  });

  it("регион контекста задачи не совпадает с regionId события — UnrecoverableError, запись не делается", async () => {
    const record = vi.fn();
    const handlers = createHandlers({ analytics: { record } });
    const R = "0192f0c1-7a2b-7c3d-8e4f-0000000000aa";
    const other = { ...ctx, context: systemContext(R) };
    await expect(handlers["analytics.record"]({ event }, other)).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      handlers["analytics.record"]({ event: { ...event, regionId: R } }, ctx),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(record).not.toHaveBeenCalled();
    // Совпадение (без учёта регистра uuid) — пишется.
    record.mockResolvedValue(true);
    await handlers["analytics.record"]({ event: { ...event, regionId: R.toUpperCase() } }, other);
    expect(record).toHaveBeenCalledOnce();
  });

  it.each(["23503", "23514", "22P02"])(
    "постоянная ошибка БД %s — UnrecoverableError без значений (сразу в dead-letter, без ретраев)",
    async (code) => {
      const dbErr = Object.assign(new Error("insert ... violates (+380501234567)"), {
        code,
        constraint: "analytics_events_region_id_fkey",
      });
      const handlers = createHandlers({ analytics: { record: vi.fn().mockRejectedValue(dbErr) } });
      const err = await handlers["analytics.record"]({ event }, ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnrecoverableError);
      expect((err as Error).message).toBe(`постоянная ошибка БД ${code} (analytics_events_region_id_fkey)`);
      expect((err as Error).message).not.toContain("+380");
    },
  );

  it("временная ошибка БД (связь, 40001, 57P01) — исходная ошибка, задача ретраится", async () => {
    for (const dbErr of [
      new Error("connect ECONNREFUSED"),
      Object.assign(new Error("serialization"), { code: "40001" }),
      Object.assign(new Error("admin shutdown"), { code: "57P01" }),
    ]) {
      const handlers = createHandlers({ analytics: { record: vi.fn().mockRejectedValue(dbErr) } });
      await expect(handlers["analytics.record"]({ event }, ctx)).rejects.toBe(dbErr);
    }
  });

  it("без подключения к БД — UnrecoverableError (без ретраев)", async () => {
    await expect(defaultHandlers["analytics.record"]({ event }, ctx)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
