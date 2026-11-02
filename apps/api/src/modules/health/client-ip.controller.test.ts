import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ClientIpDiagnosticsModule, HealthModule } from "./index.js";

describe("GET /health/client-ip (диагностика trust proxy)", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(appEnv: "staging" | "prod", hops: number): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule, ClientIpDiagnosticsModule.forRoot({ appEnv })],
    }).compile();
    const created = moduleRef.createNestApplication<NestExpressApplication>();
    created.set("trust proxy", hops);
    await created.init();
    app = created;
    return created;
  }

  it("вне prod отдаёт адрес клиента по trust proxy и цепочку X-Forwarded-For", async () => {
    const server = (await start("staging", 1)).getHttpServer();
    const res = await request(server)
      .get("/health/client-ip")
      .set("X-Forwarded-For", "203.0.113.5, 198.51.100.7");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ip: "198.51.100.7",
      ips: ["198.51.100.7"],
      forwardedFor: "203.0.113.5, 198.51.100.7",
    });
  });

  it("в prod маршрута нет, /health работает", async () => {
    const server = (await start("prod", 1)).getHttpServer();
    expect((await request(server).get("/health/client-ip")).status).toBe(404);
    expect((await request(server).get("/health")).status).toBe(200);
  });
});
