// T1-26: сессии на реальной PostgreSQL под ролью приложения (логин-роль в группе app): dev-вход, токен только хэшем,
// принципал по Bearer, /admin/audit-logs по праву из назначения, выход, истечение, блокировка, аудит выдачи и отзыва.
// README apps/api, «Сессии».
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { configureApp } from "../../src/bootstrap/configure-app.js";
import { TenancyModule } from "../../src/common/tenancy/index.js";
import { createDatabase, DatabaseModule, type Db } from "../../src/db/index.js";
import { AuditModule } from "../../src/modules/audit/index.js";
import { AuthModule, hashSessionToken, SessionsRepository } from "../../src/modules/auth/index.js";
import { RbacModule, RbacTenantContextSource } from "../../src/modules/rbac/index.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_auth_test";
const APP_PASSWORD = "tg_api_auth_test";
const CHECK_VIOLATION = "23514";

type Issued = { token: string; session: { id: string; userId: string; activeRegionId: string | null } };

describe.skipIf(!dockerAvailable)(`Сессии и аутентификация (T1-26)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let owner: pg.Client;
  let appDb: Db;
  let app: INestApplication;
  let regionA: string;
  let admin: string;
  let auditor: string;
  let tourist: string;

  const newUser = async () =>
    String((await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0]!.id);
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (userId: string, regionId?: string): Promise<Issued> =>
    (
      await http()
        .post("/auth/dev/sessions")
        .set("User-Agent", "t126-agent")
        .send(regionId ? { userId, regionId } : { userId })
        .expect(201)
    ).body as Issued;

  beforeAll(async () => {
    tdb = await startDatabase();
    owner = tdb.client; // superuser контейнера = роль миграций
    await owner.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    regionA = String(
      (
        await owner.query(
          `INSERT INTO regions (code, name_i18n) VALUES ('t126-a', '{"uk": "Регіон"}') RETURNING id`,
        )
      ).rows[0]!.id,
    );
    admin = await newUser();
    auditor = await newUser();
    tourist = await newUser();
    await owner.query(
      `INSERT INTO role_assignments (user_id, role, scope_type, scope_id, region_id)
       VALUES ($1, 'TECH_REGION_ADMIN', 'REGION', $2, $2), ($3, 'TECH_AUDITOR', 'PLATFORM', NULL, NULL)`,
      [admin, regionA, auditor],
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
        AuthModule.forRoot({ appEnv: "local", devLogin: true }),
        AuditModule,
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

  it("миграция 0006 применена", () => {
    expect(tdb!.applied).toContain("0006_sessions.sql");
  });

  it("dev-вход: в sessions — sha256 токена, самого токена в БД нет; аудит выдачи с ПДн-частью", async () => {
    const { token, session } = await login(admin);
    const { rows } = await owner.query("SELECT * FROM sessions WHERE id = $1", [session.id]);
    expect(rows).toHaveLength(1);
    expect((rows[0].token_hash as Buffer).equals(hashSessionToken(token))).toBe(true);
    expect(rows[0]).toMatchObject({
      user_id: admin,
      channel: "dev",
      revoked_at: null,
      active_region_id: null,
    });
    expect(JSON.stringify(rows[0])).not.toContain(token);

    const logs = await owner.query(
      `SELECT l.actor_type, l.actor_user_id, l.region_id, l.new_values, p.session_id, p.user_agent
       FROM audit_logs l LEFT JOIN audit_log_pii p ON p.audit_log_id = l.id
       WHERE l.entity_type = 'session' AND l.entity_id = $1 AND l.action = 'auth.session.create'`,
      [session.id],
    );
    expect(logs.rows).toEqual([
      {
        actor_type: "user",
        actor_user_id: admin,
        region_id: null,
        new_values: expect.objectContaining({ channel: "dev", activeRegionId: null }) as unknown,
        session_id: session.id,
        user_agent: "t126-agent",
      },
    ]);
    expect(JSON.stringify(logs.rows)).not.toContain(token);
  });

  it("без сессии защищённые эндпоинты — 401; с сессией — пользователь и роли", async () => {
    await http().get("/auth/session").expect(401);
    await http().get("/admin/audit-logs").expect(401);
    const { token } = await login(admin);
    const res = await http().get("/auth/session").set(bearer(token)).expect(200);
    expect(res.body).toMatchObject({
      userId: admin,
      grants: [{ role: "TECH_REGION_ADMIN", scopeType: "REGION", regionId: regionA }],
    });
  });

  it("/admin/audit-logs по праву: PLATFORM-аудитор видит выдачу сессий (region NULL), турист — 403", async () => {
    const { session } = await login(tourist);
    const { token } = await login(auditor);
    const res = await http()
      .get("/admin/audit-logs")
      .query({ entityType: "session", entityId: session.id })
      .set(bearer(token))
      .expect(200);
    expect((res.body as { items: { action: string; actorUserId: string }[] }).items).toEqual([
      expect.objectContaining({ action: "auth.session.create", actorUserId: tourist }),
    ]);
    const asTourist = await login(tourist);
    await http().get("/admin/audit-logs").set(bearer(asTourist.token)).expect(403);
  });

  it("регион-админ: выбор своего региона — да, лента аудита региона — 200", async () => {
    const { token } = await login(admin, regionA);
    await http().get("/admin/audit-logs").set(bearer(token)).expect(200);
    const other = String(
      (
        await owner.query(
          `INSERT INTO regions (code, name_i18n) VALUES ('t126-b', '{"uk": "Регіон"}') RETURNING id`,
        )
      ).rows[0]!.id,
    );
    await http().put("/auth/session/region").set(bearer(token)).send({ regionId: other }).expect(403);
    await http().post("/auth/dev/sessions").send({ userId: admin, regionId: other }).expect(403);
  });

  it("PLATFORM и несуществующий регион — 404, без нарушения FK (не 500); сессия и выбор не меняются", async () => {
    const missing = "0190f5c2-7d3e-7000-8000-0000000000ff";
    const before = await owner.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [auditor]);
    await http().post("/auth/dev/sessions").send({ userId: auditor, regionId: missing }).expect(404);
    const after = await owner.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [auditor]);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const { token, session } = await login(auditor, regionA);
    await http().put("/auth/session/region").set(bearer(token)).send({ regionId: missing }).expect(404);
    const { rows } = await owner.query("SELECT active_region_id FROM sessions WHERE id = $1", [session.id]);
    expect(rows[0].active_region_id).toBe(regionA);
  });

  it("выход: revoked_at, аудит отзыва; токен больше не действует", async () => {
    const { token, session } = await login(admin);
    await http().delete("/auth/session").set(bearer(token)).expect(204);
    const { rows } = await owner.query("SELECT revoked_at, revoke_reason FROM sessions WHERE id = $1", [
      session.id,
    ]);
    expect(rows[0].revoke_reason).toBe("logout");
    expect(rows[0].revoked_at).not.toBeNull();
    const logs = await owner.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = $1 AND action = 'auth.session.revoke'",
      [session.id],
    );
    expect(logs.rows[0].n).toBe(1);
    await http().get("/auth/session").set(bearer(token)).expect(401);
  });

  it("истёкшая сессия и заблокированный пользователь — 401", async () => {
    const expired = await login(tourist);
    await owner.query(
      "UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1",
      [expired.session.id],
    );
    await http().get("/auth/session").set(bearer(expired.token)).expect(401);

    const blockedUser = await newUser();
    const blocked = await login(blockedUser);
    await http().get("/auth/session").set(bearer(blocked.token)).expect(200);
    await owner.query("UPDATE users SET status = 'blocked' WHERE id = $1", [blockedUser]);
    await http().get("/auth/session").set(bearer(blocked.token)).expect(401);
    await http().post("/auth/dev/sessions").send({ userId: blockedUser }).expect(404);
  });

  it("очистка под ролью приложения удаляет истёкшие и отозванные, действующие остаются", async () => {
    // Истёкшую и отозванную сессии создаёт сам тест — не зависит от порядка и состояния других тестов.
    const alive = await login(tourist);
    const expired = await login(tourist);
    await owner.query(
      "UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1",
      [expired.session.id],
    );
    const revoked = await login(tourist);
    await http().delete("/auth/session").set(bearer(revoked.token)).expect(204);

    const removed = await new SessionsRepository(appDb).deleteInactive();
    expect(removed).toBeGreaterThanOrEqual(2);
    const { rows } = await owner.query("SELECT id FROM sessions WHERE id = ANY($1::uuid[])", [
      [alive.session.id, expired.session.id, revoked.session.id],
    ]);
    expect(rows.map((r: { id: string }) => r.id)).toEqual([alive.session.id]);
    const left = await owner.query(
      "SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NOT NULL OR expires_at <= now()",
    );
    expect(left.rows[0].n).toBe(0);
    await http().get("/auth/session").set(bearer(alive.token)).expect(200);
  });

  it("CHECK: хэш токена — ровно 32 байта", async () => {
    const err = await owner
      .query(
        "INSERT INTO sessions (user_id, token_hash, channel, expires_at) VALUES ($1, '\\x00'::bytea, 'dev', now() + interval '1 hour')",
        [tourist],
      )
      .then(
        () => undefined,
        (e: unknown) => e as { code?: string },
      );
    expect(err?.code).toBe(CHECK_VIOLATION);
  });
});
