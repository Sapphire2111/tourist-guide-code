import { afterEach, describe, expect, it } from "vitest";
import { Controller, Get, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { configureApp } from "../../bootstrap/configure-app.js";
import { HealthModule } from "../health/index.js";
import { clientIpKey } from "./rate-limit.interceptor.js";
import {
  MemoryRateLimitStore,
  RATE_LIMIT_STORE,
  RateLimit,
  RateLimitModule,
  type RateLimitModuleOptions,
  type RateLimitStore,
} from "./index.js";

@Controller("rl-test")
class RlTestController {
  @Get("default")
  def(): { ok: true } {
    return { ok: true };
  }

  @Get("tight")
  @RateLimit({ limit: 2, windowSec: 30 })
  tight(): { ok: true } {
    return { ok: true };
  }
}

let app: INestApplication | undefined;

async function createApp(
  options: RateLimitModuleOptions,
  store?: RateLimitStore,
  trustProxyHops?: number,
): Promise<INestApplication> {
  let builder = Test.createTestingModule({
    imports: [RateLimitModule.forRoot(options), HealthModule],
    controllers: [RlTestController],
  });
  if (store) builder = builder.overrideProvider(RATE_LIMIT_STORE).useValue(store);
  const moduleRef = await builder.compile();
  const nest = moduleRef.createNestApplication({ logger: false });
  // Принципал из заголовка (вместо сессии T1-26) — чтобы проверить счётчик пользователя.
  nest.use(
    (req: { headers: Record<string, unknown>; principal?: unknown }, _res: unknown, next: () => void) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") req.principal = { userId: id };
      next();
    },
  );
  app = configureApp(nest, { appEnv: "local", trustProxyHops });
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("rate limit", () => {
  it("своё правило эндпоинта: превышение → 429 RATE_LIMITED в конверте и Retry-After", async () => {
    const a = await createApp({});
    const http = a.getHttpServer();
    await request(http).get("/rl-test/tight").expect(200);
    await request(http).get("/rl-test/tight").expect(200);
    const res = await request(http).get("/rl-test/tight").expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.body.error.correlationId).toEqual(expect.any(String));
    const retry = Number(res.headers["retry-after"]);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(30);
    // Другой эндпоинт — свой счётчик.
    await request(http).get("/rl-test/default").expect(200);
  });

  it("общий лимит на IP действует на все эндпоинты", async () => {
    const a = await createApp({ perIp: { limit: 3, windowSec: 60 } });
    const http = a.getHttpServer();
    await request(http).get("/rl-test/default").expect(200);
    await request(http).get("/rl-test/tight").expect(200);
    await request(http).get("/rl-test/default").expect(200);
    await request(http).get("/rl-test/default").expect(429);
  });

  it("с сессией общий IP-лимит не действует: пользователи за одним IP считаются отдельно", async () => {
    const a = await createApp({ perIp: { limit: 1, windowSec: 60 } });
    const http = a.getHttpServer();
    await request(http).get("/rl-test/default").set("x-test-user", "u1").expect(200);
    await request(http).get("/rl-test/default").set("x-test-user", "u2").expect(200);
    await request(http).get("/rl-test/default").set("x-test-user", "u3").expect(200);
    // Свой лимит эндпоинта — на пользователя.
    await request(http).get("/rl-test/tight").set("x-test-user", "u1").expect(200);
    await request(http).get("/rl-test/tight").set("x-test-user", "u1").expect(200);
    await request(http).get("/rl-test/tight").set("x-test-user", "u1").expect(429);
    await request(http).get("/rl-test/tight").set("x-test-user", "u2").expect(200);
  });

  it("с сессией действует общий потолок пользователя по всем эндпоинтам", async () => {
    const a = await createApp({ perUser: { limit: 2, windowSec: 60 } });
    const http = a.getHttpServer();
    await request(http).get("/rl-test/default").set("x-test-user", "u1").expect(200);
    await request(http).get("/rl-test/tight").set("x-test-user", "u1").expect(200);
    await request(http).get("/rl-test/default").set("x-test-user", "u1").expect(429);
    await request(http).get("/rl-test/default").set("x-test-user", "u2").expect(200);
  });

  it("IPv6: адреса одной /64 делят счётчик, другой /64 — свой", async () => {
    const a = await createApp({ perIp: { limit: 1, windowSec: 60 } }, undefined, 1);
    const http = a.getHttpServer();
    await request(http).get("/rl-test/default").set("X-Forwarded-For", "2001:db8:1:2::1").expect(200);
    await request(http).get("/rl-test/default").set("X-Forwarded-For", "2001:db8:1:2:aaaa::9").expect(429);
    await request(http).get("/rl-test/default").set("X-Forwarded-For", "2001:db8:1:3::1").expect(200);
  });

  it("/health не лимитируется", async () => {
    const a = await createApp({
      perIp: { limit: 1, windowSec: 60 },
      perEndpoint: { limit: 1, windowSec: 60 },
    });
    for (let i = 0; i < 5; i++) await request(a.getHttpServer()).get("/health").expect(200);
  });

  it("за прокси (trust proxy) клиенты с разными X-Forwarded-For считаются отдельно", async () => {
    const a = await createApp({ perIp: { limit: 1, windowSec: 60 } }, undefined, 1);
    const http = a.getHttpServer();
    await request(http).get("/rl-test/default").set("X-Forwarded-For", "203.0.113.1").expect(200);
    await request(http).get("/rl-test/default").set("X-Forwarded-For", "203.0.113.2").expect(200);
    await request(http).get("/rl-test/default").set("X-Forwarded-For", "203.0.113.1").expect(429);
  });

  it("без trust proxy X-Forwarded-For не помогает обойти лимит", async () => {
    const a = await createApp({ perIp: { limit: 1, windowSec: 60 } });
    const http = a.getHttpServer();
    await request(http).get("/rl-test/default").set("X-Forwarded-For", "203.0.113.1").expect(200);
    await request(http).get("/rl-test/default").set("X-Forwarded-For", "203.0.113.2").expect(429);
  });

  it("хранилище недоступно — запрос пропускается (fail-open)", async () => {
    const broken: RateLimitStore = { hit: () => Promise.reject(new Error("redis down")) };
    const a = await createApp({}, broken);
    await request(a.getHttpServer()).get("/rl-test/tight").expect(200);
  });

  it("enabled: false — лимиты не применяются", async () => {
    const a = await createApp({ enabled: false, perIp: { limit: 1, windowSec: 60 } });
    for (let i = 0; i < 3; i++) await request(a.getHttpServer()).get("/rl-test/default").expect(200);
  });
});

describe("clientIpKey", () => {
  it("IPv4 — как есть, IPv4-mapped — без ::ffff:, IPv6 — префикс /64", () => {
    expect(clientIpKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientIpKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientIpKey("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(clientIpKey("not-an-ip")).toBe("not-an-ip");
    expect(clientIpKey("2001:DB8:0001:0002:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(clientIpKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientIpKey("::1")).toBe("0:0:0:0::/64");
    expect(clientIpKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(clientIpKey(undefined)).toBe("unknown");
  });
});

describe("MemoryRateLimitStore", () => {
  it("окно сбрасывается по истечении", async () => {
    let now = 1_000;
    const store = new MemoryRateLimitStore(() => now);
    const k = [{ key: "a", windowMs: 1_000 }];
    expect(await store.hit(k)).toEqual([{ count: 1, resetMs: 1_000 }]);
    now += 400;
    expect(await store.hit(k)).toEqual([{ count: 2, resetMs: 600 }]);
    now += 600;
    expect(await store.hit(k)).toEqual([{ count: 1, resetMs: 1_000 }]);
  });
});
