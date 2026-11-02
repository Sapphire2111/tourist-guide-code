// T1-09: базовые сущности (миграция 0002) на реальной PostgreSQL 17 + PostGIS 3.5:
// ограничения, уникальности, FK и репозитории.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, SYSTEM_CONTEXT, type Db } from "../../src/db/index.js";
import { AnalyticsEventsRepository } from "../../src/modules/analytics/index.js";
import { AuditLogRepository } from "../../src/modules/audit/index.js";
import { IdempotencyKeysRepository } from "../../src/modules/idempotency/index.js";
import { RegionsRepository } from "../../src/modules/regions/index.js";
import { UsersRepository } from "../../src/modules/users/index.js";
import {
  buildIdempotencyKey,
  buildRegion,
  createAnalyticsEvent,
  createAuditLog,
  createIdempotencyKey,
  createRegion,
  createUser,
  sha256Hex,
} from "../factories/index.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

/** Ошибка PostgreSQL с кодом SQLSTATE (и именем ограничения, если есть). */
async function pgError(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { code?: string; constraint?: string };
  }
  throw new Error("Ожидалась ошибка PostgreSQL, запрос выполнился");
}

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

describe.skipIf(!dockerAvailable)(`Базовые сущности (T1-09)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    tdb = await startDatabase();
    // Роль контейнера — superuser (владелец схемы): RLS к ней не применяется. Tenant-контекст для
    // TenantGuardPlugin — SYSTEM (кросс-tenant, запросы не меняются); изоляция — test/integration/tenancy.test.ts.
    db = createDatabase({
      connectionString: tdb.container.getConnectionUri(),
      maxConnections: 2,
      defaultTenant: SYSTEM_CONTEXT,
    });
  });

  afterAll(async () => {
    await db?.destroy();
    await stopDatabase(tdb);
  });

  it("миграция 0002 применена на чистую БД, таблицы созданы", async () => {
    expect(tdb!.applied).toContain("0002_base_entities.sql");
    const { rows } = await tdb!.client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [["regions", "users", "audit_logs", "idempotency_keys", "analytics_events"]],
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "analytics_events",
      "audit_logs",
      "idempotency_keys",
      "regions",
      "users",
    ]);
  });

  describe("regions", () => {
    it("репозиторий: вставка с uuidv7 и значениями по умолчанию, чтение по id и коду", async () => {
      const repo = new RegionsRepository(db);
      const created = await repo.create({
        code: `r-${Date.now()}`,
        name_i18n: { uk: "Регіон", pl: "Region" },
      });
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
      expect(created).toMatchObject({ status: "draft", timezone: "Europe/Kyiv", default_language: "uk" });
      expect(created.name_i18n).toEqual({ uk: "Регіон", pl: "Region" });
      expect(created.created_at).toBeInstanceOf(Date);

      expect(await repo.findById(created.id)).toEqual(created);
      expect(await repo.findByCode(created.code)).toEqual(created);
      expect((await repo.list()).map((r) => r.id)).toContain(created.id);
    });

    it("update меняет поля, updated_at ставит триггер", async () => {
      const repo = new RegionsRepository(db);
      const r = await createRegion(db, { status: "draft" });
      await sql`SELECT pg_sleep(0.01)`.execute(db);
      const updated = await repo.update(r.id, { status: "suspended" });
      expect(updated?.status).toBe("suspended");
      expect(updated!.updated_at.getTime()).toBeGreaterThan(r.updated_at.getTime());
      expect(updated!.created_at).toEqual(r.created_at);
    });

    it("name_i18n без непустого uk отклоняется CHECK", async () => {
      const bad: unknown[] = [{ en: "Region" }, { uk: "" }, { uk: "   " }, { uk: 1 }, ["uk"], "Регіон"];
      for (const name of bad) {
        const e = await pgError(
          sql`INSERT INTO regions (code, name_i18n) VALUES (${`bad-${Math.random().toString(36).slice(2, 8)}`}, ${JSON.stringify(name)}::jsonb)`.execute(
            db,
          ),
        );
        expect(e.code, JSON.stringify(name)).toBe(CHECK_VIOLATION);
        expect(e.constraint).toBe("regions_name_i18n_uk");
      }
    });

    it("name_i18n: ключи — коды языков, значения — строки", async () => {
      for (const name of [
        { uk: "Регіон", EN: "Region" },
        { uk: "Регіон", en: 5 },
      ]) {
        const e = await pgError(new RegionsRepository(db).create(buildRegion({ name_i18n: name as never })));
        expect(e.code).toBe(CHECK_VIOLATION);
      }
    });

    it("code уникален и по формату; status — из перечня", async () => {
      const r = await createRegion(db);
      expect((await pgError(createRegion(db, { code: r.code }))).code).toBe(UNIQUE_VIOLATION);
      expect((await pgError(createRegion(db, { code: "Has Spaces" }))).constraint).toBe(
        "regions_code_format",
      );
      expect((await pgError(createRegion(db, { status: "deleted" as never }))).constraint).toBe(
        "regions_status_check",
      );
    });
  });

  describe("users", () => {
    it("репозиторий: значения по умолчанию (uk, active), чтение, обновление", async () => {
      const repo = new UsersRepository(db);
      const u = await repo.create();
      expect(u).toMatchObject({ language: "uk", status: "active" });
      expect(await repo.findById(u.id)).toEqual(u);
      const updated = await repo.update(u.id, { language: "en", status: "blocked" });
      expect(updated).toMatchObject({ language: "en", status: "blocked" });
      // Пустой patch не ломает запрос и возвращает текущую запись без изменения updated_at.
      expect(await repo.update(u.id, {})).toEqual(updated);
    });

    it("language по формату кода, status — из перечня", async () => {
      expect((await pgError(createUser(db, { language: "ukr-ua" }))).constraint).toBe(
        "users_language_format",
      );
      expect((await pgError(createUser(db, { language: "" }))).constraint).toBe("users_language_format");
      expect((await pgError(createUser(db, { status: "deleted" as never }))).constraint).toBe(
        "users_status_check",
      );
      expect((await createUser(db, { language: "pt-BR" })).language).toBe("pt-BR");
    });
  });

  describe("audit_logs", () => {
    it("репозиторий: append пишет запись, listByEntity возвращает историю по порядку", async () => {
      const region = await createRegion(db);
      const user = await createUser(db);
      const entityId = region.id;
      const first = await createAuditLog(db, {
        actor_user_id: user.id,
        region_id: region.id,
        action: "region.edit",
        entity_type: "region",
        entity_id: entityId,
        old_values: { status: "draft" },
        new_values: { status: "active" },
        request_id: "req-1",
      });
      const second = await createAuditLog(db, { entity_type: "region", entity_id: entityId });
      expect(first).toMatchObject({ actor_type: "user", actor_user_id: user.id, region_id: region.id });
      expect(first.old_values).toEqual({ status: "draft" });
      expect(second).toMatchObject({ actor_type: "system", actor_user_id: null, region_id: null });

      const history = await new AuditLogRepository(db).listByEntity("region", entityId);
      expect(history.map((h) => h.id)).toEqual([first.id, second.id]);
    });

    it("актор согласован: user — с пользователем, system — без", async () => {
      const user = await createUser(db);
      for (const bad of [
        { actor_type: "user" as const, actor_user_id: null },
        { actor_type: "system" as const, actor_user_id: user.id },
      ]) {
        const e = await pgError(createAuditLog(db, bad));
        expect(e.constraint).toBe("audit_logs_actor_consistent");
      }
    });

    it("FK: несуществующие пользователь/регион отклоняются; пользователя с записями аудита не удалить", async () => {
      const ghost = "0190f5c2-7d3e-7000-8000-00000000dead";
      expect((await pgError(createAuditLog(db, { actor_user_id: ghost }))).code).toBe(FK_VIOLATION);
      expect((await pgError(createAuditLog(db, { region_id: ghost }))).code).toBe(FK_VIOLATION);

      const user = await createUser(db);
      await createAuditLog(db, { actor_user_id: user.id });
      expect((await pgError(db.deleteFrom("users").where("id", "=", user.id).execute())).code).toBe(
        FK_VIOLATION,
      );
    });
  });

  describe("idempotency_keys", () => {
    it("репозиторий: create/find/update, значения по умолчанию", async () => {
      const repo = new IdempotencyKeysRepository(db);
      const k = await createIdempotencyKey(db);
      expect(k.status).toBe("in_progress");
      expect(await repo.find(k.scope, k.key)).toEqual(k);

      const done = await repo.update(k.id, {
        status: "completed",
        response_status: 201,
        response_body: { id: "x", items: [1, 2] },
      });
      expect(done).toMatchObject({ status: "completed", response_status: 201 });
      expect(done?.response_body).toEqual({ id: "x", items: [1, 2] });
    });

    it("уникальность (scope, key): тот же ключ в другом scope допустим", async () => {
      const k = await createIdempotencyKey(db, { key: "same-key" });
      expect((await pgError(createIdempotencyKey(db, { scope: k.scope, key: "same-key" }))).constraint).toBe(
        "idempotency_keys_scope_key_key",
      );
      const other = await createIdempotencyKey(db, { key: "same-key" });
      expect(other.scope).not.toBe(k.scope);
    });

    it("CHECK: хэш тела — sha256 hex, completed — с кодом ответа", async () => {
      expect((await pgError(createIdempotencyKey(db, { request_hash: "abc" }))).constraint).toBe(
        "idempotency_keys_request_hash_format",
      );
      expect((await pgError(createIdempotencyKey(db, { status: "completed" }))).constraint).toBe(
        "idempotency_keys_completed_has_response",
      );
      expect(
        (await pgError(createIdempotencyKey(db, { status: "completed", response_status: 42 }))).constraint,
      ).toBe("idempotency_keys_response_status_range");
    });

    it("deleteExpired удаляет только истёкшие", async () => {
      const repo = new IdempotencyKeysRepository(db);
      const base = Date.now();
      const soon = await repo.create(buildIdempotencyKey({ expires_at: new Date(base + 60_000) }));
      const later = await repo.create(
        buildIdempotencyKey({ expires_at: new Date(base + 3_600_000), request_hash: sha256Hex("x") }),
      );
      // Порог между двумя ключами (и после всех ключей других тестов с меньшим сроком).
      const deleted = await repo.deleteExpired(new Date(base + 120_000));
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(await repo.find(soon.scope, soon.key)).toBeUndefined();
      expect(await repo.find(later.scope, later.key)).toBeDefined();
    });
  });

  describe("analytics_events", () => {
    it("репозиторий: insert и listByName по периоду", async () => {
      const region = await createRegion(db);
      const pseudonym = randomUUID();
      const t0 = new Date("2026-11-01T10:00:00Z");
      const name = `test_event_${Date.now()}`;
      const e1 = await createAnalyticsEvent(db, {
        event_name: name,
        occurred_at: t0,
        pseudonymous_user_id: pseudonym,
        region_id: region.id,
        properties: { source: "qr" },
      });
      const e2 = await createAnalyticsEvent(db, {
        event_name: name,
        occurred_at: new Date(t0.getTime() + 60_000),
      });
      expect(e1).toMatchObject({ schema_version: 1, pseudonymous_user_id: pseudonym, region_id: region.id });
      expect(e2).toMatchObject({ pseudonymous_user_id: null, region_id: null });
      expect(e1.properties).toEqual({ source: "qr" });
      expect(e2.properties).toEqual({});

      const repo = new AnalyticsEventsRepository(db);
      expect((await repo.listByName(name)).map((e) => e.id)).toEqual([e1.id, e2.id]);
      expect((await repo.listByName(name, { since: new Date(t0.getTime() + 1) })).map((e) => e.id)).toEqual([
        e2.id,
      ]);
      expect((await repo.listByName(name, { until: new Date(t0.getTime() + 1) })).map((e) => e.id)).toEqual([
        e1.id,
      ]);
    });

    it("CHECK: формат имени, версия схемы > 0, свойства — объект", async () => {
      expect((await pgError(createAnalyticsEvent(db, { event_name: "App Opened" }))).constraint).toBe(
        "analytics_events_event_name_format",
      );
      expect((await pgError(createAnalyticsEvent(db, { schema_version: 0 }))).constraint).toBe(
        "analytics_events_schema_version_positive",
      );
      const e = await pgError(
        sql`INSERT INTO analytics_events (event_name, schema_version, occurred_at, properties)
            VALUES ('app_opened', 1, now(), '[1]'::jsonb)`.execute(db),
      );
      expect(e.constraint).toBe("analytics_events_properties_object");
    });

    it("pseudonymous_user_id без FK на users: псевдоним не обязан совпадать с id пользователя", async () => {
      const e = await createAnalyticsEvent(db, { pseudonymous_user_id: randomUUID() });
      const { rows } = await tdb!.client.query(
        `SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'analytics_events' AND constraint_type = 'FOREIGN KEY'
           AND constraint_name LIKE '%pseudonymous%'`,
      );
      expect(rows).toEqual([]);
      // Обнуление связи при удалении аккаунта — единственное разрешённое изменение (тип Updateable).
      await db
        .updateTable("analytics_events")
        .set({ pseudonymous_user_id: null })
        .where("id", "=", e.id)
        .execute();
      const row = await db
        .selectFrom("analytics_events")
        .select("pseudonymous_user_id")
        .where("id", "=", e.id)
        .executeTakeFirstOrThrow();
      expect(row.pseudonymous_user_id).toBeNull();
    });
  });

  it("регион со ссылками не удалить (ON DELETE RESTRICT)", async () => {
    const region = await createRegion(db);
    await createAnalyticsEvent(db, { region_id: region.id });
    expect((await pgError(db.deleteFrom("regions").where("id", "=", region.id).execute())).code).toBe(
      FK_VIOLATION,
    );
  });
});
