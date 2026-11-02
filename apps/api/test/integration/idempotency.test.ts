// T1-14: Idempotency-Key на реальной PostgreSQL (таблица idempotency_keys, миграция 0002).
// Тестовые эндпоинты — test/support/idempotency-probe.ts; effects — сколько раз выполнился обработчик.
// Приложение слушает один порт (listen(0)), запросы — на его URL: supertest с getHttpServer() без listen поднимает
// эфемерный listen на каждый запрос, и при параллельных запросах это давало ECONNRESET.
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { configureApp } from "../../src/bootstrap/configure-app.js";
import { TenancyModule, TENANT_CONTEXT_SOURCE } from "../../src/common/tenancy/index.js";
import { DatabaseModule, SYSTEM_CONTEXT } from "../../src/db/index.js";
import { IdempotencyKeysRepository, IdempotencyModule } from "../../src/modules/idempotency/index.js";
import { IdempotencyProbeController } from "../support/idempotency-probe.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

type Probe = { app: INestApplication; url: string; probe: IdempotencyProbeController };

/** Приложение с тестовыми эндпоинтами на реальной БД; withSystemTenant — обработчик в withTenant(SYSTEM). */
async function startApp(connectionString: string, withSystemTenant = false): Promise<Probe> {
  let builder = Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString, maxConnections: 10 }),
      IdempotencyModule,
      TenancyModule,
    ],
    controllers: [IdempotencyProbeController],
  });
  if (withSystemTenant)
    builder = builder.overrideProvider(TENANT_CONTEXT_SOURCE).useValue({ resolve: () => SYSTEM_CONTEXT });
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "prod" });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  return { app, url: `http://127.0.0.1:${address.port}`, probe: app.get(IdempotencyProbeController) };
}

/** Promise и функция, которая его выполняет. */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((r) => (fire = r));
  return { promise, fire };
}

describe.skipIf(!dockerAvailable)(`Idempotency-Key на PostgreSQL (T1-14)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let main: Probe;
  let probe: IdempotencyProbeController;
  let repo: IdempotencyKeysRepository;
  const post = (path: string, key: string, target: Probe = main) =>
    request(target.url).post(`/t114/${path}`).set("Idempotency-Key", key);
  const rowsOf = async (key: string) =>
    (
      await tdb!.client.query(
        "SELECT scope, status, response_status, response_body FROM idempotency_keys WHERE key = $1",
        [key],
      )
    ).rows as { scope: string; status: string; response_status: number | null; response_body: unknown }[];
  const expire = (key: string) =>
    tdb!.client.query("UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = $1", [
      key,
    ]);

  beforeAll(async () => {
    tdb = await startDatabase();
    main = await startApp(tdb.container.getConnectionUri());
    probe = main.probe;
    repo = main.app.get(IdempotencyKeysRepository);
  });

  afterAll(async () => {
    await main?.app.close();
    await stopDatabase(tdb);
  });

  beforeEach(() => {
    probe.reset();
  });

  it("повтор с тем же ключом → тот же ответ, эффект 1 раз; в БД — completed с ответом", async () => {
    const key = randomUUID();
    const first = await post("payments", key).send({ amountMinor: 100 }).expect(201);
    const again = await post("payments", key).send({ amountMinor: 100 }).expect(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(probe.effects.payments).toBe(1);
    expect(await rowsOf(key)).toEqual([
      {
        scope: "anon:POST /t114/payments",
        status: "completed",
        response_status: 201,
        response_body: { value: first.body },
      },
    ]);
  });

  it("тот же ключ с другим телом → 422 IDEMPOTENCY_KEY_REUSED, эффекта нет", async () => {
    const key = randomUUID();
    await post("payments", key).send({ amountMinor: 100 }).expect(201);
    const res = await post("payments", key).send({ amountMinor: 101 }).expect(422);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(probe.effects.payments).toBe(1);
  });

  it("2 параллельных запроса: второй стартует, когда первый занял ключ → 409 с Retry-After; ровно 1 эффект", async () => {
    const key = randomUUID();
    const entered = signal();
    const hold = signal();
    probe.entered = entered.fire;
    probe.hold = hold.promise;
    const first = post("payments", key)
      .send({ amountMinor: 7 })
      .then((r) => r);
    await entered.promise; // обработчик первого запроса выполняется — ключ точно захвачен
    const second = await post("payments", key).send({ amountMinor: 7 }).expect(409);
    expect(second.headers["retry-after"]).toBe("1");
    expect(second.body.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    hold.fire();
    expect((await first).status).toBe(201);
    expect(probe.effects.payments).toBe(1);
  });

  it("10 одновременных запросов без задержки → ровно 1 эффект; остальные — 409 или повтор того же ответа", async () => {
    const key = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 10 }, () =>
        post("payments", key)
          .send({ amountMinor: 3 })
          .then((r) => r),
      ),
    );
    expect(probe.effects.payments).toBe(1);
    const ok = res.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of ok) expect(r.body.paymentId).toBe("p1");
    expect(res.every((r) => r.status === 201 || r.status === 409)).toBe(true);
  });

  it("claim() из двух соединений одновременно — захватывает ровно один", async () => {
    const input = { scope: "test:claim", key: randomUUID(), requestHash: "a".repeat(64), ttlSeconds: 60 };
    const results = await Promise.all([repo.claim(input), repo.claim(input)]);
    expect(results.map((r) => r.acquired).sort()).toEqual([false, true]);
  });

  it("5xx → failed; повтор с тем же телом выполняет обработчик снова и сохраняет ответ", async () => {
    const key = randomUUID();
    await post("broken", key).send({ a: 1 }).expect(500);
    expect((await rowsOf(key))[0]?.status).toBe("failed");
    probe.broken = false;
    await post("broken", key).send({ a: 1 }).expect(201, { attempt: 2 });
    await post("broken", key).send({ a: 1 }).expect(201, { attempt: 2 });
    expect((await rowsOf(key))[0]).toMatchObject({ status: "completed", response_status: 201 });
  });

  it("два одновременных повтора после failed → обработчик выполняет ровно один", async () => {
    const key = randomUUID();
    await post("broken", key).send({ a: 1 }).expect(500);
    probe.broken = false;
    const res = await Promise.all(
      [0, 1].map(() =>
        post("broken", key)
          .send({ a: 1 })
          .then((r) => r),
      ),
    );
    expect(probe.effects.broken).toBe(2); // 1 сбой + 1 успешный повтор
    expect(res.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    for (const r of res.filter((x) => x.status === 201)) expect(r.body).toEqual({ attempt: 2 });
  });

  it("4xx сохраняется и повторяется без эффекта", async () => {
    const key = randomUUID();
    await post("rejected", key).send({}).expect(409);
    const again = await post("rejected", key).send({}).expect(409);
    expect(again.body.error).toMatchObject({ code: "CONFLICT", messageKey: "errors.t114.rejected" });
    expect(probe.effects.rejected).toBe(1);
    expect((await rowsOf(key))[0]).toMatchObject({ status: "completed", response_status: 409 });
  });

  it("429 обработчика — временная: failed, повтор выполняет обработчик снова", async () => {
    const key = randomUUID();
    await post("transient", key).send({}).expect(429);
    expect((await rowsOf(key))[0]?.status).toBe("failed");
    probe.broken = false;
    await post("transient", key).send({}).expect(201, { attempt: 2 });
  });

  it("истёкший ключ: claim() занимает его заново (и с другим телом); deleteExpired() удаляет истёкшие", async () => {
    const key = randomUUID();
    await post("payments", key).send({ amountMinor: 1 }).expect(201);
    await expire(key);
    await post("payments", key).send({ amountMinor: 2 }).expect(201);
    expect(probe.effects.payments).toBe(2);

    const stale = randomUUID();
    await post("payments", stale).send({}).expect(201);
    await expire(stale);
    expect(await repo.deleteExpired()).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(stale)).toEqual([]);
    expect(await rowsOf(key)).toHaveLength(1);
  });

  it("параллельный захват истёкшего ключа → ровно 1 эффект", async () => {
    const key = randomUUID();
    await post("payments", key).send({ amountMinor: 1 }).expect(201);
    await expire(key);
    const res = await Promise.all(
      Array.from({ length: 5 }, () =>
        post("payments", key)
          .send({ amountMinor: 9 })
          .then((r) => r),
      ),
    );
    expect(probe.effects.payments).toBe(2); // первый запрос + один после истечения
    expect(res.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect((await rowsOf(key))[0]).toMatchObject({ status: "completed", response_status: 201 });
  });

  describe("с tenant-контекстом (TenantContextInterceptor → withTenant на реальном пуле)", () => {
    let tenantApp: Probe;

    beforeAll(async () => {
      tenantApp = await startApp(tdb!.container.getConnectionUri(), true);
    });

    afterAll(async () => {
      await tenantApp?.app.close();
    });

    it("захват закоммичен до транзакции запроса (виден другому соединению), обработчик в withTenant, затем completed", async () => {
      const p = tenantApp.probe;
      p.reset();
      const key = randomUUID();
      const entered = signal();
      const hold = signal();
      p.entered = entered.fire;
      p.hold = hold.promise;
      const first = post("payments", key, tenantApp)
        .send({ amountMinor: 1 })
        .then((r) => r);
      await entered.promise;
      // Транзакция запроса ещё открыта, а запись ключа уже видна снаружи — захват не в ней.
      expect((await rowsOf(key))[0]?.status).toBe("in_progress");
      expect(p.lastTenant).toEqual(SYSTEM_CONTEXT);
      await post("payments", key, tenantApp).send({ amountMinor: 1 }).expect(409);
      hold.fire();
      expect((await first).status).toBe(201);
      expect((await rowsOf(key))[0]).toMatchObject({ status: "completed", response_status: 201 });
      await post("payments", key, tenantApp).send({ amountMinor: 1 }).expect(201);
      expect(p.effects.payments).toBe(1);
    });
  });
});
