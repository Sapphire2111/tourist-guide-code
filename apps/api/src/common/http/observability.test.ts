import { afterEach, describe, expect, it } from "vitest";
import { Controller, Get, Logger, Param, Res, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  createErrorTracker,
  JsonLogger,
  MetricsRegistry,
  type AppEnv,
  type ErrorTracker,
} from "@tg/server-config";
import { configureApp } from "../../bootstrap/configure-app.js";

const INIT_DATA =
  "query_id=AAHdF6IQ&user=%7B%22id%22%3A279058397%2C%22phone%22%3A%22%2B380671234567%22%7D&auth_date=1662771648&hash=c501b71e775f74ce";

@Controller("obs")
class ObsController {
  private readonly logger = new Logger("Obs");

  @Get("items/:id")
  item(@Param("id") id: string) {
    this.logger.log(`item ${id}`);
    return { id };
  }

  @Get("partial")
  partial(@Res() res: { status(c: number): { write(s: string): void } }): never {
    // Ответ начат, затем ошибка: фильтр не должен пытаться отправить второй ответ.
    res.status(200).write("частичный ответ");
    throw new Error("сбой после заголовков");
  }

  @Get("boom")
  boom(): never {
    // Неосторожное сообщение с ПДн: в лог и трекер оно должно попасть замаскированным.
    throw new Error(`сбой для +380671234567, initData ${INIT_DATA}`);
  }
}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function createApp(opts: { appEnv?: AppEnv; metricsToken?: string } = {}) {
  const lines: string[] = [];
  const captured: { error: unknown; tags: unknown }[] = [];
  const metrics = new MetricsRegistry();
  const moduleRef = await Test.createTestingModule({ controllers: [ObsController] }).compile();
  const logger = new JsonLogger({ service: "api", write: (l) => lines.push(l) });
  // Реальный трекер «в лог» + перехват вызовов.
  const inner = createErrorTracker({ service: "api", environment: "local", logger });
  const tracker: ErrorTracker = {
    captureException: (error, tags) => {
      captured.push({ error, tags });
      inner.captureException(error, tags);
    },
    flush: async () => {},
  };
  app = configureApp(moduleRef.createNestApplication({ logger }), {
    appEnv: opts.appEnv ?? "local",
    metrics,
    errorTracker: tracker,
    ...(opts.metricsToken ? { metricsToken: opts.metricsToken } : {}),
  });
  await app.init();
  return { server: app.getHttpServer(), lines, captured, metrics };
}

describe("наблюдаемость api (T1-18)", () => {
  it("JSON-лог запроса несёт correlationId из X-Request-Id", async () => {
    const { server, lines } = await createApp();
    await request(server).get("/obs/items/42").set("X-Request-Id", "req-abc").expect(200);
    const entry = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.msg === "item 42");
    expect(entry).toMatchObject({ level: "info", service: "api", context: "Obs", correlationId: "req-abc" });
  });

  it("500: трекер получает ошибку с correlationId; в логах нет initData и телефона", async () => {
    const { server, lines, captured } = await createApp();
    const res = await request(server)
      .get("/obs/boom")
      .set("X-Request-Id", "req-500")
      .set("Authorization", `tma ${INIT_DATA}`)
      .expect(500);
    expect(res.body.error).toMatchObject({ code: "INTERNAL", correlationId: "req-500" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.tags).toMatchObject({ correlationId: "req-500", status: 500 });
    const all = lines.join("\n");
    expect(all).toContain('"correlationId":"req-500"');
    expect(all).not.toMatch(/auth_date|hash=|279058397|380671234567/);
    // Одна запись об ошибке на 500 (трекер «в лог»), без дубля от фильтра.
    expect(lines.filter((l) => l.includes('"level":"error"'))).toHaveLength(1);
  });

  it("ошибка после отправки заголовков: без второго ответа и без падения процесса", async () => {
    const { server, captured } = await createApp();
    const res = await request(server).get("/obs/partial");
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
  });

  it("404: метка route=unmatched, фактический путь в метки не попадает; POST /metrics — не метрики", async () => {
    const { server } = await createApp();
    await request(server).get("/no/such/path/123").expect(404);
    await request(server).post("/metrics").expect(404);
    await request(server).get("/metrics/extra").expect(404);
    const text = (await request(server).get("/metrics").expect(200)).text;
    expect(text).toContain('http_requests_total{method="GET",route="unmatched",status="404"} 2');
    expect(text).not.toContain("/no/such/path");
  });

  it("RED-метрики по шаблону маршрута, а не по фактическому пути; /metrics в формате Prometheus", async () => {
    const { server } = await createApp();
    await request(server).get("/obs/items/1").expect(200);
    await request(server).get("/obs/items/2").expect(200);
    await request(server).get("/obs/boom").expect(500);
    const res = await request(server).get("/metrics").expect(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain('http_requests_total{method="GET",route="/obs/items/:id",status="200"} 2');
    expect(res.text).toContain('http_errors_total{method="GET",route="/obs/boom"} 1');
    expect(res.text).toContain('http_request_duration_seconds_count{method="GET",route="/obs/items/:id"} 2');
    expect(res.text).not.toContain("/obs/items/1");
  });

  it("prod без METRICS_TOKEN — /metrics нет; с токеном — только по Bearer", async () => {
    const noToken = await createApp({ appEnv: "prod" });
    await request(noToken.server).get("/metrics").expect(404);
    await app?.close();
    const withToken = await createApp({ appEnv: "prod", metricsToken: "s3cret" });
    await request(withToken.server).get("/metrics").expect(404);
    await request(withToken.server).get("/metrics").set("Authorization", "Bearer s3cret").expect(200);
  });
});
