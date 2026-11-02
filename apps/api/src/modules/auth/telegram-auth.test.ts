// Unit (Nest testing, хранилища в памяти): POST /auth/telegram — вход по initData, создание/обновление пользователя,
// сессия mini_app, события, отказ 401 + RiskFlag, логи без initData. SQL и RLS — test/integration/telegram-auth.test.ts.
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JsonLogger } from "@tg/server-config";
import type { ErrorEnvelope } from "@tg/shared";
import { identityApp, MemoryIdentity } from "../../../test/support/memory-identity.js";
import { RATE_LIMIT_RULE } from "../rate-limit/index.js";
import { hashSessionToken } from "./session-token.js";
import { TELEGRAM_LOGIN_RATE_LIMIT, TelegramAuthController } from "./telegram-auth.controller.js";
import { displayNameOf } from "./telegram-auth.service.js";
import { signInitDataFields } from "./telegram-init-data.js";

const BOT_TOKEN = "123456789:TEST-fake-token-for-unit-tests";
const TG_USER = {
  id: 279058397,
  first_name: "Олена",
  last_name: "Тестова",
  username: "olena_secret_name",
  language_code: "en",
  allows_write_to_pm: true,
};

function initData(fields: Record<string, string> = {}, token = BOT_TOKEN): string {
  const entries = Object.entries({
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify(TG_USER),
    auth_date: String(Math.floor(Date.now() / 1000) - 10),
    ...fields,
  });
  return new URLSearchParams([...entries, ["hash", signInitDataFields(entries, token)]]).toString();
}

type LoginBody = {
  token: string;
  session: { id: string; userId: string; channel: string };
  isNewUser: boolean;
  startParam: string | null;
};

describe("вход через Telegram (POST /auth/telegram)", () => {
  const mem = new MemoryIdentity();
  const lines: string[] = [];
  let app: INestApplication;

  beforeAll(async () => {
    app = await identityApp(mem, {
      botToken: BOT_TOKEN,
      logger: new JsonLogger({ service: "api", level: "trace", write: (l) => lines.push(l) }),
    });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    mem.reset();
    lines.length = 0;
  });

  const http = () => request(app.getHttpServer());
  const login = (body: object) => http().post("/auth/telegram").set("X-Request-Id", "req-tg").send(body);
  const code = (res: { body: unknown }) => (res.body as ErrorEnvelope).error.code;

  it("первый вход: пользователь + TelegramAccount, сессия mini_app, isNewUser, start_param как есть", async () => {
    const res = await login({ initData: initData({ start_param: "qr_Ab-12" }), platform: "android" }).expect(
      201,
    );
    const body = res.body as LoginBody;
    expect(body.token).toMatch(/^tgs_/);
    expect(body).toMatchObject({ isNewUser: true, startParam: "qr_Ab-12", session: { channel: "mini_app" } });

    const user = mem.users.get(body.session.userId)!;
    // Язык — из включённых локалей (пока только uk), имя — из Telegram.
    expect(user).toMatchObject({ status: "active", language: "uk", display_name: "Олена Тестова" });
    const [account] = [...mem.accounts.values()];
    expect(account).toMatchObject({
      user_id: user.id,
      telegram_user_id: String(TG_USER.id),
      username: TG_USER.username,
      allows_write_to_pm: true,
    });
    const session = mem.sessions.get(body.session.id)!;
    expect(session.token_hash.equals(hashSessionToken(body.token))).toBe(true);

    // Аудит: регистрация и выдача сессии, без ПДн Telegram в значениях.
    expect(mem.audit.map((a) => a.action)).toEqual(["user.register", "auth.session.create"]);
    expect(JSON.stringify(mem.audit)).not.toContain(TG_USER.username);

    // События: registration_completed и app_opened, псевдоним — не users.id.
    expect(mem.events.map((e) => e.event)).toEqual(["registration_completed", "app_opened"]);
    expect(mem.events[0]).toMatchObject({
      pseudonymousUserId: user.analytics_id,
      sessionId: session.id,
      source: "deep_link",
      props: { method: "telegram" },
    });
    expect(mem.events[1]).toMatchObject({ props: { platform: "android" } });
    expect(mem.events.every((e) => e.pseudonymousUserId !== user.id)).toBe(true);

    // Сессия работает.
    await http().get("/auth/session").set("Authorization", `Bearer ${body.token}`).expect(200);
  });

  it("повторный вход: тот же пользователь, поля Telegram обновлены, только app_opened", async () => {
    const first = (await login({ initData: initData() }).expect(201)).body as LoginBody;
    mem.events.length = 0;
    const renamed = JSON.stringify({ ...TG_USER, username: "olena_new" });
    const second = (await login({ initData: initData({ user: renamed }) }).expect(201)).body as LoginBody;
    expect(second).toMatchObject({ isNewUser: false, startParam: null });
    expect(second.session.userId).toBe(first.session.userId);
    expect(second.token).not.toBe(first.token);
    expect(mem.users.size).toBe(1);
    expect([...mem.accounts.values()][0]!.username).toBe("olena_new");
    expect(mem.events.map((e) => [e.event, e.source])).toEqual([["app_opened", "direct"]]);
  });

  it("подделанный initData: 401 UNAUTHENTICATED, RiskFlag invalid_init_data без ПДн, пользователь не создан", async () => {
    const res = await login({ initData: initData({}, "999:other-bot") }).expect(401);
    expect(code(res)).toBe("UNAUTHENTICATED");
    expect((res.body as ErrorEnvelope).error.messageKey).toBe("errors.auth.invalidInitData");
    expect(mem.users.size).toBe(0);
    expect(mem.sessions.size).toBe(0);
    expect(mem.riskFlags).toHaveLength(1);
    expect(mem.riskFlags[0]).toMatchObject({
      kind: "invalid_init_data",
      severity: "medium",
      user_id: null,
      region_id: null,
      request_id: "req-tg",
      details: { reason: "bad_signature", signatureValid: false },
    });
    expect(JSON.stringify(mem.riskFlags)).not.toContain(String(TG_USER.id));
  });

  it("просроченный initData известного пользователя: 401, RiskFlag expired_init_data с user_id", async () => {
    const ok = (await login({ initData: initData() }).expect(201)).body as LoginBody;
    const old = String(Math.floor(Date.now() / 1000) - 25 * 3600);
    expect(code(await login({ initData: initData({ auth_date: old }) }).expect(401))).toBe("UNAUTHENTICATED");
    expect(mem.riskFlags).toHaveLength(1);
    expect(mem.riskFlags[0]).toMatchObject({
      kind: "expired_init_data",
      severity: "low",
      user_id: ok.session.userId,
      details: { reason: "expired", signatureValid: true },
    });
  });

  it("без initData или с лишними полями — 400 VALIDATION_FAILED (без RiskFlag)", async () => {
    expect(code(await login({}).expect(400))).toBe("VALIDATION_FAILED");
    expect(code(await login({ initData: initData(), userId: "x" }).expect(400))).toBe("VALIDATION_FAILED");
    expect(code(await login({ initData: initData(), platform: "tv" }).expect(400))).toBe("VALIDATION_FAILED");
    expect(mem.riskFlags).toHaveLength(0);
  });

  it("заблокированный пользователь: личность подтверждена, но 403, сессия не выдана", async () => {
    const ok = (await login({ initData: initData() }).expect(201)).body as LoginBody;
    mem.users.get(ok.session.userId)!.status = "blocked";
    const sessionsBefore = mem.sessions.size;
    const res = await login({ initData: initData() }).expect(403);
    expect((res.body as ErrorEnvelope).error.messageKey).toBe("errors.auth.userBlocked");
    expect(mem.sessions.size).toBe(sessionsBefore);
  });

  it("в логах нет initData и ПДн Telegram — ни при входе, ни при отказе", async () => {
    const good = initData({ start_param: "qr_Ab-12" });
    await login({ initData: good }).expect(201);
    const forged = initData({}, "999:other-bot");
    await login({ initData: forged }).expect(401);
    const old = initData({ auth_date: String(Math.floor(Date.now() / 1000) - 30 * 3600) });
    await login({ initData: old }).expect(401);

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join("\n");
    expect(all).toContain("Вход Telegram отклонён: reason=bad_signature");
    for (const raw of [good, forged, old]) {
      const hash = new URLSearchParams(raw).get("hash")!;
      expect(all).not.toContain(hash);
      expect(all).not.toContain(raw);
    }
    for (const pii of [TG_USER.username, TG_USER.first_name, TG_USER.last_name, String(TG_USER.id)])
      expect(all).not.toContain(pii);
    expect(all).not.toContain("auth_date");
    expect(all).not.toContain("query_id");
    // Ничего похожего на initData не дошло даже до маскирования логгера.
    expect(all).not.toContain("[REDACTED]");
  });

  it("лимит запросов на маршрут: @RateLimit на POST /auth/telegram", () => {
    const rule = Reflect.getMetadata(RATE_LIMIT_RULE, TelegramAuthController.prototype.login) as unknown;
    expect(rule).toEqual(TELEGRAM_LOGIN_RATE_LIMIT);
  });
});

describe("вход через Telegram без токена бота", () => {
  it("503 SERVICE_UNAVAILABLE, RiskFlag не пишется", async () => {
    const mem = new MemoryIdentity();
    const app = await identityApp(mem);
    try {
      const res = await request(app.getHttpServer())
        .post("/auth/telegram")
        .send({ initData: initData() })
        .expect(503);
      expect((res.body as ErrorEnvelope).error.code).toBe("SERVICE_UNAVAILABLE");
      expect(mem.riskFlags).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe("displayNameOf", () => {
  it("имя и фамилия, иначе username; обрезка до 64 символов без хвостовых пробелов", () => {
    expect(displayNameOf({ firstName: "Ann", lastName: null, username: "ann" })).toBe("Ann");
    expect(displayNameOf({ firstName: null, lastName: null, username: "ann_u" })).toBe("ann_u");
    expect(displayNameOf({ firstName: null, lastName: null, username: null })).toBeNull();
    expect(displayNameOf({ firstName: `${"a".repeat(63)} b`, lastName: null, username: null })).toBe(
      "a".repeat(63),
    );
  });
});
