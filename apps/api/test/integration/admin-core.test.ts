// Блок 3, часть 3B (ADR-0018) на реальной PostgreSQL под ролью приложения: миграция 0013 (гранты, CHECK, RLS),
// CLI-функция createAdmin, вход админа по паролю с блокировкой, изоляция регионов на каждом новом admin-эндпоинте
// (список, чтение по id, изменение) — /admin/qr-points, /admin/emergency-contacts, /admin/audit-logs — и
// публичный GET /regions/{id}/emergency-contacts.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { configureApp } from "../../src/bootstrap/configure-app.js";
import { TenancyModule } from "../../src/common/tenancy/index.js";
import { createDatabase, DatabaseModule, regionContext, withTenant, type Db } from "../../src/db/index.js";
import { AdminAuthModule, createAdmin } from "../../src/modules/admin-auth/index.js";
import { AuditModule } from "../../src/modules/audit/index.js";
import { AuthModule } from "../../src/modules/auth/index.js";
import { EmergencyContactsModule } from "../../src/modules/emergency-contacts/index.js";
import { QrPointsModule } from "../../src/modules/qr-points/index.js";
import { RbacModule, RbacTenantContextSource } from "../../src/modules/rbac/index.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_admin_core_test";
const APP_PASSWORD = "tg_api_admin_core_test";
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const PASSWORD = "integration-password-1";
const BOT = "t18_tourist_bot";

type Issued = { token: string; session: { id: string; userId: string; channel: string } };
type Item = { id: string; regionId: string };

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; constraint?: string };
  }
  throw new Error("Ожидалась ошибка PostgreSQL, запрос выполнился");
}

describe.skipIf(!dockerAvailable)(
  `Ядро админки: вход, QR, экстренные контакты, аудит (блок 3)${title}`,
  () => {
    let tdb: TestDatabase | undefined;
    let owner: pg.Client;
    let appDb: Db;
    let app: INestApplication;
    let regionA: string;
    let regionB: string;
    let draftRegion: string;
    const tokens = {} as Record<"adminA" | "adminB" | "superadmin", string>;
    const http = () => request(app.getHttpServer());
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
    const login = async (loginName: string, password = PASSWORD) =>
      http().post("/auth/admin/login").set("User-Agent", "t18-agent").send({ login: loginName, password });

    beforeAll(async () => {
      tdb = await startDatabase();
      owner = tdb.client; // superuser контейнера = роль миграций
      await owner.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
      const region = async (code: string, status: string) =>
        String(
          (
            await owner.query(
              `INSERT INTO regions (code, name_i18n, status) VALUES ($1, '{"uk": "Регіон"}', $2) RETURNING id`,
              [code, status],
            )
          ).rows[0]!.id,
        );
      regionA = await region("t18-a", "active");
      regionB = await region("t18-b", "active");
      draftRegion = await region("t18-draft", "draft");
      const url = new URL(tdb.container.getConnectionUri());
      url.username = APP_LOGIN;
      url.password = APP_PASSWORD;
      appDb = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
      // Учётки — той же функцией, что CLI admin:create, под ролью приложения.
      await createAdmin(appDb, {
        login: "admin-a",
        role: "REGION_ADMIN",
        regionCode: "t18-a",
        password: PASSWORD,
      });
      await createAdmin(appDb, {
        login: "admin-b",
        role: "REGION_ADMIN",
        regionCode: "t18-b",
        password: PASSWORD,
      });
      await createAdmin(appDb, {
        login: "root@example.com",
        role: "SUPERADMIN",
        regionCode: null,
        password: PASSWORD,
      });
      await createAdmin(appDb, {
        login: "victim",
        role: "REGION_ADMIN",
        regionCode: "t18-a",
        password: PASSWORD,
      });

      const moduleRef = await Test.createTestingModule({
        imports: [
          DatabaseModule.forRoot({ connectionString: url.toString() }),
          TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
          RbacModule,
          AuthModule.forRoot({ appEnv: "local" }),
          AuditModule,
          AdminAuthModule.forRoot(),
          QrPointsModule.forRoot({ botUsername: BOT }),
          EmergencyContactsModule,
        ],
      }).compile();
      app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
      await app.init();
      tokens.adminA = ((await login("admin-a")).body as Issued).token;
      tokens.adminB = ((await login("ADMIN-B")).body as Issued).token;
      tokens.superadmin = ((await login("root@example.com")).body as Issued).token;
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await appDb?.destroy();
      await stopDatabase(tdb);
    });

    it("миграция 0013 применена; учётки: хэш scrypt, логин в нижнем регистре, назначение роли с аудитом", async () => {
      expect(tdb!.applied).toContain("0013_admin_core.sql");
      const { rows } = await owner.query(
        `SELECT c.login, c.password_hash, ra.role, ra.region_id
       FROM admin_credentials c JOIN role_assignments ra ON ra.user_id = c.user_id ORDER BY c.login`,
      );
      expect(rows.map((r: { login: string }) => r.login)).toEqual([
        "admin-a",
        "admin-b",
        "root@example.com",
        "victim",
      ]);
      for (const r of rows as { password_hash: string }[]) {
        expect(r.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
        expect(r.password_hash).not.toContain(PASSWORD);
      }
      expect(rows.find((r: { login: string }) => r.login === "admin-a")).toMatchObject({
        role: "REGION_ADMIN",
        region_id: regionA,
      });
      const audit = await owner.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('auth.admin.credential.create', 'role.assign')",
      );
      expect(audit.rows[0]!.n).toBe(8);
      await expect(
        createAdmin(appDb, { login: "Admin-A", role: "MODERATOR", regionCode: "t18-a", password: PASSWORD }),
      ).rejects.toThrow(/уже занят/);
      await expect(
        createAdmin(appDb, { login: "ghost", role: "MODERATOR", regionCode: "nope", password: PASSWORD }),
      ).rejects.toThrow(/не найден/);
    });

    it("гранты 0013: роль приложения не удаляет учётки; CHECK формата логина, хэша, метки рекламы, периода, телефона", async () => {
      const del = await pgError(
        withTenant(appDb, regionContext(regionA), (trx) => trx.deleteFrom("admin_credentials").execute()),
      );
      expect(del.code).toBe(INSUFFICIENT_PRIVILEGE);
      const user = String((await owner.query("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0]!.id);
      for (const [sqlText, params, constraint] of [
        [
          "INSERT INTO admin_credentials (user_id, login, password_hash) VALUES ($1, 'Upper', 'scrypt$1$1$1$a$b')",
          [user],
          "admin_credentials_login_format",
        ],
        [
          "INSERT INTO admin_credentials (user_id, login, password_hash) VALUES ($1, 'plain', 'secret')",
          [user],
          "admin_credentials_password_hash_format",
        ],
        [
          `INSERT INTO promotions (region_id, title_i18n, ad_label, starts_at, ends_at)
         VALUES ($1, '{"uk": "Акція"}', 'none', now(), now() + interval '1 day')`,
          [regionA],
          "promotions_ad_label_check",
        ],
        [
          `INSERT INTO promotions (region_id, title_i18n, starts_at, ends_at)
         VALUES ($1, '{"uk": "Акція"}', now(), now() - interval '1 day')`,
          [regionA],
          "promotions_period_check",
        ],
        [
          `INSERT INTO emergency_contacts (region_id, kind, name_i18n, phone) VALUES ($1, 'police', '{"uk": "П"}', '+0123')`,
          [regionA],
          "emergency_contacts_phone_format",
        ],
      ] as const) {
        const err = await pgError(owner.query(sqlText, [...params]));
        expect(err, constraint).toMatchObject({ code: CHECK_VIOLATION, constraint });
      }
      const promo = await owner.query(
        `INSERT INTO promotions (region_id, title_i18n, starts_at, ends_at)
       VALUES ($1, '{"uk": "Акція"}', now(), now() + interval '1 day') RETURNING ad_label, status`,
        [regionA],
      );
      // Метка «реклама» есть всегда, даже если её не задали.
      expect(promo.rows[0]).toEqual({ ad_label: "advertising", status: "draft" });
      const seenFromB = await withTenant(appDb, regionContext(regionB), (trx) =>
        trx.selectFrom("promotions").selectAll().execute(),
      );
      expect(seenFromB).toEqual([]);
    });

    it("вход: сессия admin_web; 5 неудач — блокировка (верный пароль тоже 401), аудит без пароля", async () => {
      const ok = await login("admin-a");
      expect(ok.status).toBe(201);
      expect((ok.body as Issued).session.channel).toBe("admin_web");

      for (let i = 0; i < 5; i++) expect((await login("victim", `wrong-password-${i}`)).status).toBe(401);
      // Заперта пара «логин + адрес», а не учётка: глобальный счётчик — 5 из 50, учётка открыта.
      const cred = await owner.query(
        "SELECT failed_attempts, locked_until FROM admin_credentials WHERE login = 'victim'",
      );
      expect(cred.rows[0]).toEqual({ failed_attempts: 5, locked_until: null });
      const pair = await owner.query(
        "SELECT failed_attempts, locked_until, login_hash FROM admin_login_failures",
      );
      const locked = pair.rows.filter((r: { locked_until: Date | null }) => r.locked_until !== null);
      expect(locked).toHaveLength(1);
      expect(locked[0]!.failed_attempts).toBe(5);
      expect((locked[0]!.locked_until as Date).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
      expect(JSON.stringify(pair.rows)).not.toContain("victim");
      const whileLocked = await login("victim");
      expect(whileLocked.status).toBe(401);
      const unknown = await login("nobody-here");
      expect(unknown.status).toBe(401);
      expect((unknown.body as { error: { messageKey: string } }).error.messageKey).toBe(
        (whileLocked.body as { error: { messageKey: string } }).error.messageKey,
      );
      await owner.query("UPDATE admin_login_failures SET locked_until = now() - interval '1 second'");
      expect((await login("victim")).status).toBe(201);

      const audit = await owner.query(
        `SELECT l.action, l.new_values, p.user_agent FROM audit_logs l
       LEFT JOIN audit_log_pii p ON p.audit_log_id = l.id
       WHERE l.action LIKE 'auth.admin.%' AND l.action <> 'auth.admin.credential.create'`,
      );
      const actions = audit.rows.map((r: { action: string }) => r.action);
      expect(actions.filter((a: string) => a === "auth.admin.locked")).toHaveLength(1);
      expect(actions).toContain("auth.admin.login_failed");
      expect(audit.rows.every((r: { user_agent: string }) => r.user_agent === "t18-agent")).toBe(true);
      expect(JSON.stringify(audit.rows)).not.toMatch(
        /wrong-password|integration-password|victim|nobody-here/,
      );
    });

    it("гонка: 12 параллельных неудач с одного адреса — пара заперта ровно один раз, счётчики не теряются", async () => {
      await createAdmin(appDb, {
        login: "racer",
        role: "MODERATOR",
        regionCode: "t18-a",
        password: PASSWORD,
      });
      const before = await owner.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.admin.locked'",
      );
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => login("racer", `racer-wrong-${i}`)),
      );
      expect(results.every((r) => r.status === 401)).toBe(true);
      const after = await owner.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.admin.locked'",
      );
      expect(after.rows[0]!.n - before.rows[0]!.n).toBe(1);
      const g = await owner.query("SELECT failed_attempts FROM admin_credentials WHERE login = 'racer'");
      // Посчитаны все попытки, дошедшие до проверки пароля (≥ 5; прочитавшие блокировку — не считаются).
      expect(g.rows[0]!.failed_attempts).toBeGreaterThanOrEqual(5);
      expect(g.rows[0]!.failed_attempts).toBeLessThanOrEqual(12);
      const failed = await owner.query(
        `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.admin.login_failed'
         AND entity_id = (SELECT id::text FROM admin_credentials WHERE login = 'racer')`,
      );
      expect(failed.rows[0]!.n).toBe(12);
    });

    it("очистка: строки пар старше суток удаляются после неудачной попытки, свежие остаются", async () => {
      await owner.query(
        `INSERT INTO admin_login_failures (login_hash, client_hash, failed_attempts, last_failed_at)
         SELECT sha256(('old-' || g)::bytea), sha256('c'::bytea), 1, now() - interval '2 days'
         FROM generate_series(1, 3) g`,
      );
      expect((await login("nobody-purge", "wrong-password-purge")).status).toBe(401);
      const left = await owner.query(
        "SELECT count(*)::int AS n FROM admin_login_failures WHERE last_failed_at < now() - interval '1 day'",
      );
      expect(left.rows[0]!.n).toBe(0);
      const fresh = await owner.query("SELECT count(*)::int AS n FROM admin_login_failures");
      expect(fresh.rows[0]!.n).toBeGreaterThan(0);
    });

    it("конкурентный вход: 6 параллельных входов с верным паролем — все успешны, разные сессии", async () => {
      await createAdmin(appDb, {
        login: "parallel",
        role: "MODERATOR",
        regionCode: "t18-a",
        password: PASSWORD,
      });
      const results = await Promise.all(Array.from({ length: 6 }, () => login("parallel")));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
      const ids = new Set(results.map((r) => (r.body as Issued).session.id));
      expect(ids.size).toBe(6);
      const c = await owner.query(
        "SELECT failed_attempts, last_login_at FROM admin_credentials WHERE login = 'parallel'",
      );
      expect(c.rows[0]!.failed_attempts).toBe(0);
      expect(c.rows[0]!.last_login_at).toBeInstanceOf(Date);
    });

    it("пользователь заблокирован — при верном пароле 401, без записи успешного входа", async () => {
      const { userId } = await createAdmin(appDb, {
        login: "blocked-admin",
        role: "MODERATOR",
        regionCode: "t18-a",
        password: PASSWORD,
      });
      await owner.query("UPDATE users SET status = 'blocked' WHERE id = $1", [userId]);
      expect((await login("blocked-admin")).status).toBe(401);
      const logs = await owner.query(
        "SELECT action, new_values->>'reason' AS reason FROM audit_logs WHERE entity_id = (SELECT id::text FROM admin_credentials WHERE login = 'blocked-admin') AND action LIKE 'auth.admin.login%'",
      );
      expect(logs.rows).toEqual([{ action: "auth.admin.login_failed", reason: "user_inactive" }]);
    });

    describe("изоляция регионов на admin-эндпоинтах", () => {
      let qrA: Item;
      let contactA: Item;

      beforeAll(async () => {
        qrA = (
          await http()
            .post("/admin/qr-points")
            .set(bearer(tokens.adminA))
            .send({ type: "hotel", label: "Ресепшн", venue: { name: { uk: "Готель А" } } })
            .expect(201)
        ).body as Item;
        contactA = (
          await http()
            .post("/admin/emergency-contacts")
            .set(bearer(tokens.adminA))
            .send({ kind: "general", name: { uk: "Єдиний номер" }, phone: "112", sortOrder: 1 })
            .expect(201)
        ).body as Item;
      });

      it("QR: B не видит точку A — список, чтение, правка, вкл/выкл и печать; A — может", async () => {
        expect(qrA.regionId).toBe(regionA);
        const listB = (await http().get("/admin/qr-points").set(bearer(tokens.adminB)).expect(200)).body as {
          items: Item[];
        };
        expect(listB.items.map((i) => i.id)).not.toContain(qrA.id);
        await http().get(`/admin/qr-points/${qrA.id}`).set(bearer(tokens.adminB)).expect(404);
        await http()
          .patch(`/admin/qr-points/${qrA.id}`)
          .set(bearer(tokens.adminB))
          .send({ label: "x" })
          .expect(404);
        await http().post(`/admin/qr-points/${qrA.id}/deactivate`).set(bearer(tokens.adminB)).expect(404);
        await http().post(`/admin/qr-points/${qrA.id}/activate`).set(bearer(tokens.adminB)).expect(404);
        await http().get(`/admin/qr-points/${qrA.id}/print`).set(bearer(tokens.adminB)).expect(404);
        const row = await owner.query("SELECT label, active FROM qr_points WHERE id = $1", [qrA.id]);
        expect(row.rows[0]).toEqual({ label: "Ресепшн", active: true });

        const listA = (await http().get("/admin/qr-points").set(bearer(tokens.adminA)).expect(200)).body as {
          items: Item[];
        };
        expect(listA.items.map((i) => i.id)).toContain(qrA.id);
        await http()
          .patch(`/admin/qr-points/${qrA.id}`)
          .set(bearer(tokens.adminA))
          .send({ label: "Лобі" })
          .expect(200);
        const print = (
          await http().get(`/admin/qr-points/${qrA.id}/print`).set(bearer(tokens.adminA)).expect(200)
        ).body as { deepLink: string; code: string; svg: string };
        expect(print.deepLink).toBe(`https://t.me/${BOT}?startapp=${print.code}`);
        expect(print.svg.startsWith("<svg")).toBe(true);
        await http().post(`/admin/qr-points/${qrA.id}/deactivate`).set(bearer(tokens.adminA)).expect(200);
        await http().post(`/admin/qr-points/${qrA.id}/activate`).set(bearer(tokens.adminA)).expect(200);
      });

      it("экстренные контакты: B не видит контакт A — список, чтение, правка, удаление; публичный список — только активные", async () => {
        const listB = (await http().get("/admin/emergency-contacts").set(bearer(tokens.adminB)).expect(200))
          .body as {
          items: Item[];
        };
        expect(listB.items.map((i) => i.id)).not.toContain(contactA.id);
        await http().get(`/admin/emergency-contacts/${contactA.id}`).set(bearer(tokens.adminB)).expect(404);
        await http()
          .patch(`/admin/emergency-contacts/${contactA.id}`)
          .set(bearer(tokens.adminB))
          .send({ phone: "101" })
          .expect(404);
        await http()
          .delete(`/admin/emergency-contacts/${contactA.id}`)
          .set(bearer(tokens.adminB))
          .expect(404);
        const row = await owner.query("SELECT phone FROM emergency_contacts WHERE id = $1", [contactA.id]);
        expect(row.rows[0]).toEqual({ phone: "112" });

        const hidden = (
          await http()
            .post("/admin/emergency-contacts")
            .set(bearer(tokens.adminA))
            .send({ kind: "other", name: { uk: "Прихований" }, phone: "+380501234567", active: false })
            .expect(201)
        ).body as Item;
        const pub = (await http().get(`/regions/${regionA}/emergency-contacts`).expect(200)).body as {
          items: Item[];
        };
        expect(pub.items.map((i) => i.id)).toContain(contactA.id);
        expect(pub.items.map((i) => i.id)).not.toContain(hidden.id);
        expect(
          ((await http().get(`/regions/${regionB}/emergency-contacts`).expect(200)).body as { items: Item[] })
            .items,
        ).toEqual([]);
        await http().get(`/regions/${draftRegion}/emergency-contacts`).expect(404);
        await http().delete(`/admin/emergency-contacts/${hidden.id}`).set(bearer(tokens.adminA)).expect(204);
      });

      it("журнал аудита: A видит свои действия по фильтру action, B — нет; ПДн в ответе нет", async () => {
        const a = (
          await http()
            .get("/admin/audit-logs")
            .query({ action: "qr_point.create" })
            .set(bearer(tokens.adminA))
            .expect(200)
        ).body as { items: { entityId: string; regionId: string }[] };
        expect(a.items.map((i) => i.entityId)).toContain(qrA.id);
        expect(a.items.every((i) => i.regionId === regionA)).toBe(true);
        expect(JSON.stringify(a.items)).not.toContain("t18-agent");
        const b = (
          await http()
            .get("/admin/audit-logs")
            .query({ entityType: "qr_point", entityId: qrA.id })
            .set(bearer(tokens.adminB))
            .expect(200)
        ).body as { items: unknown[] };
        expect(b.items).toEqual([]);
      });

      it("SUPERADMIN: без выбранного региона видит точки всех регионов, создаёт — только выбрав регион", async () => {
        const all = (await http().get("/admin/qr-points").set(bearer(tokens.superadmin)).expect(200))
          .body as {
          items: Item[];
        };
        expect(all.items.map((i) => i.id)).toContain(qrA.id);
        await http()
          .post("/admin/qr-points")
          .set(bearer(tokens.superadmin))
          .send({ type: "region", label: "Стенд" })
          .expect(403);
        await http()
          .put("/auth/session/region")
          .set(bearer(tokens.superadmin))
          .send({ regionId: regionB })
          .expect(200);
        const created = (
          await http()
            .post("/admin/qr-points")
            .set(bearer(tokens.superadmin))
            .send({ type: "region", label: "Стенд" })
            .expect(201)
        ).body as Item;
        expect(created.regionId).toBe(regionB);
        // Админ A точку региона B не видит.
        await http().get(`/admin/qr-points/${created.id}`).set(bearer(tokens.adminA)).expect(404);
      });
    });
  },
);
