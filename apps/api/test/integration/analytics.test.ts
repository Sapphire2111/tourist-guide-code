// T1-25: схема аналитических событий на реальной PostgreSQL (миграция 0007) и Redis — под ролью приложения:
// функция analytics_record_event пишет идемпотентно по eventId и от имени SYSTEM (RLS), POST /analytics/events
// в режиме direct — событие видно в analytics_events, невалидное — нет; в режиме queue — задача analytics.record
// в Redis (её разбирает worker: apps/worker, задача analytics.record вызывает ту же функцию).
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { toAnalyticsEventRow } from "@tg/queue-contract";
import { ANALYTICS_SCHEMA_VERSION, type AnalyticsEvent } from "@tg/shared";
import { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { configureApp } from "../../src/bootstrap/configure-app.js";
import { createDatabase, DatabaseModule, regionContext, withTenant, type Db } from "../../src/db/index.js";
import { AnalyticsEventsRepository, AnalyticsModule } from "../../src/modules/analytics/index.js";
import { DirectAnalyticsSink } from "../../src/modules/analytics/analytics.sink.js";
import { startDatabase, startRedis, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_analytics_test";
const APP_PASSWORD = "tg_api_analytics_test";

function event(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    eventId: randomUUID(),
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    anonymousId: randomUUID(),
    sessionId: randomUUID(),
    regionId: null,
    source: "qr",
    // Клиентское событие (app_opened эмитит сервер при входе, блок 2).
    event: "search_used",
    props: { resultCount: 3 },
    ...overrides,
  } as AnalyticsEvent;
}

describe.skipIf(!dockerAvailable)(`Аналитические события (T1-25)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let redis: StartedRedisContainer | undefined;
  let appUrl: string;
  let appDb: Db;
  let regionA: string;
  let regionB: string;

  /** Строка журнала по id — владельцем (мимо RLS). */
  const rowOf = async (id: string) =>
    (await tdb!.client.query("SELECT * FROM analytics_events WHERE id = $1", [id])).rows[0] as
      | Record<string, unknown>
      | undefined;

  async function startApp(options: Parameters<typeof AnalyticsModule.forRoot>[0]): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: appUrl, maxConnections: 2 }),
        AnalyticsModule.forRoot(options),
      ],
    }).compile();
    const app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "prod" });
    await app.init();
    return app;
  }

  beforeAll(async () => {
    [tdb, redis] = await Promise.all([startDatabase(), startRedis()]);
    const owner = tdb.client;
    await owner.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    const region = async (code: string) =>
      String(
        (
          await owner.query(
            `INSERT INTO regions (code, name_i18n) VALUES ($1, '{"uk": "Регіон"}') RETURNING id`,
            [code],
          )
        ).rows[0]!.id,
      );
    regionA = await region("t125-a");
    regionB = await region("t125-b");
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appUrl = url.toString();
    appDb = createDatabase({ connectionString: appUrl, maxConnections: 2 });
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await redis?.stop();
    await stopDatabase(tdb);
  });

  it("миграция 0007 применена", () => {
    expect(tdb!.applied).toContain("0007_analytics_events_schema.sql");
  });

  it("analytics_record_event: запись под ролью app без контекста, повтор с тем же id — no-op", async () => {
    const repo = new AnalyticsEventsRepository(appDb);
    const e = event({ regionId: regionA, placeId: randomUUID(), entryContextId: randomUUID() });
    expect(await repo.record(toAnalyticsEventRow(e))).toBe(true);
    expect(await repo.record(toAnalyticsEventRow(e))).toBe(false);
    expect(await rowOf(e.eventId)).toMatchObject({
      event_name: "search_used",
      schema_version: 1,
      region_id: regionA,
      anonymous_id: e.anonymousId,
      session_id: e.sessionId,
      pseudonymous_user_id: null,
      source: "qr",
      entry_context_id: e.entryContextId,
      place_id: e.placeId,
      properties: { resultCount: 3 },
    });
    // Контекст app.actor восстановлен: после вызова в транзакции региона чужой регион не виден.
    await withTenant(appDb, regionContext(regionB), async () => {
      expect(await repo.record(toAnalyticsEventRow(event({ regionId: regionB })))).toBe(true);
      expect((await repo.listByName("search_used")).every((r) => r.region_id === regionB)).toBe(true);
    });
  });

  it("CHECK источника: формат snake_case", async () => {
    const repo = new AnalyticsEventsRepository(appDb);
    const row = { ...toAnalyticsEventRow(event()), source: "QR code" };
    await expect(repo.record(row)).rejects.toMatchObject({ constraint: "analytics_events_source_format" });
  });

  it("POST /analytics/events (direct): тестовая эмиссия видна в хранилище, невалидная — нет", async () => {
    const app = await startApp({ mode: "direct" });
    try {
      const ok = event({ regionId: regionA, event: "place_viewed", props: { placeId: randomUUID() } });
      await request(app.getHttpServer())
        .post("/analytics/events")
        .send({ events: [ok] })
        .expect(202);
      expect(await rowOf(ok.eventId)).toMatchObject({ event_name: "place_viewed", region_id: regionA });

      const bad = event({ props: { resultCount: 1, phone: "+380501234567" } as never });
      await request(app.getHttpServer())
        .post("/analytics/events")
        .send({ events: [bad] })
        .expect(400);
      expect(await rowOf(bad.eventId)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("POST /analytics/events (direct): несуществующий regionId — 400 с путём, пакет не пишется целиком", async () => {
    const app = await startApp({ mode: "direct" });
    try {
      const ok = event({ regionId: regionA });
      const ghost = event({ regionId: randomUUID() });
      const res = await request(app.getHttpServer())
        .post("/analytics/events")
        .send({ events: [ok, ghost] })
        .expect(400);
      expect((res.body as { error: { code: string; details: { fields: unknown[] } } }).error).toMatchObject({
        code: "VALIDATION_FAILED",
        details: { fields: [{ field: "events.1.regionId", constraint: "not_found" }] },
      });
      expect(await rowOf(ok.eventId)).toBeUndefined();
      expect(await rowOf(ghost.eventId)).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("direct: пакет одной транзакцией — ошибка БД на втором событии откатывает первое", async () => {
    const sink = new DirectAnalyticsSink(appDb);
    const first = event({ regionId: regionA });
    // Обход схемы: строка с нарушением CHECK (23514) — имитация ошибки БД посреди пакета.
    const broken = { ...event(), source: "QR code" } as unknown as AnalyticsEvent;
    await expect(sink.write([first, broken])).rejects.toMatchObject({
      constraint: "analytics_events_source_format",
    });
    expect(await rowOf(first.eventId)).toBeUndefined();
    expect(await rowOf(broken.eventId)).toBeUndefined();
    // Тот же пакет без сломанного события пишется целиком.
    await sink.write([first]);
    expect(await rowOf(first.eventId)).toMatchObject({ region_id: regionA });
  });

  it("analytics_record_event: несуществующий регион — нарушение FK 23503 (постоянная ошибка для worker)", async () => {
    const repo = new AnalyticsEventsRepository(appDb);
    await expect(repo.record(toAnalyticsEventRow(event({ regionId: randomUUID() })))).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("POST /analytics/events (queue): несуществующий regionId — 400, задач в очереди нет", async () => {
    const redisUrl = redis!.getConnectionUrl();
    const app = await startApp({ mode: "queue", redisUrl });
    const queue = new Queue("analytics", { connection: { url: redisUrl } });
    try {
      const ghost = event({ regionId: randomUUID() });
      await request(app.getHttpServer())
        .post("/analytics/events")
        .send({ events: [event(), ghost] })
        .expect(400);
      expect(await queue.getJob(`analytics.record__${ghost.eventId}`)).toBeFalsy();
    } finally {
      await queue.close();
      await app.close();
    }
  });

  it("POST /analytics/events (queue): задача analytics.record в Redis, jobId из eventId", async () => {
    const redisUrl = redis!.getConnectionUrl();
    const app = await startApp({ mode: "queue", redisUrl });
    const queue = new Queue("analytics", { connection: { url: redisUrl } });
    try {
      const e = event();
      await request(app.getHttpServer())
        .post("/analytics/events")
        .send({ events: [e] })
        .expect(202);
      // Повтор того же события (ретрай клиента) — та же задача.
      await request(app.getHttpServer())
        .post("/analytics/events")
        .send({ events: [e] })
        .expect(202);
      const job = await queue.getJob(`analytics.record__${e.eventId}`);
      expect(job?.name).toBe("analytics.record");
      expect(job?.data).toEqual({ context: { actor: "SYSTEM", regionId: null }, payload: { event: e } });
      expect(await queue.getWaitingCount()).toBe(1);
    } finally {
      await queue.close();
      await app.close();
    }
  });
});
