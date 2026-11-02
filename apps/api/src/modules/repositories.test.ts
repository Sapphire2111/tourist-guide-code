// Unit: Nest-модули базовых сущностей отдают репозитории через DI, запросы репозиториев строятся как ожидается.
// Выполнение на реальной БД — test/integration/entities.test.ts.
import { Test } from "@nestjs/testing";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { recordingDb } from "../../test/support/recording-db.js";
import { DatabaseModule, regionContext, SYSTEM_CONTEXT, type Database } from "../db/index.js";
import { AnalyticsEventsRepository, AnalyticsModule } from "./analytics/index.js";
import { AuditLogRepository, AuditModule } from "./audit/index.js";
import { IdempotencyKeysRepository, IdempotencyModule } from "./idempotency/index.js";
import { RegionsModule, RegionsRepository } from "./regions/index.js";
import { UsersModule, UsersRepository } from "./users/index.js";

describe("модули базовых сущностей", () => {
  it("репозитории разрешаются через DI с глобальным DatabaseModule (без соединения с БД)", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        RegionsModule,
        UsersModule,
        AuditModule,
        IdempotencyModule,
        AnalyticsModule,
      ],
    }).compile();
    for (const Repo of [
      RegionsRepository,
      UsersRepository,
      AuditLogRepository,
      IdempotencyKeysRepository,
      AnalyticsEventsRepository,
    ])
      expect(moduleRef.get(Repo)).toBeInstanceOf(Repo);
    await moduleRef.close();
  });
});

describe("запросы репозиториев", () => {
  it("analytics: listByName добавляет только заданные границы периода и лимит", async () => {
    const { db, queries } = recordingDb({ defaultTenant: SYSTEM_CONTEXT });
    const repo = new AnalyticsEventsRepository(db);
    await repo.listByName("qr_scanned");
    const since = new Date("2026-11-01T00:00:00Z");
    await repo.listByName("qr_scanned", { since, limit: 10 });

    expect(queries[0]?.sql).toBe(
      'select * from "analytics_events" where "event_name" = $1 order by "occurred_at", "id" limit $2',
    );
    expect(queries[0]?.parameters).toEqual(["qr_scanned", 100]);
    expect(queries[1]?.sql).toContain('"occurred_at" >= $2');
    expect(queries[1]?.sql).not.toContain('"occurred_at" <');
    expect(queries[1]?.parameters).toEqual(["qr_scanned", since, 10]);
  });

  it("idempotency: deleteExpired удаляет по expires_at <= now", async () => {
    const { db, queries } = recordingDb();
    const now = new Date("2026-11-01T00:00:00Z");
    await new IdempotencyKeysRepository(db).deleteExpired(now);
    expect(queries[0]?.sql).toBe('delete from "idempotency_keys" where "expires_at" <= $1');
    expect(queries[0]?.parameters).toEqual([now]);
  });

  it("users: create без полей — DEFAULT VALUES, с полями — обычный VALUES", async () => {
    const { db, queries } = recordingDb();
    const repo = new UsersRepository(db);
    // DummyDriver не возвращает строк — executeTakeFirstOrThrow бросает NoResultError; важен только SQL.
    await repo.create().catch(() => undefined);
    await repo.create({ language: undefined }).catch(() => undefined);
    await repo.create({ language: "en" }).catch(() => undefined);
    expect(queries.map((q) => q.sql)).toEqual([
      'insert into "users" default values returning *',
      'insert into "users" default values returning *',
      'insert into "users" ("language") values ($1) returning *',
    ]);
  });

  it("update с пустым patch не строит UPDATE, а читает текущую запись", async () => {
    const id = "0190f5c2-7d3e-7000-8000-000000000001";
    const cases: [string, (db: Kysely<Database>) => Promise<unknown>][] = [
      ["regions", (db) => new RegionsRepository(db).update(id, {})],
      ["users", (db) => new UsersRepository(db).update(id, { status: undefined })],
      ["idempotency_keys", (db) => new IdempotencyKeysRepository(db).update(id, {})],
    ];
    for (const [table, run] of cases) {
      const { db, queries } = recordingDb();
      await run(db);
      expect(queries.map((q) => q.sql)).toEqual([`select * from "${table}" where "id" = $1`]);
      expect(queries[0]?.parameters).toEqual([id]);
    }
  });

  it("update с полями строит UPDATE ... SET", async () => {
    const { db, queries } = recordingDb();
    await new UsersRepository(db).update("x", { status: "blocked" });
    expect(queries[0]?.sql).toBe('update "users" set "status" = $1 where "id" = $2 returning *');
  });

  it("audit: только append и чтение — методов изменения нет", () => {
    const methods = Object.getOwnPropertyNames(AuditLogRepository.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual([
      "append",
      "appendPii",
      "findById",
      "findPii",
      "listByEntity",
      "listRecent",
      "search",
    ]);
  });

  it("audit/analytics в контексте региона: фильтр и region_id из контекста", async () => {
    const region = "0190f5c2-7d3e-7000-8000-00000000000a";
    const { db, queries } = recordingDb({ defaultTenant: regionContext(region) });
    await new AuditLogRepository(db).findById("x");
    await new AuditLogRepository(db).listRecent(5);
    await new AuditLogRepository(db)
      .append({ actor_type: "system", action: "a", entity_type: "t" })
      .catch(() => undefined);
    await new AnalyticsEventsRepository(db).listByName("qr_scanned");
    expect(queries.map((q) => q.sql)).toEqual([
      'select * from "audit_logs" where ("id" = $1) and "audit_logs"."region_id" = $2',
      'select * from "audit_logs" where "audit_logs"."region_id" = $1 order by "created_at" desc, "id" desc limit $2',
      'insert into "audit_logs" ("actor_type", "action", "entity_type", "region_id") values ($1, $2, $3, $4) returning *',
      'select * from "analytics_events" where ("event_name" = $1) and "analytics_events"."region_id" = $2 order by "occurred_at", "id" limit $3',
    ]);
    for (const q of queries) expect(q.parameters).toContain(region);
  });

  it("audit/analytics без tenant-контекста — ошибка", async () => {
    const { db } = recordingDb();
    await expect(new AuditLogRepository(db).listRecent()).rejects.toThrow(/без tenant-контекста/);
    await expect(new AnalyticsEventsRepository(db).listByName("x")).rejects.toThrow(/без tenant-контекста/);
  });
});
