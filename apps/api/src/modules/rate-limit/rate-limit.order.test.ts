// T1-24: порядок глобальных интерсепторов — 429 rate limit до захвата ключа идемпотентности (T1-14) и до
// tenant-транзакции (T1-10): отклонённый запрос не оставляет запись Idempotency-Key и не трогает БД.
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IdempotencyProbeController } from "../../../test/support/idempotency-probe.js";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TENANT_CONTEXT_SOURCE, TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import { IDEMPOTENCY_STORE, IdempotencyModule } from "../idempotency/index.js";
import { RateLimitModule } from "./index.js";

describe("rate limit раньше идемпотентности и tenant-транзакции", () => {
  let app: INestApplication;
  const claim = vi.fn();
  const resolveTenant = vi.fn();
  const recorded = recordingDb();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        // Порядок как в AppModule.
        RateLimitModule.forRoot({ perIp: { limit: 0, windowSec: 60 } }),
        IdempotencyModule,
        TenancyModule,
      ],
      controllers: [IdempotencyProbeController],
    })
      .overrideProvider(DATABASE)
      .useValue(recorded.db)
      .overrideProvider(IDEMPOTENCY_STORE)
      .useValue({ claim, complete: vi.fn(), fail: vi.fn() })
      .overrideProvider(TENANT_CONTEXT_SOURCE)
      .useValue({ resolve: resolveTenant })
      .compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("429: обработчик, claim ключа, источник tenant-контекста и БД не вызваны", async () => {
    const res = await request(app.getHttpServer())
      .post("/t114/payments")
      .set("Idempotency-Key", randomUUID())
      .send({ amountMinor: 100 })
      .expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(app.get(IdempotencyProbeController).effects.payments).toBe(0);
    expect(claim).not.toHaveBeenCalled();
    expect(resolveTenant).not.toHaveBeenCalled();
    expect(recorded.queries).toHaveLength(0);
  });
});
