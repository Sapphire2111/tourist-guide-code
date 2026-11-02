// Unit (Nest testing, без БД): сессия по Bearer-токену → принципал RBAC → защищённые эндпоинты; dev-вход, выход,
// выбор региона, аудит выдачи/отзыва, актор в логах. Хранилище сессий, пользователи, назначения и аудит — в памяти;
// SQL сессий и RLS — test/integration/auth.test.ts.
import { randomUUID } from "node:crypto";
import { Controller, Get, Logger, Req, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorEnvelope } from "@tg/shared";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import {
  DATABASE,
  DatabaseModule,
  type NewSession,
  type Session,
  type SessionRevokeReason,
  type User,
} from "../../db/index.js";
import { auditFromRequest, AuditModule, AuditService, type AuditEntry } from "../audit/index.js";
import {
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
  type Grant,
  type RbacRequest,
} from "../rbac/index.js";
import { HealthModule } from "../health/index.js";
import { RegionsRepository } from "../regions/index.js";
import { UsersRepository } from "../users/index.js";
import { AuthModule } from "./auth.module.js";
import { RequireAuth } from "./require-auth.guard.js";
import { hashSessionToken } from "./session-token.js";
import { SessionsRepository, type ActiveSession } from "./sessions.repository.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const ADMIN = "0190f5c2-7d3e-7000-8000-0000000000a0";
const TOURIST = "0190f5c2-7d3e-7000-8000-0000000000c0";
const BLOCKED = "0190f5c2-7d3e-7000-8000-0000000000d0";
const MISSING = "0190f5c2-7d3e-7000-8000-0000000000ff";

const AUDITOR_A: Grant = {
  id: "0190f5c2-7d3e-7000-8000-000000000201",
  role: "TECH_AUDITOR",
  scopeType: "REGION",
  scopeId: A,
  regionId: A,
  validUntil: null,
};
const SUPERUSER: Grant = {
  id: "0190f5c2-7d3e-7000-8000-000000000202",
  role: "TECH_SUPERUSER",
  scopeType: "PLATFORM",
  scopeId: null,
  regionId: null,
  validUntil: null,
};

/** Хранилище сессий в памяти с той же семантикой, что SQL репозитория (срок, отзыв, статус пользователя). */
class MemorySessions {
  readonly rows = new Map<string, Session>();
  constructor(private readonly users: Map<string, User>) {}

  create(s: NewSession): Promise<Session> {
    const now = new Date();
    const row: Session = {
      id: randomUUID(),
      user_id: s.user_id,
      token_hash: s.token_hash,
      channel: s.channel,
      active_region_id: s.active_region_id ?? null,
      expires_at: new Date(s.expires_at),
      revoked_at: null,
      revoke_reason: null,
      created_at: now,
      updated_at: now,
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  findById(id: string): Promise<Session | undefined> {
    return Promise.resolve(this.rows.get(id));
  }

  findActiveByTokenHash(hash: Buffer): Promise<ActiveSession | undefined> {
    const s = [...this.rows.values()].find((r) => r.token_hash.equals(hash));
    const ok =
      s &&
      !s.revoked_at &&
      s.expires_at.getTime() > Date.now() &&
      this.users.get(s.user_id)?.status === "active";
    return Promise.resolve(
      ok
        ? { id: s.id, userId: s.user_id, channel: s.channel, activeRegionId: s.active_region_id }
        : undefined,
    );
  }

  revoke(id: string, reason: SessionRevokeReason): Promise<Session | undefined> {
    const s = this.rows.get(id);
    if (!s || s.revoked_at) return Promise.resolve(undefined);
    Object.assign(s, { revoked_at: new Date(), revoke_reason: reason });
    return Promise.resolve(s);
  }

  setActiveRegion(id: string, regionId: string | null): Promise<Session | undefined> {
    const s = this.rows.get(id);
    if (!s || s.revoked_at) return Promise.resolve(undefined);
    s.active_region_id = regionId;
    return Promise.resolve(s);
  }
}

function user(id: string, status: User["status"] = "active"): User {
  return {
    id,
    status,
    language: "uk",
    display_name: null,
    analytics_id: randomUUID(),
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/** Эндпоинт, требующий только сессию; отдаёт то, что получил бы аудит. */
@Controller("t126")
class ProbeController {
  @Get("me")
  @RequireAuth()
  me(@Req() req: RbacRequest & { headers: Record<string, string | undefined>; correlationId?: string }) {
    return auditFromRequest(req);
  }

  @Get("boom")
  @RequireAuth()
  boom(): never {
    throw new Error("сбой");
  }
}

describe("сессии и аутентификация (T1-26)", () => {
  const { db, queries } = recordingDb();
  const users = new Map<string, User>([
    [ADMIN, user(ADMIN)],
    [TOURIST, user(TOURIST)],
    [BLOCKED, user(BLOCKED)],
  ]);
  const sessions = new MemorySessions(users);
  const regions = new Set([A, B]);
  const grants = new Map<string, Grant[]>();
  const audit: AuditEntry[] = [];
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
        RbacModule,
        AuthModule.forRoot({ appEnv: "local", devLogin: true }),
        AuditModule,
        HealthModule,
      ],
      controllers: [ProbeController],
    })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(SessionsRepository)
      .useValue(sessions)
      .overrideProvider(UsersRepository)
      .useValue({ findById: (id: string) => Promise.resolve(users.get(id)) })
      .overrideProvider(RegionsRepository)
      .useValue({ findById: (id: string) => Promise.resolve(regions.has(id) ? { id } : undefined) })
      .overrideProvider(RoleAssignmentsRepository)
      .useValue({ activeGrantsOf: (id: string) => Promise.resolve(grants.get(id) ?? []) })
      .overrideProvider(AuditService)
      .useValue({
        record: (_trx: unknown, entry: AuditEntry) => {
          audit.push(entry);
          return Promise.resolve({});
        },
      })
      .compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    sessions.rows.clear();
    grants.clear();
    grants.set(ADMIN, [AUDITOR_A]);
    users.set(BLOCKED, user(BLOCKED));
    audit.length = 0;
  });

  const http = () => request(app.getHttpServer());
  const code = (res: { body: unknown }) => (res.body as ErrorEnvelope).error.code;
  const login = async (userId: string, regionId?: string) => {
    const res = await http()
      .post("/auth/dev/sessions")
      .send(regionId ? { userId, regionId } : { userId })
      .expect(201);
    return res.body as {
      token: string;
      session: { id: string; userId: string; activeRegionId: string | null };
    };
  };
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it("защищённые эндпоинты без сессии и с чужим/неизвестным токеном — 401", async () => {
    for (const headers of [{}, { Authorization: "Bearer nope" }, bearer(`tgs_${"x".repeat(43)}`)]) {
      expect(code(await http().get("/auth/session").set(headers).expect(401))).toBe("UNAUTHENTICATED");
      expect(code(await http().get("/t126/me").set(headers).expect(401))).toBe("UNAUTHENTICATED");
      expect(code(await http().get("/admin/audit-logs").set(headers).expect(401))).toBe("UNAUTHENTICATED");
    }
  });

  it("dev-вход: токен один раз, в БД — только хэш; GET /auth/session — пользователь и роли", async () => {
    const { token, session } = await login(ADMIN);
    expect(token).toMatch(/^tgs_/);
    const stored = sessions.rows.get(session.id)!;
    expect(stored.token_hash.equals(hashSessionToken(token))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(token);

    const res = await http().get("/auth/session").set(bearer(token)).expect(200);
    expect(res.body).toMatchObject({
      id: session.id,
      userId: ADMIN,
      channel: "dev",
      activeRegionId: null,
      grants: [{ id: AUDITOR_A.id, role: "TECH_AUDITOR", scopeType: "REGION", regionId: A }],
    });
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it("выдача сессии — в аудите: актор-пользователь, id сессии и IP в ПДн-части, без токена", async () => {
    const { token, session } = await login(ADMIN);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: { type: "user", userId: ADMIN },
      action: "auth.session.create",
      entityType: "session",
      entityId: session.id,
      newValues: { channel: "dev", activeRegionId: null },
      pii: { sessionId: session.id },
    });
    expect(audit[0]!.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("актор доступен обработчику для аудита: пользователь, сессия, correlation id", async () => {
    const { token, session } = await login(TOURIST);
    const res = await http().get("/t126/me").set(bearer(token)).set("X-Request-Id", "req-126").expect(200);
    expect(res.body).toMatchObject({
      actor: { type: "user", userId: TOURIST },
      roleAssignmentId: null,
      requestId: "req-126",
      pii: { sessionId: session.id },
    });
  });

  it("актор — в логе ошибки (id пользователя и сессии), токена в логе нет", async () => {
    const { token, session } = await login(TOURIST);
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      await http().get("/t126/boom").set(bearer(token)).expect(500);
      const line = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toContain(`actor=user:${TOURIST} session=${session.id}`);
      expect(line).not.toContain(token);
    } finally {
      spy.mockRestore();
    }
  });

  it("/admin/audit-logs: сессия админа с audit.read — 200; турист без назначений — 403", async () => {
    const admin = await login(ADMIN);
    expect((await http().get("/admin/audit-logs").set(bearer(admin.token)).expect(200)).body).toEqual({
      items: [],
      nextCursor: null,
    });
    const tourist = await login(TOURIST);
    expect(code(await http().get("/admin/audit-logs").set(bearer(tourist.token)).expect(403))).toBe(
      "FORBIDDEN",
    );
  });

  it("выход: сессия отозвана (аудит), токен больше не действует; повторный выход — 401", async () => {
    const { token, session } = await login(ADMIN);
    audit.length = 0;
    await http().delete("/auth/session").set(bearer(token)).expect(204);
    expect(sessions.rows.get(session.id)).toMatchObject({ revoke_reason: "logout" });
    expect(audit).toEqual([
      expect.objectContaining({
        actor: { type: "user", userId: ADMIN },
        action: "auth.session.revoke",
        entityId: session.id,
        pii: expect.objectContaining({ sessionId: session.id }) as unknown,
      }),
    ]);
    expect(code(await http().get("/auth/session").set(bearer(token)).expect(401))).toBe("UNAUTHENTICATED");
    await http().delete("/auth/session").set(bearer(token)).expect(401);
  });

  it("истёкшая сессия и заблокированный пользователь — 401", async () => {
    const expired = await login(ADMIN);
    sessions.rows.get(expired.session.id)!.expires_at = new Date(Date.now() - 1000);
    await http().get("/auth/session").set(bearer(expired.token)).expect(401);

    const blocked = await login(BLOCKED);
    await http().get("/auth/session").set(bearer(blocked.token)).expect(200);
    users.set(BLOCKED, user(BLOCKED, "blocked"));
    await http().get("/auth/session").set(bearer(blocked.token)).expect(401);
  });

  it("dev-вход: нет пользователя или он заблокирован — 404; регион без назначения — 403; не uuid — 400", async () => {
    expect(code(await http().post("/auth/dev/sessions").send({ userId: MISSING }).expect(404))).toBe(
      "NOT_FOUND",
    );
    users.set(BLOCKED, user(BLOCKED, "blocked"));
    await http().post("/auth/dev/sessions").send({ userId: BLOCKED }).expect(404);
    expect(
      code(await http().post("/auth/dev/sessions").send({ userId: ADMIN, regionId: B }).expect(403)),
    ).toBe("FORBIDDEN");
    await http().post("/auth/dev/sessions").send({ userId: "admin" }).expect(400);
    expect(sessions.rows.size).toBe(0);
    expect(audit).toEqual([]);
  });

  it("выбор региона: регион с назначением — да; без назначения — 403 и прежний выбор сохраняется", async () => {
    grants.set(ADMIN, [
      AUDITOR_A,
      { ...AUDITOR_A, id: "0190f5c2-7d3e-7000-8000-000000000203", scopeId: B, regionId: B },
    ]);
    const { token, session } = await login(ADMIN);
    const put = (regionId: string | null, status: number) =>
      http().put("/auth/session/region").set(bearer(token)).send({ regionId }).expect(status);
    expect((await put(B, 200)).body).toMatchObject({ activeRegionId: B });
    await put(MISSING, 403);
    expect(sessions.rows.get(session.id)?.active_region_id).toBe(B);
    expect((await put(null, 200)).body).toMatchObject({ activeRegionId: null });
    await http().put("/auth/session/region").set(bearer(token)).send({}).expect(400);
  });

  it("выбранный регион больше не разрешён: прочие запросы — 403, но сессия, смена региона и выход работают", async () => {
    const { token } = await login(ADMIN, A);
    await http().get("/admin/audit-logs").set(bearer(token)).expect(200);
    // /health — без tenant-контекста: транзакции запроса (set_config RLS) нет даже с разрешённым регионом.
    const mark = queries.length;
    await http().get("/health").set(bearer(token)).expect(200);
    expect(queries.slice(mark)).toEqual([]);
    grants.set(ADMIN, []); // назначение отозвано
    await http().get("/admin/audit-logs").set(bearer(token)).expect(403);
    // С такой сессией /health — 200, не 403.
    expect((await http().get("/health").set(bearer(token)).expect(200)).body).toEqual({ status: "ok" });
    await http().get("/auth/session").set(bearer(token)).expect(200);
    await http().put("/auth/session/region").set(bearer(token)).send({ regionId: null }).expect(200);
    await http().delete("/auth/session").set(bearer(token)).expect(204);
  });

  it("PLATFORM-админ выбирает любой регион", async () => {
    grants.set(ADMIN, [SUPERUSER]);
    const { session } = await login(ADMIN, B);
    expect(session.activeRegionId).toBe(B);
  });

  it("PLATFORM-админ и несуществующий регион — 404 (не 500 от FK), выбор и сессии не меняются", async () => {
    grants.set(ADMIN, [SUPERUSER]);
    expect(
      code(await http().post("/auth/dev/sessions").send({ userId: ADMIN, regionId: MISSING }).expect(404)),
    ).toBe("NOT_FOUND");
    expect(sessions.rows.size).toBe(0);
    const { token, session } = await login(ADMIN, A);
    const res = await http()
      .put("/auth/session/region")
      .set(bearer(token))
      .send({ regionId: MISSING })
      .expect(404);
    expect(code(res)).toBe("NOT_FOUND");
    expect(sessions.rows.get(session.id)?.active_region_id).toBe(A);
  });
});

describe("AuthModule.forRoot", () => {
  it("dev-вход вне local — ошибка конфигурации", () => {
    expect(() => AuthModule.forRoot({ appEnv: "staging", devLogin: true })).toThrow(/APP_ENV=local/);
    expect(() => AuthModule.forRoot({ appEnv: "prod", devLogin: true })).toThrow(/APP_ENV=local/);
    // Без dev-входа: сессия и вход через Telegram.
    expect(AuthModule.forRoot({ appEnv: "prod" }).controllers).toHaveLength(2);
  });
});

describe("без dev-входа", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        RbacModule,
        AuthModule.forRoot({ appEnv: "local" }),
      ],
    })
      .overrideProvider(DATABASE)
      .useValue(recordingDb().db)
      .compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /auth/dev/sessions — 404 (маршрута нет)", async () => {
    await request(app.getHttpServer()).post("/auth/dev/sessions").send({ userId: ADMIN }).expect(404);
  });
});
