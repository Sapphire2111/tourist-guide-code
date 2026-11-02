import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../app.module.js";
import { configureApp } from "./configure-app.js";

const ALLOWED = "https://miniapp.example.com";
let app: INestApplication | undefined;

async function createApp(
  corsOrigins?: readonly string[],
  appEnv: "local" | "staging" | "prod" = "local",
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ DATABASE_URL: "postgres://u:p@127.0.0.1:1/db" })],
  }).compile();
  app = configureApp(moduleRef.createNestApplication(), { appEnv, corsOrigins });
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("CORS", () => {
  it("preflight с разрешённого Origin → 204 и access-control-allow-origin", async () => {
    const a = await createApp([ALLOWED]);
    const res = await request(a.getHttpServer())
      .options("/health")
      .set("Origin", ALLOWED)
      .set("Access-Control-Request-Method", "GET")
      .expect(204);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers["access-control-max-age"]).toBe("600");
  });

  it("preflight с неразрешённого Origin → без access-control-allow-origin", async () => {
    const a = await createApp([ALLOWED]);
    const res = await request(a.getHttpServer())
      .options("/health")
      .set("Origin", "https://evil.example.com")
      .set("Access-Control-Request-Method", "GET")
      .expect(204); // cors завершает любой preflight сам; отказ — отсутствие allow-origin
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("без corsOrigins CORS выключен", async () => {
    for (const list of [undefined, []]) {
      const a = await createApp(list);
      const res = await request(a.getHttpServer())
        .options("/health")
        .set("Origin", ALLOWED)
        .set("Access-Control-Request-Method", "GET");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      await a.close();
      app = undefined;
    }
  });

  it("обычный GET с разрешённого Origin раскрывает x-request-id, Retry-After, Idempotent-Replayed", async () => {
    const a = await createApp([ALLOWED]);
    const res = await request(a.getHttpServer()).get("/health").set("Origin", ALLOWED).expect(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(
      String(res.headers["access-control-expose-headers"])
        .toLowerCase()
        .split(",")
        .map((h) => h.trim()),
    ).toEqual(["x-request-id", "retry-after", "idempotent-replayed"]);
  });
});

describe("заголовки безопасности (T1-24)", () => {
  it("JSON-ответ: nosniff, запрет фреймов, Referrer-Policy, строгая CSP, без X-Powered-By; в local без HSTS", async () => {
    const res = await request((await createApp()).getHttpServer())
      .get("/health")
      .expect(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("staging: HSTS; /docs — CSP, допускающая Swagger UI; ошибки тоже с заголовками", async () => {
    const http = (await createApp(undefined, "staging")).getHttpServer();
    const health = await request(http).get("/health").expect(200);
    expect(health.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    const docs = await request(http).get("/docs").redirects(1);
    expect(docs.status).toBe(200);
    expect(docs.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
    const missing = await request(http).get("/no-such-route").expect(404);
    expect(missing.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("обычный запрос с чужого Origin не получает access-control-allow-origin", async () => {
    const res = await request((await createApp([ALLOWED])).getHttpServer())
      .get("/health")
      .set("Origin", "https://evil.example.com")
      .expect(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
