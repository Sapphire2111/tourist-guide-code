// Unit (без БД и Redis): POST /analytics/events — валидация пакета по каталогу @tg/shared, отказ целиком,
// запись direct-режимом (вызов analytics_record_event через Kysely) и очередью (задача analytics.record).
// На реальной PostgreSQL — test/integration/analytics.test.ts.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_SCHEMA_VERSION, type ErrorEnvelope } from "@tg/shared";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { ApiError } from "../../common/http/index.js";
import { TENANT_CONTEXT_SOURCE, TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import { AnalyticsModule, resolveAnalyticsSinkMode } from "./analytics.module.js";
import {
  ANALYTICS_SINK,
  AnalyticsUnknownRegionError,
  DirectAnalyticsSink,
  QueueAnalyticsSink,
} from "./analytics.sink.js";

const U = "0192f0c1-7a2b-7c3d-8e4f-0a1b2c3d4e5f";
const R = "0192f0c1-7a2b-7c3d-8e4f-0000000000aa";
function event(n: number, extra: Record<string, unknown> = {}) {
  return {
    eventId: `0192f0c1-7a2b-7c3d-8e4f-${String(n).padStart(12, "0")}`,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    anonymousId: U,
    regionId: R,
    source: "qr",
    event: "place_viewed",
    props: { placeId: U },
    ...extra,
  };
}

const REGIONS_SQL = 'select "id" from "regions" where "id" in ($1) for key share';
const REGIONS_SQL_2 = 'select "id" from "regions" where "id" in ($1, $2) for key share';
const RECORD_SQL = 'select analytics_record_event($1) as "inserted"';

/** Регионы, которые «есть в БД» (только R); запрос регионов отвечает только ими. */
async function start(
  sink?: { write: ReturnType<typeof vi.fn> },
  { clientEvents }: { clientEvents?: boolean } = {},
) {
  const { db, queries } = recordingDb({}, (q) =>
    q.sql.includes('"regions"')
      ? q.parameters.filter((id) => id === R).map((id) => ({ id }))
      : [{ inserted: true }],
  );
  let builder = Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      AnalyticsModule.forRoot({ mode: "direct", clientEvents }),
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db);
  if (sink) builder = builder.overrideProvider(ANALYTICS_SINK).useValue(sink);
  const app = configureApp((await builder.compile()).createNestApplication({ logger: false }), {
    appEnv: "prod",
  });
  await app.init();
  return { app, queries };
}

describe("POST /analytics/events", () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("валидный пакет — 202, одной транзакцией: регионы с блокировкой, затем события функцией БД", async () => {
    const started = await start();
    app = started.app;
    const res = await request(app.getHttpServer())
      .post("/analytics/events")
      .send({ events: [event(1), event(2, { event: "search_used", props: { resultCount: 2 } })] })
      .expect(202);
    expect(res.body).toEqual({ accepted: 2 });
    expect(started.queries.map((q) => q.sql)).toEqual([REGIONS_SQL, RECORD_SQL, RECORD_SQL]);
    expect(started.queries[0]!.parameters).toEqual([R]);
    expect(JSON.parse(String(started.queries[1]!.parameters[0]))).toMatchObject({
      id: event(1).eventId,
      event_name: "place_viewed",
      region_id: R,
      anonymous_id: U,
      source: "qr",
      place_id: U,
      properties: { placeId: U },
    });
  });

  it("несуществующий regionId — 400 с путём events.<i>.regionId, ни одно событие пакета не пишется", async () => {
    const started = await start();
    app = started.app;
    const ghost = "0192f0c1-7a2b-7c3d-8e4f-0000000000bb";
    const events = [
      event(1),
      event(2, { regionId: ghost }),
      event(3, { regionId: null }),
      event(4, { regionId: ghost }),
    ];
    const res = await request(app.getHttpServer()).post("/analytics/events").send({ events }).expect(400);
    const body = res.body as ErrorEnvelope;
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details?.fields).toEqual(
      [1, 3].map((i) => ({
        field: `events.${i}.regionId`,
        constraint: "not_found",
        messageKey: "errors.validation.not_found",
      })),
    );
    expect(started.queries.map((q) => q.sql)).toEqual([REGIONS_SQL_2]);
    expect(started.queries[0]!.parameters).toEqual([R, ghost]);
  });

  it("ошибка записи посреди пакета — исключение из транзакции (ROLLBACK всего пакета)", async () => {
    const { db } = recordingDb({}, (q) => {
      if (q.sql.includes('"regions"')) return [{ id: R }];
      if (String(q.parameters[0]).includes(event(2).eventId)) throw new Error("сбой БД");
      return [{ inserted: true }];
    });
    const trx = vi.spyOn(db, "transaction");
    await expect(new DirectAnalyticsSink(db).write([event(1), event(2)] as never)).rejects.toThrow("сбой БД");
    expect(trx).toHaveBeenCalledOnce();
  });

  it("клиент шлёт pseudonymousUserId — 400 unrecognized_keys на событии", async () => {
    const sink = { write: vi.fn() };
    app = (await start(sink)).app;
    const res = await request(app.getHttpServer())
      .post("/analytics/events")
      .send({ events: [event(1, { pseudonymousUserId: U })] })
      .expect(400);
    expect((res.body as ErrorEnvelope).error.details?.fields).toEqual([
      {
        field: "events.0",
        constraint: "unrecognized_keys",
        messageKey: "errors.validation.unrecognized_keys",
      },
    ]);
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("вне tenant-контекста: источник контекста не вызывается (сессия без назначения в регионе — не 403)", async () => {
    const { db } = recordingDb({}, (q) => (q.sql.includes('"regions"') ? [{ id: R }] : [{ inserted: true }]));
    const resolve = vi.fn(() => {
      throw new ApiError("FORBIDDEN");
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        TenancyModule,
        AnalyticsModule.forRoot({ mode: "direct" }),
      ],
    })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(TENANT_CONTEXT_SOURCE)
      .useValue({ resolve })
      .compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "prod" });
    await app.init();
    await request(app.getHttpServer())
      .post("/analytics/events")
      .send({ events: [event(1)] })
      .expect(202);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("приём выключен (ANALYTICS_CLIENT_EVENTS=off) — 404 NOT_FOUND, ничего не пишется", async () => {
    const sink = { write: vi.fn() };
    app = (await start(sink, { clientEvents: false })).app;
    const res = await request(app.getHttpServer())
      .post("/analytics/events")
      .send({ events: [event(1)] })
      .expect(404);
    expect((res.body as ErrorEnvelope).error.code).toBe("NOT_FOUND");
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("невалидное событие — 400 VALIDATION_FAILED с путём поля, пакет не пишется целиком", async () => {
    const started = await start();
    app = started.app;
    const bad = event(2, { props: { placeId: U, phone: "+380501234567" } });
    const res = await request(app.getHttpServer())
      .post("/analytics/events")
      .send({ events: [event(1), bad] })
      .expect(400);
    const body = res.body as ErrorEnvelope;
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.details?.fields).toEqual([
      {
        field: "events.1.props",
        constraint: "unrecognized_keys",
        messageKey: "errors.validation.unrecognized_keys",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("+380");
    expect(started.queries).toEqual([]);
  });

  it("серверное событие, pseudonymousUserId от клиента, время вне окна — 400", async () => {
    const sink = { write: vi.fn() };
    app = (await start(sink)).app;
    const cases = [
      event(1, { event: "ambassador_rewarded", props: { ambassadorId: U, rewardId: U } }),
      event(1, { pseudonymousUserId: U }),
      event(1, { eventId: "00000000-0000-0000-0000-000000000000" }),
      event(1, { eventId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }),
      event(1, { placeId: "0192f0c1-7a2b-7c3d-8e4f-00000000beef" }),
      event(1, { occurredAt: new Date(Date.now() + 3600_000).toISOString() }),
      event(1, { occurredAt: "2020-01-01T00:00:00Z" }),
    ];
    for (const e of cases) {
      const res = await request(app.getHttpServer())
        .post("/analytics/events")
        .send({ events: [e] });
      expect(res.status, JSON.stringify(e)).toBe(400);
    }
    for (const body of [{}, { events: [] }, [event(1)], "x"]) {
      const res = await request(app.getHttpServer())
        .post("/analytics/events")
        .send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(sink.write).not.toHaveBeenCalled();
  });
});

describe("запись событий через очередь", () => {
  it("одна задача analytics.record на событие, jobId из eventId, контекст SYSTEM региона", async () => {
    const add = vi.fn().mockResolvedValue({});
    const regions = vi.fn().mockResolvedValue(new Set([R]));
    const sink = new QueueAnalyticsSink({ name: "analytics", add }, regions);
    const e = { ...event(1), props: { placeId: U } } as never;
    await sink.write([e]);
    expect(regions).toHaveBeenCalledExactlyOnceWith([R]);
    expect(add).toHaveBeenCalledExactlyOnceWith(
      "analytics.record",
      { context: { actor: "SYSTEM", regionId: R }, payload: { event: e } },
      expect.objectContaining({ jobId: `analytics.record__${event(1).eventId}`, removeOnComplete: true }),
    );
  });

  it("несуществующий регион — весь пакет отклоняется до постановки задач", async () => {
    const add = vi.fn().mockResolvedValue({});
    const sink = new QueueAnalyticsSink({ name: "analytics", add }, async () => new Set<string>());
    const err = await sink.write([event(1, { regionId: null }), event(2)] as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyticsUnknownRegionError);
    expect((err as AnalyticsUnknownRegionError).indices).toEqual([1]);
    expect(add).not.toHaveBeenCalled();
  });

  it("без regionId в пакете регионы не запрашиваются", async () => {
    const add = vi.fn().mockResolvedValue({});
    const regions = vi.fn();
    const sink = new QueueAnalyticsSink({ name: "analytics", add }, regions);
    await sink.write([event(1, { regionId: null })] as never);
    expect(regions).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledOnce();
  });

  it("режим: queue при Redis, иначе direct; queue без Redis — ошибка", () => {
    expect(resolveAnalyticsSinkMode({ redisUrl: "redis://h:1" })).toBe("queue");
    expect(resolveAnalyticsSinkMode({})).toBe("direct");
    expect(resolveAnalyticsSinkMode({ mode: "direct", redisUrl: "redis://h:1" })).toBe("direct");
    expect(() => resolveAnalyticsSinkMode({ mode: "queue" })).toThrow(/REDIS_URL/);
  });
});
