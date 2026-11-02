// Unit (без БД): IdempotencyInterceptor на тестовых эндпоинтах с хранилищем в памяти (T1-14).
// Те же сценарии на реальной PostgreSQL — test/integration/idempotency.test.ts.
import { randomUUID } from "node:crypto";
import { Logger, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdempotencyProbeController } from "../../../test/support/idempotency-probe.js";
import { recordingDb } from "../../../test/support/recording-db.js";
import { AppModule } from "../../app.module.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TENANT_CONTEXT_SOURCE } from "../../common/tenancy/index.js";
import {
  currentTenant,
  DATABASE,
  DatabaseModule,
  SYSTEM_CONTEXT,
  type IdempotencyKey,
  type JsonObject,
} from "../../db/index.js";
import { IDEMPOTENCY_STORE, IdempotencyModule, type ClaimResult, type IdempotencyStore } from "./index.js";

/** Хранилище в памяти с той же семантикой claim, что у IdempotencyKeysRepository (без истечения TTL). */
class MemoryStore implements IdempotencyStore {
  rows = new Map<string, IdempotencyKey>();
  /** Был ли tenant-контекст при вызовах хранилища (должен отсутствовать: интерсептор снаружи транзакции). */
  tenantSeen = false;
  /** Сколько раз вызван claim (синхронизация параллельных тестов). */
  claimCalls = 0;

  claim(input: {
    scope: string;
    key: string;
    requestHash: string;
    ttlSeconds: number;
  }): Promise<ClaimResult> {
    this.claimCalls++;
    if (currentTenant()) this.tenantSeen = true;
    const id = `${input.scope}|${input.key}`;
    const row = this.rows.get(id);
    if (!row) {
      const now = new Date();
      const created: IdempotencyKey = {
        id,
        scope: input.scope,
        key: input.key,
        request_hash: input.requestHash,
        status: "in_progress",
        response_status: null,
        response_body: null,
        expires_at: new Date(now.getTime() + input.ttlSeconds * 1000),
        created_at: now,
        updated_at: now,
      };
      this.rows.set(id, created);
      return Promise.resolve({ acquired: true, row: { ...created } });
    }
    if (row.status === "failed" && row.request_hash === input.requestHash) {
      row.status = "in_progress";
      return Promise.resolve({ acquired: true, row: { ...row } });
    }
    return Promise.resolve({ acquired: false, row: { ...row } });
  }

  complete(id: string, responseStatus: number, responseBody: JsonObject): Promise<void> {
    if (currentTenant()) this.tenantSeen = true;
    const row = this.rows.get(id);
    if (row?.status === "in_progress")
      Object.assign(row, {
        status: "completed",
        response_status: responseStatus,
        response_body: responseBody,
      });
    return Promise.resolve();
  }

  fail(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row?.status === "in_progress") row.status = "failed";
    return Promise.resolve();
  }
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

describe("IdempotencyInterceptor (хранилище в памяти)", () => {
  let app: INestApplication;
  let probe: IdempotencyProbeController;
  let url: string;
  const store = new MemoryStore();
  const post = (path: string, key?: string) => {
    const r = request(url).post(`/t114/${path}`);
    return key === undefined ? r : r.set("Idempotency-Key", key);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        IdempotencyModule,
      ],
      controllers: [IdempotencyProbeController],
    })
      .overrideProvider(DATABASE)
      .useValue(recordingDb().db)
      .overrideProvider(IDEMPOTENCY_STORE)
      .useValue(store)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Актор для эндпоинта без allowAnonymous: в тестах — из заголовка (до T1-26).
    app.use((req: { headers: Record<string, unknown>; user?: unknown }, _res: unknown, next: () => void) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") req.user = { id };
      next();
    });
    configureApp(app, { appEnv: "prod" });
    // Один порт на все запросы: supertest с getHttpServer() без listen открывает listen на каждый запрос, при
    // параллельных запросах это даёт ECONNRESET.
    await app.listen(0, "127.0.0.1");
    url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    probe = app.get(IdempotencyProbeController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    probe.reset();
    store.rows.clear();
    store.claimCalls = 0;
  });

  it("без заголовка или с некорректным ключом → 400 IDEMPOTENCY_KEY_REQUIRED, обработчик не вызван", async () => {
    for (const res of [await post("payments").send({}), await post("payments", "a b").send({})]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({
        code: "IDEMPOTENCY_KEY_REQUIRED",
        messageKey: "errors.idempotencyKeyRequired",
      });
    }
    expect(probe.effects.payments).toBe(0);
  });

  it("эндпоинт без @Idempotent заголовка не требует", async () => {
    await post("plain").send({}).expect(201, { plain: 1 });
  });

  it("повтор с тем же ключом → тот же статус и тело, эффект 1 раз; порядок полей тела не важен", async () => {
    const key = randomUUID();
    const first = await post("payments", key).send({ amountMinor: 100, note: "a" }).expect(201);
    expect(first.body).toEqual({ paymentId: "p1", amountMinor: 100, at: "1970-01-01T00:00:00.000Z" });
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    const again = await post("payments", key).send({ note: "a", amountMinor: 100 }).expect(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(probe.effects.payments).toBe(1);
    // Другой ключ — новый эффект.
    await post("payments", randomUUID()).send({ amountMinor: 100 }).expect(201, {
      paymentId: "p2",
      amountMinor: 100,
      at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("@HttpCode(200) сохраняется и повторяется", async () => {
    const key = randomUUID();
    await post("refunds", key).send({}).expect(200, { refundId: "r1" });
    await post("refunds", key).send({}).expect(200, { refundId: "r1" });
    expect([...store.rows.values()][0]).toMatchObject({ status: "completed", response_status: 200 });
    expect(probe.effects.refunds).toBe(1);
  });

  it("тот же ключ с другим телом → 422 IDEMPOTENCY_KEY_REUSED, эффекта нет", async () => {
    const key = randomUUID();
    await post("payments", key).send({ amountMinor: 100 }).expect(201);
    const res = await post("payments", key).send({ amountMinor: 999 }).expect(422);
    expect(res.body.error).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      messageKey: "errors.idempotencyKeyReused",
    });
    expect(probe.effects.payments).toBe(1);
  });

  it("ключи разных маршрутов не пересекаются (область — метод + путь)", async () => {
    const key = randomUUID();
    await post("payments", key).send({}).expect(201);
    await post("refunds", key).send({}).expect(200, { refundId: "r1" });
  });

  it("параллельный повтор, пока первый в обработке → 409 IDEMPOTENCY_IN_PROGRESS c Retry-After; эффект 1 раз", async () => {
    const key = randomUUID();
    let release!: () => void;
    probe.hold = new Promise((r) => (release = r));
    const first = post("payments", key)
      .send({ amountMinor: 1 })
      .then((r) => r);
    await until(() => probe.effects.payments === 1);

    const second = await post("payments", key).send({ amountMinor: 1 }).expect(409);
    expect(second.body.error).toMatchObject({
      code: "IDEMPOTENCY_IN_PROGRESS",
      messageKey: "errors.idempotencyInProgress",
    });
    expect(second.headers["retry-after"]).toBe("1");

    release();
    expect((await first).status).toBe(201);
    await post("payments", key).send({ amountMinor: 1 }).expect(201);
    expect(probe.effects.payments).toBe(1);
  });

  it("два одновременных запроса → ровно 1 эффект: один 201, другой 409", async () => {
    const key = randomUUID();
    let release!: () => void;
    probe.hold = new Promise((r) => (release = r));
    const both = Promise.all(
      [0, 1].map(() =>
        post("payments", key)
          .send({ amountMinor: 5 })
          .then((r) => r),
      ),
    );
    // Отпускаем первый, только когда оба запроса прошли claim (второй получил отказ).
    await until(() => probe.effects.payments === 1 && store.claimCalls === 2);
    release();
    const statuses = (await both).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(probe.effects.payments).toBe(1);
  });

  it("4xx обработчика сохраняется: повтор — та же ошибка (code/messageKey/details), новый correlationId, без эффекта", async () => {
    const key = randomUUID();
    const first = await post("rejected", key).send({ a: 1 }).expect(409);
    const again = await post("rejected", key).send({ a: 1 }).expect(409);
    expect(first.body.error).toMatchObject({
      code: "CONFLICT",
      messageKey: "errors.t114.rejected",
      details: { reason: "limit" },
    });
    expect({ ...again.body.error, correlationId: "" }).toEqual({ ...first.body.error, correlationId: "" });
    expect(again.body.error.correlationId).toBe(again.headers["x-request-id"]);
    expect(again.body.error.correlationId).not.toBe(first.body.error.correlationId);
    expect(probe.effects.rejected).toBe(1);
  });

  it("5xx обработчика → ключ failed: повтор с тем же телом выполняет обработчик снова; с другим — 422", async () => {
    const key = randomUUID();
    await post("broken", key).send({ a: 1 }).expect(500);
    expect([...store.rows.values()][0]?.status).toBe("failed");
    await post("broken", key).send({ a: 2 }).expect(422);
    probe.broken = false;
    await post("broken", key).send({ a: 1 }).expect(201, { attempt: 2 });
    await post("broken", key).send({ a: 1 }).expect(201, { attempt: 2 });
    expect(probe.effects.broken).toBe(2);
  });

  it("408 и 429 обработчика — временные: ключ failed, повтор с тем же телом выполняет обработчик снова", async () => {
    for (const status of [408, 429]) {
      probe.reset();
      probe.transientStatus = status;
      const key = randomUUID();
      await post("transient", key).send({}).expect(status);
      expect(store.rows.get(`anon:POST /t114/transient|${key}`)?.status).toBe("failed");
      probe.broken = false;
      await post("transient", key).send({}).expect(201, { attempt: 2 });
    }
  });

  it("без актора и без allowAnonymous → 500 INTERNAL, ключ не захвачен, эффекта нет; с актором — область user:<id>", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const res = await post("strict", randomUUID()).send({}).expect(500);
      expect(res.body.error.code).toBe("INTERNAL");
      expect(error).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("нет аутентифицированного актора"),
      );
    } finally {
      error.mockRestore();
    }
    expect(store.rows.size).toBe(0);
    expect(probe.effects.strict).toBe(0);
    const key = randomUUID();
    await post("strict", key).set("x-test-user", "u1").send({}).expect(201, { strict: 1 });
    await post("strict", key).set("x-test-user", "u1").send({}).expect(201, { strict: 1 });
    // Тот же ключ у другого пользователя — своя область, свой эффект.
    await post("strict", key).set("x-test-user", "u2").send({}).expect(201, { strict: 2 });
    expect([...store.rows.keys()].sort()).toEqual([
      `user:u1:POST /t114/strict|${key}`,
      `user:u2:POST /t114/strict|${key}`,
    ]);
  });

  it("ошибка записи результата не меняет ответ клиенту (лог error), ключ остаётся in_progress", async () => {
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const complete = vi.spyOn(store, "complete").mockRejectedValueOnce(new Error("БД недоступна"));
    try {
      const key = randomUUID();
      await post("payments", key).send({}).expect(201);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Не удалось сохранить"), expect.any(String));
      await post("payments", key).send({}).expect(409);
      expect(probe.effects.payments).toBe(1);
    } finally {
      complete.mockRestore();
      error.mockRestore();
    }
  });
});

describe("AppModule: IdempotencyInterceptor снаружи транзакции запроса (TenantContextInterceptor)", () => {
  let app: INestApplication;
  const store = new MemoryStore();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ DATABASE_URL: "postgres://u:p@127.0.0.1:1/db" })],
      controllers: [IdempotencyProbeController],
    })
      .overrideProvider(DATABASE)
      .useValue(recordingDb().db)
      .overrideProvider(TENANT_CONTEXT_SOURCE)
      .useValue({ resolve: () => SYSTEM_CONTEXT })
      .overrideProvider(IDEMPOTENCY_STORE)
      .useValue(store)
      .compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "prod" });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("обработчик — в tenant-контексте, захват и сохранение ключа — вне его", async () => {
    const key = randomUUID();
    await request(app.getHttpServer())
      .post("/t114/payments")
      .set("Idempotency-Key", key)
      .send({})
      .expect(201);
    expect(app.get(IdempotencyProbeController).lastTenant).toEqual(SYSTEM_CONTEXT);
    expect(store.tenantSeen).toBe(false);
    expect([...store.rows.values()][0]?.status).toBe("completed");
  });
});
