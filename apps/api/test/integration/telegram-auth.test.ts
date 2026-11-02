// Блок 2 (2A): вход через Telegram и профиль на реальной PostgreSQL под ролью приложения (логин-роль в группе app):
// миграция 0010, POST /auth/telegram (users + telegram_accounts, гонка первого входа, RiskFlag), события в
// analytics_events, /me (согласия, разрешение боту, запросы данных), триггер и права consents, RLS risk_flags.
// README apps/api, «Вход через Telegram».
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type pg from "pg";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { configureApp } from "../../src/bootstrap/configure-app.js";
import { TenancyModule } from "../../src/common/tenancy/index.js";
import {
  createDatabase,
  DatabaseModule,
  regionContext,
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
} from "../../src/db/index.js";
import { AnalyticsModule } from "../../src/modules/analytics/index.js";
import { AuditModule } from "../../src/modules/audit/index.js";
import { AuthModule, signInitDataFields } from "../../src/modules/auth/index.js";
import { ProfileModule } from "../../src/modules/profile/index.js";
import { RbacModule, RbacTenantContextSource } from "../../src/modules/rbac/index.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера; токен бота — тестовый.
const APP_LOGIN = "tg_api_tgauth_test";
const APP_PASSWORD = "tg_api_tgauth_test";
const BOT_TOKEN = "123456789:TEST-fake-token-for-integration";
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

function initData(tgId: number, fields: Record<string, string> = {}, token = BOT_TOKEN): string {
  const entries = Object.entries({
    user: JSON.stringify({ id: tgId, first_name: "Інна", username: `u${tgId}`, language_code: "uk" }),
    auth_date: String(Math.floor(Date.now() / 1000)),
    ...fields,
  });
  return new URLSearchParams([...entries, ["hash", signInitDataFields(entries, token)]]).toString();
}

type Login = { token: string; session: { id: string; userId: string; channel: string }; isNewUser: boolean };

describe.skipIf(!dockerAvailable)(`Вход через Telegram и профиль (блок 2)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let owner: pg.Client;
  let appDb: Db;
  let app: INestApplication;
  let regionA: string;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (tgId: number, fields?: Record<string, string>): Promise<Login> =>
    (
      await http()
        .post("/auth/telegram")
        .set("User-Agent", "tg-agent")
        .send({ initData: initData(tgId, fields), platform: "ios" })
        .expect(201)
    ).body as Login;
  const pgError = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  };

  beforeAll(async () => {
    tdb = await startDatabase();
    owner = tdb.client;
    await owner.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    regionA = String(
      (
        await owner.query(
          `INSERT INTO regions (code, name_i18n) VALUES ('tg-a', '{"uk": "Регіон"}') RETURNING id`,
        )
      ).rows[0]!.id,
    );
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: url.toString() }),
        TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
        RbacModule,
        AuthModule.forRoot({ appEnv: "local", telegramBotToken: BOT_TOKEN }),
        AuditModule,
        AnalyticsModule.forRoot({ mode: "direct" }),
        ProfileModule,
      ],
    }).compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await appDb?.destroy();
    await stopDatabase(tdb);
  });

  it("миграция 0010 применена", () => {
    expect(tdb!.applied).toContain("0010_telegram_auth.sql");
  });

  it("первый вход: users + telegram_accounts, сессия mini_app, аудит регистрации, события с псевдонимом", async () => {
    const res = await login(5001, { start_param: "qr_x1" });
    expect(res).toMatchObject({ isNewUser: true, session: { channel: "mini_app" } });
    const user = (await owner.query("SELECT * FROM users WHERE id = $1", [res.session.userId])).rows[0];
    expect(user).toMatchObject({ status: "active", language: "uk", display_name: "Інна" });
    const accounts = await owner.query("SELECT * FROM telegram_accounts WHERE user_id = $1", [user.id]);
    expect(accounts.rows).toEqual([expect.objectContaining({ telegram_user_id: "5001", username: "u5001" })]);

    const audit = await owner.query(
      "SELECT action, actor_user_id, region_id FROM audit_logs WHERE actor_user_id = $1 ORDER BY created_at",
      [user.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["user.register", "auth.session.create"]);
    expect(audit.rows.every((r) => r.region_id === null)).toBe(true);

    const events = await owner.query(
      "SELECT event_name, pseudonymous_user_id, session_id, source FROM analytics_events ORDER BY event_name",
    );
    expect(events.rows).toEqual([
      {
        event_name: "app_opened",
        pseudonymous_user_id: user.analytics_id,
        session_id: res.session.id,
        source: "deep_link",
      },
      {
        event_name: "registration_completed",
        pseudonymous_user_id: user.analytics_id,
        session_id: res.session.id,
        source: "deep_link",
      },
    ]);
    expect(user.analytics_id).not.toBe(user.id);
  });

  it("параллельный первый вход того же пользователя — один users и один telegram_accounts", async () => {
    const results = await Promise.all([login(5002), login(5002), login(5002)]);
    expect(new Set(results.map((r) => r.session.userId)).size).toBe(1);
    const { rows } = await owner.query(
      "SELECT count(*)::int AS n FROM telegram_accounts WHERE telegram_user_id = 5002",
    );
    expect(rows[0].n).toBe(1);
    const users = await owner.query(
      "SELECT count(*)::int AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM telegram_accounts t WHERE t.user_id = u.id)",
    );
    expect(users.rows[0].n).toBe(0);
  });

  it("подделанный initData: 401, risk_flags без региона; RLS: регион не видит, SYSTEM видит", async () => {
    await http()
      .post("/auth/telegram")
      .send({ initData: initData(5003, {}, "999:other") })
      .expect(401);
    const { rows } = await owner.query("SELECT * FROM risk_flags WHERE kind = 'invalid_init_data'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ region_id: null, user_id: null, details: { reason: "bad_signature" } });
    expect(JSON.stringify(rows[0])).not.toContain("5003");
    expect(
      (await owner.query("SELECT count(*)::int AS n FROM telegram_accounts WHERE telegram_user_id = 5003"))
        .rows[0].n,
    ).toBe(0);

    const inRegion = await withTenant(appDb, regionContext(regionA), (trx) =>
      trx.selectFrom("risk_flags").select("id").execute(),
    );
    expect(inRegion).toHaveLength(0);
    const asSystem = await withTenant(appDb, SYSTEM_CONTEXT, (trx) =>
      trx.selectFrom("risk_flags").select("id").execute(),
    );
    expect(asSystem.length).toBeGreaterThanOrEqual(1);
  });

  it("/me: согласия, разрешение боту, запрос удаления — в таблицах и аудите", async () => {
    const { token, session } = await login(5004);
    await http()
      .post("/me/consents")
      .set(bearer(token))
      .send({ kind: "terms", version: "2026-11-01", action: "accept" })
      .expect(200);
    await http()
      .post("/me/messaging-consent")
      .set(bearer(token))
      .send({ purpose: "service", granted: true, source: "request_write_access" })
      .expect(200);
    const [a, b] = await Promise.all([
      http().post("/me/privacy-requests").set(bearer(token)).send({ kind: "delete" }).expect(201),
      http().post("/me/privacy-requests").set(bearer(token)).send({ kind: "delete" }).expect(201),
    ]);
    expect((a.body as { id: string }).id).toBe((b.body as { id: string }).id);
    await http().patch("/me").set(bearer(token)).send({ language: "en", displayName: "Інна К." }).expect(200);

    const me = (await http().get("/me").set(bearer(token)).expect(200)).body as Record<string, unknown>;
    expect(me).toMatchObject({
      language: "en",
      displayName: "Інна К.",
      consents: [{ kind: "terms", version: "2026-11-01", status: "accepted" }],
      messagingConsents: [{ purpose: "service", granted: true }],
      privacyRequests: [{ kind: "delete", status: "received" }],
    });
    const audit = await owner.query(
      "SELECT action FROM audit_logs WHERE actor_user_id = $1 AND action NOT LIKE 'auth.%' AND action <> 'user.register' ORDER BY created_at",
      [session.userId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "consent.manage.own",
      "messaging_consent.manage.own",
      "privacy.request.create.own",
      "profile.edit.own",
    ]);
  });

  it("гонка «разрешить marketing» ∥ «отозвать service»: marketing без service не остаётся", async () => {
    const { token, session } = await login(5007);
    const send = (body: object) => http().post("/me/messaging-consent").set(bearer(token)).send(body);
    for (let i = 0; i < 10; i++) {
      await send({ purpose: "service", granted: true, source: "settings" }).expect(200);
      await send({ purpose: "marketing", granted: false, source: "settings" }).expect(200);
      const [grant, revoke] = await Promise.all([
        send({ purpose: "marketing", granted: true, source: "settings" }),
        send({ purpose: "service", granted: false, source: "settings" }),
      ]);
      // Разрешение marketing либо успело до отзыва (тогда отзыв снял и его), либо получило 422.
      expect([200, 422]).toContain(grant.status);
      expect(revoke.status).toBe(200);
      const { rows } = await owner.query(
        "SELECT purpose, granted FROM messaging_consents WHERE user_id = $1",
        [session.userId],
      );
      const state = Object.fromEntries(rows.map((r) => [r.purpose, r.granted]));
      expect(state).toEqual({ service: false, marketing: false });
    }
  });

  it("consents: меняется только withdrawn_at и один раз; DELETE у app нет; одна действующая на версию", async () => {
    const { token, session } = await login(5005);
    await http()
      .post("/me/consents")
      .set(bearer(token))
      .send({ kind: "privacy", version: "v1", action: "accept" })
      .expect(200);
    const id = String(
      (await owner.query("SELECT id FROM consents WHERE user_id = $1", [session.userId])).rows[0]!.id,
    );
    const asApp = (fn: (trx: Db) => Promise<unknown>) => withTenant(appDb, SYSTEM_CONTEXT, fn);

    expect(
      await pgError(
        asApp((trx) =>
          trx
            .updateTable("consents")
            .set({ withdrawn_at: sql<Date>`now()` })
            .where("id", "=", id)
            .execute(),
        ),
      ),
    ).toBeUndefined();
    expect(
      await pgError(
        asApp((trx) =>
          trx
            .updateTable("consents")
            .set({ withdrawn_at: sql<Date>`now()` })
            .where("id", "=", id)
            .execute(),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(await pgError(owner.query("UPDATE consents SET kind = 'terms' WHERE id = $1", [id]))).toBe(
      CHECK_VIOLATION,
    );
    expect(await pgError(asApp((trx) => trx.deleteFrom("consents").where("id", "=", id).execute()))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    // Повторное принятие после отзыва — новая строка; повтор принятия — без дубля (частичный уникальный индекс).
    for (let i = 0; i < 2; i++)
      await http()
        .post("/me/consents")
        .set(bearer(token))
        .send({ kind: "privacy", version: "v1", action: "accept" })
        .expect(200);
    const rows = await owner.query(
      "SELECT withdrawn_at FROM consents WHERE user_id = $1 ORDER BY granted_at",
      [session.userId],
    );
    expect(rows.rows.map((r) => r.withdrawn_at === null)).toEqual([false, true]);
  });

  it("CHECK: имя отображения обрезано и до 64 символов; telegram_user_id > 0", async () => {
    // Граница DTO совпадает с CHECK: 64 кодовые точки проходят, 65 (в т. ч. из-за вариационных селекторов) — 400, не 500.
    const { token } = await login(5006);
    await http()
      .patch("/me")
      .set(bearer(token))
      .send({ displayName: "❤️".repeat(32) })
      .expect(200);
    await http()
      .patch("/me")
      .set(bearer(token))
      .send({ displayName: "😀".repeat(64) })
      .expect(200);
    await http()
      .patch("/me")
      .set(bearer(token))
      .send({ displayName: "❤️".repeat(64) })
      .expect(400);
    expect(await pgError(owner.query("INSERT INTO users (display_name) VALUES (' x')"))).toBe(
      CHECK_VIOLATION,
    );
    expect(await pgError(owner.query(`INSERT INTO users (display_name) VALUES ('${"x".repeat(65)}')`))).toBe(
      CHECK_VIOLATION,
    );
    const u = String((await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0]!.id);
    expect(
      await pgError(
        owner.query(
          "INSERT INTO telegram_accounts (user_id, telegram_user_id, last_auth_date) VALUES ($1, 0, now())",
          [u],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});
