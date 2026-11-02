// Unit (без БД): вход админа POST /auth/admin/login и выход — одинаковый 401 на «нет логина»/«неверный пароль»/
// «заблокировано»/«пользователь не активен», блокировка пары «логин + адрес» после 5 неудач (другой адрес не
// заперт), глобальная блокировка по логину на высоком пороге, сессия admin_web, аудит попыток без пароля и логина,
// 2FA-каркас (fail closed). Хранилища — в памяти с семантикой SQL-репозитория; атомарность счётчиков при
// параллельных попытках — test/integration/admin-core.test.ts.
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { ErrorEnvelope } from "@tg/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryIdentity } from "../../../test/support/memory-identity.js";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule, type AdminCredential, type NewAdminCredential } from "../../db/index.js";
import { AuditModule, AuditService } from "../audit/index.js";
import { AuthModule, SessionsRepository } from "../auth/index.js";
import { RATE_LIMIT_RULE } from "../rate-limit/index.js";
import { RbacModule, RbacTenantContextSource, RoleAssignmentsRepository, type Grant } from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import { UsersRepository } from "../users/index.js";
import { ADMIN_LOGIN_RATE_LIMIT, AdminAuthController } from "./admin-auth.controller.js";
import { AdminAuthModule } from "./admin-auth.module.js";
import {
  AdminCredentialsRepository,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILED_ATTEMPTS,
  PAIR_LOCK_MINUTES,
  PAIR_MAX_FAILED_ATTEMPTS,
  type FailureResult,
} from "./admin-credentials.repository.js";
import { hashPassword } from "./password-hash.js";

const PASSWORD = "correct horse battery";
const MIN = 60_000;

type Pair = { failed_attempts: number; locked_until: Date | null; last_failed_at: Date };

/** Учётки и счётчики в памяти — те же правила, что у SQL в AdminCredentialsRepository. */
class MemoryCredentials {
  readonly rows = new Map<string, AdminCredential>();
  readonly pairs = new Map<string, Pair>();
  /** Чтение отдаёт «до блокировки» (гонка: блокировка сработала между чтением и проверкой пароля). */
  staleLookup = false;
  purges = 0;
  constructor(private readonly mem: MemoryIdentity) {}

  create(row: NewAdminCredential): AdminCredential {
    const full: AdminCredential = {
      id: randomUUID(),
      user_id: row.user_id,
      login: row.login,
      password_hash: row.password_hash,
      failed_attempts: 0,
      failure_window_started_at: null,
      locked_until: null,
      last_login_at: null,
      mfa_method: row.mfa_method ?? null,
      password_changed_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.rows.set(full.id, full);
    return full;
  }

  private byLogin(login: string) {
    return [...this.rows.values()].find((r) => r.login === login);
  }

  readonly repo = {
    lookup: (login: string, lh: Buffer, ch: Buffer) => {
      const c = this.byLogin(login);
      const pair = this.staleLookup ? undefined : this.pairs.get(lh.toString("hex") + ch.toString("hex"));
      return Promise.resolve({
        credential: c && {
          ...c,
          locked_until: this.staleLookup ? null : c.locked_until,
          user_status: this.mem.users.get(c.user_id)!.status,
        },
        pair: pair && { ...pair, login_hash: lh, client_hash: ch },
      });
    },
    recordFailure: (login: string, lh: Buffer, ch: Buffer): Promise<FailureResult> => {
      const now = Date.now();
      const key = lh.toString("hex") + ch.toString("hex");
      const p = this.pairs.get(key);
      let pairAttempts: number | null = null;
      if (!p) {
        this.pairs.set(key, { failed_attempts: 1, locked_until: null, last_failed_at: new Date() });
        pairAttempts = 1;
      } else if (!p.locked_until || p.locked_until.getTime() <= now) {
        const base = p.locked_until || p.last_failed_at.getTime() < now - 15 * MIN ? 0 : p.failed_attempts;
        pairAttempts = base + 1;
        p.failed_attempts = pairAttempts;
        p.locked_until =
          pairAttempts >= PAIR_MAX_FAILED_ATTEMPTS ? new Date(now + PAIR_LOCK_MINUTES * MIN) : null;
        p.last_failed_at = new Date();
      }
      let loginLocked = false;
      const c = this.byLogin(login);
      if (c && (!c.locked_until || c.locked_until.getTime() <= now)) {
        const reset =
          !c.failure_window_started_at ||
          c.failure_window_started_at.getTime() < now - 60 * MIN ||
          c.locked_until;
        c.failed_attempts = reset ? 1 : c.failed_attempts + 1;
        if (reset) c.failure_window_started_at = new Date();
        loginLocked = c.failed_attempts >= LOGIN_MAX_FAILED_ATTEMPTS;
        c.locked_until = loginLocked ? new Date(now + LOGIN_LOCK_MINUTES * MIN) : null;
      }
      return Promise.resolve({
        pairAttempts,
        pairLocked: pairAttempts !== null && pairAttempts >= PAIR_MAX_FAILED_ATTEMPTS,
        loginLocked,
      });
    },
    recordSuccess: (id: string, lh: Buffer, ch: Buffer) => {
      const now = Date.now();
      const key = lh.toString("hex") + ch.toString("hex");
      const c = this.rows.get(id)!;
      const pairLock = this.pairs.get(key)?.locked_until;
      if ((pairLock && pairLock.getTime() > now) || (c.locked_until && c.locked_until.getTime() > now))
        return Promise.resolve(false);
      Object.assign(c, {
        failed_attempts: 0,
        failure_window_started_at: null,
        locked_until: null,
        last_login_at: new Date(),
      });
      this.pairs.delete(key);
      return Promise.resolve(true);
    },
    purgeStaleFailures: () => {
      this.purges++;
      return Promise.resolve(0);
    },
  };
}

describe("вход админа /auth/admin", () => {
  const mem = new MemoryIdentity();
  const creds = new MemoryCredentials(mem);
  let app: INestApplication;
  let hash: string;
  let grants: Grant[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    hash = await hashPassword(PASSWORD);
    const { db } = recordingDb();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
        RbacModule,
        AuthModule.forRoot({ appEnv: "local" }),
        AuditModule,
        AdminAuthModule.forRoot(),
      ],
    })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(SessionsRepository)
      .useValue(mem.sessionsRepo)
      .overrideProvider(UsersRepository)
      .useValue(mem.usersRepo)
      .overrideProvider(RegionsRepository)
      .useValue({ findById: () => Promise.resolve(undefined) })
      .overrideProvider(RoleAssignmentsRepository)
      .useValue({ activeGrantsOf: () => Promise.resolve(grants) })
      .overrideProvider(AuditService)
      .useValue(mem.auditService)
      .overrideProvider(AdminCredentialsRepository)
      .useValue(creds.repo)
      .compile();
    // Один доверенный прокси: адрес клиента — из X-Forwarded-For (разные «адреса» в тесте).
    app = configureApp(moduleRef.createNestApplication({ logger: false }), {
      appEnv: "local",
      trustProxyHops: 1,
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  let userId: string;
  let cred: AdminCredential;
  beforeEach(async () => {
    mem.reset();
    creds.rows.clear();
    creds.pairs.clear();
    creds.staleLookup = false;
    creds.purges = 0;
    userId = (await mem.usersRepo.create()).id;
    cred = creds.create({ user_id: userId, login: "admin@example.com", password_hash: hash });
    grants = [
      {
        id: randomUUID(),
        role: "SUPERADMIN",
        scopeType: "PLATFORM",
        scopeId: null,
        regionId: null,
        validUntil: null,
      },
    ];
  });

  const login = (login: string, password: string, ip = "203.0.113.10") =>
    http()
      .post("/auth/admin/login")
      .set("User-Agent", "admin-agent")
      .set("X-Forwarded-For", ip)
      .send({ login, password });
  const reasons = () =>
    mem.audit.filter((a) => a.action === "auth.admin.login_failed").map((a) => a.newValues?.reason);

  it("верный пароль: сессия admin_web с ролями, счётчики сброшены, аудит входа без пароля и логина", async () => {
    cred.failed_attempts = 3;
    const res = await login("  Admin@Example.COM ", PASSWORD).expect(201);
    const body = res.body as {
      token: string;
      session: { channel: string; userId: string; grants: unknown[] };
    };
    expect(body.session).toMatchObject({ channel: "admin_web", userId });
    expect(body.session.grants).toHaveLength(1);
    expect(cred).toMatchObject({ failed_attempts: 0, locked_until: null });
    expect(cred.last_login_at).toBeInstanceOf(Date);
    expect(mem.audit.map((a) => a.action)).toEqual(["auth.admin.login", "auth.session.create"]);
    expect(mem.audit[0]).toMatchObject({
      actor: { type: "user", userId },
      entityType: "admin_credential",
      entityId: cred.id,
      pii: { userAgent: "admin-agent", ip: "203.0.113.10" },
    });
    expect(JSON.stringify(mem.audit)).not.toContain(PASSWORD);
    expect(JSON.stringify(mem.audit)).not.toContain("admin@example.com");
    await http().post("/auth/admin/logout").set("Authorization", `Bearer ${body.token}`).expect(204);
    expect([...mem.sessions.values()][0]).toMatchObject({ revoke_reason: "logout" });
  });

  it("нет логина и неверный пароль — одинаковый 401; оба пути считаются в счётчике пары", async () => {
    const a = await login("nobody@example.com", PASSWORD).expect(401);
    const b = await login("admin@example.com", "wrong password!").expect(401);
    const strip = (r: { body: unknown }) => ({ ...(r.body as ErrorEnvelope).error, correlationId: "" });
    expect(strip(a)).toEqual(strip(b));
    expect((a.body as ErrorEnvelope).error).toMatchObject({
      code: "UNAUTHENTICATED",
      messageKey: "errors.auth.invalidCredentials",
    });
    expect(mem.audit.map((x) => [x.action, x.newValues?.reason, x.entityId])).toEqual([
      ["auth.admin.login_failed", "unknown_login", null],
      ["auth.admin.login_failed", "invalid_password", cred.id],
    ]);
    expect(mem.audit.every((x) => x.actor.type === "system")).toBe(true);
    expect(JSON.stringify(mem.audit)).not.toMatch(/wrong password|nobody@example/);
    expect(creds.pairs.size).toBe(2);
    expect(cred.failed_attempts).toBe(1);
    expect(mem.sessions.size).toBe(0);
  });

  // 6 входов через scrypt — на нагруженной машине дольше 5 с по умолчанию.
  it("5 неудач с одного адреса — заперт только этот адрес на 15 мин; с другого адреса — вход", async () => {
    for (let i = 0; i < 5; i++) await login("admin@example.com", `wrong-${i}-password`).expect(401);
    const pair = [...creds.pairs.values()][0]!;
    const until = pair.locked_until!.getTime() - Date.now();
    expect(until).toBeGreaterThan(14 * MIN);
    expect(until).toBeLessThanOrEqual(15 * MIN);
    expect(mem.audit.filter((x) => x.action === "auth.admin.locked").map((x) => x.newValues)).toEqual([
      { scope: "login_client", minutes: 15 },
    ]);
    // Учётка не заперта: глобальный порог высокий.
    expect(cred.locked_until).toBeNull();
    const locked = await login("admin@example.com", PASSWORD).expect(401);
    expect((locked.body as ErrorEnvelope).error.messageKey).toBe("errors.auth.invalidCredentials");
    expect(reasons().at(-1)).toBe("locked");
    // Попытки в блокировке не считаются ни в паре, ни глобально.
    expect(cred.failed_attempts).toBe(5);
    await login("admin@example.com", PASSWORD, "198.51.100.7").expect(201);
    pair.locked_until = new Date(Date.now() - 1000);
    await login("admin@example.com", PASSWORD).expect(201);
    expect(creds.pairs.size).toBe(0);
  }, 20_000);

  it("глобальная блокировка учётки — после 50 неудач за час с разных адресов", async () => {
    for (let i = 0; i < LOGIN_MAX_FAILED_ATTEMPTS; i++)
      await login("admin@example.com", "wrong-password-x", `198.51.100.${i % 25}`).expect(401);
    expect(cred.locked_until!.getTime()).toBeGreaterThan(Date.now() + 14 * MIN);
    expect(
      mem.audit.filter((x) => x.action === "auth.admin.locked" && x.newValues?.scope === "login"),
    ).toHaveLength(1);
    await login("admin@example.com", PASSWORD, "192.0.2.200").expect(401);
    expect(reasons().at(-1)).toBe("locked");
  }, 60_000);

  it("пользователь не активен — при верном пароле тот же 401, без аудита успешного входа и сессии", async () => {
    mem.users.get(userId)!.status = "blocked";
    const res = await login("admin@example.com", PASSWORD).expect(401);
    expect((res.body as ErrorEnvelope).error.messageKey).toBe("errors.auth.invalidCredentials");
    expect(mem.audit.map((a) => a.action)).toEqual(["auth.admin.login_failed"]);
    expect(reasons()).toEqual(["user_inactive"]);
    expect(mem.sessions.size).toBe(0);
    expect(cred.last_login_at).toBeNull();
  });

  it("учётка с 2FA при верном пароле — тот же 401, что неверный пароль; причина только в аудите", async () => {
    cred.mfa_method = "totp";
    const right = await login("admin@example.com", PASSWORD).expect(401);
    const wrong = await login("admin@example.com", "wrong password!").expect(401);
    const strip = (r: { body: unknown }) => ({ ...(r.body as ErrorEnvelope).error, correlationId: "" });
    expect(strip(right)).toEqual(strip(wrong));
    expect(reasons()).toEqual(["mfa_not_supported", "invalid_password"]);
    expect(mem.sessions.size).toBe(0);
  });

  it("блокировка сработала между чтением и проверкой пароля — успешный вход перепроверяет её: 401, без сессии", async () => {
    for (let i = 0; i < 5; i++) await login("admin@example.com", `wrong-${i}-password`).expect(401);
    creds.staleLookup = true;
    await login("admin@example.com", PASSWORD).expect(401);
    expect(reasons().at(-1)).toBe("locked");
    expect(mem.sessions.size).toBe(0);
    expect(mem.audit.some((a) => a.action === "auth.admin.login")).toBe(false);
  });

  it("после неудачи — очистка устаревших счётчиков отдельным вызовом; после успеха — нет", async () => {
    await login("admin@example.com", "wrong password!").expect(401);
    await login("nobody@example.com", "wrong password!").expect(401);
    expect(creds.purges).toBe(2);
    await login("admin@example.com", PASSWORD).expect(201);
    expect(creds.purges).toBe(2);
  });

  it("валидация тела: нет пароля, лишнее поле, слишком длинный пароль — 400; выход без сессии — 401", async () => {
    await http().post("/auth/admin/login").send({ login: "admin@example.com" }).expect(400);
    await http()
      .post("/auth/admin/login")
      .send({ login: "admin@example.com", password: PASSWORD, role: "SUPERADMIN" })
      .expect(400);
    await login("admin@example.com", "x".repeat(257)).expect(400);
    await http().post("/auth/admin/logout").expect(401);
    expect(mem.audit).toEqual([]);
  });

  it("у входа свой rate limit на IP", () => {
    const handler = Object.getOwnPropertyDescriptor(AdminAuthController.prototype, "login")!.value as object;
    expect(Reflect.getMetadata(RATE_LIMIT_RULE, handler)).toEqual(ADMIN_LOGIN_RATE_LIMIT);
  });
});
