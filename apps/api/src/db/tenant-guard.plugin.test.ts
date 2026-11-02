// Unit (без БД): TenantGuardPlugin и withTenant — какой SQL уходит в БД в каждом tenant-контексте.
// Поведение на реальной PostgreSQL под ролью приложения (RLS) — test/integration/tenancy.test.ts.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { recordingDb } from "../../test/support/recording-db.js";
import {
  currentDb,
  currentTenant,
  PLATFORM_CONTEXT,
  regionContext,
  SYSTEM_CONTEXT,
  TABLE_TENANCY,
  TenantContextError,
  withTenant,
} from "./index.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const inA = regionContext(A);

describe("TenantGuardPlugin: без контекста", () => {
  it("глобальные таблицы — без контекста и без изменений", async () => {
    const { db, queries } = recordingDb();
    await db.selectFrom("regions").selectAll().where("code", "=", "x").execute();
    await db
      .selectFrom("users")
      .innerJoin("regions", (j) => j.onTrue())
      .selectAll()
      .execute();
    expect(queries.map((q) => q.sql)).toEqual([
      'select * from "regions" where "code" = $1',
      'select * from "users" inner join "regions" on true',
    ]);
  });

  it("запрос к tenant-таблице без контекста — TenantContextError, в БД ничего не уходит", async () => {
    const { db, queries } = recordingDb();
    const attempts = [
      () => db.selectFrom("audit_logs").selectAll().execute(),
      () =>
        db
          .selectFrom("regions")
          .where("id", "in", db.selectFrom("analytics_events").select("region_id"))
          .selectAll()
          .execute(),
      () =>
        db
          .insertInto("analytics_events")
          .values({ event_name: "e", schema_version: 1, occurred_at: new Date() })
          .execute(),
      () => db.deleteFrom("audit_logs").execute(),
      () => sql`SELECT count(*) FROM audit_logs`.execute(db),
      () => sql`select 1 from public."ANALYTICS_EVENTS"`.execute(db),
    ];
    // Подзапрос из db.selectFrom плагин обрабатывает уже при сборке внешнего запроса (синхронно).
    for (const run of attempts)
      await expect((async () => run())()).rejects.toBeInstanceOf(TenantContextError);
    expect(queries).toEqual([]);
  });

  it("имя tenant-таблицы через sql.id/sql.ref/sql.table без контекста — ошибка", async () => {
    const { db, queries } = recordingDb();
    const attempts = [
      () => db.selectFrom(sql.id("audit_logs").as("a")).selectAll().execute(),
      () =>
        db
          .selectFrom(sql`${sql.id("audit_logs")}`.as("a"))
          .selectAll()
          .execute(),
      () => db.selectFrom(sql.ref("analytics_events").as("a")).selectAll().execute(),
      () => db.selectFrom(sql.table("audit_logs").as("a")).selectAll().execute(),
      () => sql`select * from ${sql.id("audit_logs")}`.execute(db),
    ];
    for (const run of attempts)
      await expect((async () => run())()).rejects.toBeInstanceOf(TenantContextError);
    expect(queries).toEqual([]);
  });

  it("сырой SQL без tenant-таблиц проходит (set_config, служебные запросы)", async () => {
    const { db, queries } = recordingDb();
    await sql`SELECT now()`.execute(db);
    expect(queries).toHaveLength(1);
  });
});

describe("TenantGuardPlugin: контекст региона", () => {
  /** SQL и параметры последнего запроса, выполненного в контексте региона A. */
  async function inRegion(run: (db: ReturnType<typeof recordingDb>["db"]) => Promise<unknown>) {
    const { db, queries } = recordingDb({ defaultTenant: inA });
    await run(db);
    return queries.at(-1)!;
  }

  it("SELECT: фильтр region_id в WHERE, существующее условие — в скобках", async () => {
    const q = await inRegion((db) =>
      db
        .selectFrom("audit_logs")
        .selectAll()
        .where((eb) => eb("action", "=", "a").or("action", "=", "b"))
        .execute(),
    );
    expect(q.sql).toBe(
      'select * from "audit_logs" where (("action" = $1 or "action" = $2)) and "audit_logs"."region_id" = $3',
    );
    expect(q.parameters).toEqual(["a", "b", A]);

    const raw = await inRegion((db) =>
      db
        .selectFrom("audit_logs")
        .selectAll()
        .where(sql<boolean>`true or true`)
        .execute(),
    );
    expect(raw.sql).toBe('select * from "audit_logs" where (true or true) and "audit_logs"."region_id" = $1');
  });

  it("алиасы и JOIN: фильтр в ON для каждой tenant-таблицы, глобальные не трогает", async () => {
    const q = await inRegion((db) =>
      db
        .selectFrom("audit_logs as a")
        .leftJoin("analytics_events as e", "e.region_id", "a.region_id")
        .innerJoin("regions as r", "r.id", "a.region_id")
        .select(["a.id", "e.id as eid", "r.code"])
        .execute(),
    );
    expect(q.sql).toBe(
      'select "a"."id", "e"."id" as "eid", "r"."code" from "audit_logs" as "a"' +
        ' left join "analytics_events" as "e" on ("e"."region_id" = "a"."region_id") and "e"."region_id" = $1' +
        ' inner join "regions" as "r" on "r"."id" = "a"."region_id"' +
        ' where "a"."region_id" = $2',
    );
    expect(q.parameters).toEqual([A, A]);
  });

  it("подзапросы и CTE тоже фильтруются", async () => {
    const q = await inRegion((db) =>
      db
        .with("recent", (w) => w.selectFrom("analytics_events").select("id"))
        .selectFrom("regions")
        .where("id", "in", (eb) => eb.selectFrom("audit_logs").select("region_id"))
        .selectAll()
        .execute(),
    );
    expect(q.sql).toBe(
      'with "recent" as (select "id" from "analytics_events" where "analytics_events"."region_id" = $1)' +
        ' select * from "regions" where "id" in (select "region_id" from "audit_logs" where "audit_logs"."region_id" = $2)',
    );
  });

  it("подзапрос, собранный из db (плагин применяется при сборке), не получает фильтр дважды", async () => {
    const q = await inRegion((db) =>
      db
        .selectFrom("regions")
        .where(
          "id",
          "in",
          db
            .selectFrom("audit_logs")
            .leftJoin("analytics_events", "analytics_events.id", "audit_logs.entity_id")
            .select("audit_logs.region_id"),
        )
        .selectAll()
        .execute(),
    );
    expect(q.sql).toBe(
      'select * from "regions" where "id" in (select "audit_logs"."region_id" from "audit_logs"' +
        ' left join "analytics_events" on ("analytics_events"."id" = "audit_logs"."entity_id") and "analytics_events"."region_id" = $1' +
        ' where "audit_logs"."region_id" = $2)',
    );
  });

  it("своё условие на region_id с другим оператором не отключает фильтр (WHERE и ON)", async () => {
    for (const op of ["<>", "!=", ">", "is distinct from"] as const) {
      const q = await inRegion((db) =>
        db.selectFrom("audit_logs").selectAll().where("audit_logs.region_id", op, A).execute(),
      );
      expect(q.sql, op).toContain('and "audit_logs"."region_id" = $2');
      expect(q.parameters, op).toEqual([A, A]);
    }
    const or = await inRegion((db) =>
      db
        .selectFrom("audit_logs")
        .selectAll()
        .where((eb) => eb.or([eb("audit_logs.region_id", "=", A), eb("action", "=", "x")]))
        .execute(),
    );
    expect(or.sql).toMatch(/\) and "audit_logs"\."region_id" = \$3$/);
    const join = await inRegion((db) =>
      db
        .selectFrom("regions")
        .innerJoin("audit_logs as a", (j) =>
          j.onRef("a.region_id", "=", "regions.id").on("a.region_id", "<>", A),
        )
        .selectAll()
        .execute(),
    );
    expect(join.sql).toContain('and "a"."region_id" = $2');
  });

  it("сырой источник с tenant-таблицей во FROM/JOIN — ошибка", async () => {
    const { db, queries } = recordingDb({ defaultTenant: inA });
    await expect(
      db
        .selectFrom(sql`audit_logs`.as("a"))
        .selectAll()
        .execute(),
    ).rejects.toThrow(/Сырой SQL-источник/);
    await expect(
      db
        .selectFrom("regions")
        .innerJoin(sql`(select * from analytics_events)`.as("e"), (j) => j.onTrue())
        .selectAll()
        .execute(),
    ).rejects.toThrow(/Сырой SQL-источник/);
    expect(queries).toEqual([]);
    const rawSources = [
      () => db.selectFrom(sql.id("audit_logs").as("a")).selectAll().execute(),
      () => db.selectFrom(sql.id("public", "audit_logs").as("a")).selectAll().execute(),
      () =>
        db
          .selectFrom(sql`${sql.id("audit_logs")}`.as("a"))
          .selectAll()
          .execute(),
      () => db.selectFrom(sql.ref("audit_logs").as("a")).selectAll().execute(),
      () => db.selectFrom(sql.table("audit_logs").as("a")).selectAll().execute(),
      () =>
        db
          .selectFrom("regions")
          .innerJoin(sql.id("analytics_events").as("e"), (j) => j.onTrue())
          .selectAll()
          .execute(),
    ];
    for (const run of rawSources) await expect((async () => run())()).rejects.toThrow(/Сырой SQL-источник/);
    expect(queries).toEqual([]);
    // Сырой источник без tenant-таблиц допустим.
    await db
      .selectFrom(sql`(select 1 as x)`.as("t"))
      .selectAll()
      .execute();
    expect(queries).toHaveLength(1);
  });

  it("RIGHT/FULL JOIN tenant-таблицы — ошибка (фильтр в ON не ограничил бы её строки)", async () => {
    const { db } = recordingDb({ defaultTenant: inA });
    await expect(
      db
        .selectFrom("regions")
        .rightJoin("audit_logs", "audit_logs.region_id", "regions.id")
        .selectAll()
        .execute(),
    ).rejects.toBeInstanceOf(TenantContextError);
  });

  it("UPDATE и DELETE: фильтр в WHERE; изменить region_id нельзя", async () => {
    const upd = await inRegion((db) =>
      db.updateTable("analytics_events").set({ pseudonymous_user_id: null }).where("id", "=", "x").execute(),
    );
    expect(upd.sql).toBe(
      'update "analytics_events" set "pseudonymous_user_id" = $1 where ("id" = $2) and "analytics_events"."region_id" = $3',
    );
    const del = await inRegion((db) => db.deleteFrom("audit_logs").execute());
    expect(del.sql).toBe('delete from "audit_logs" where "audit_logs"."region_id" = $1');
    expect(del.parameters).toEqual([A]);

    const { db } = recordingDb({ defaultTenant: inA });
    await expect(
      db
        .updateTable("audit_logs")
        .set({ region_id: B } as never)
        .execute(),
    ).rejects.toThrow(/неизменяем/);
  });

  it("INSERT: region_id подставляется из контекста; свой регион допустим; чужой или NULL — ошибка", async () => {
    const event = { event_name: "e", schema_version: 1, occurred_at: "2026-11-01T00:00:00Z" };
    const auto = await inRegion((db) => db.insertInto("analytics_events").values([event, event]).execute());
    expect(auto.sql).toBe(
      'insert into "analytics_events" ("event_name", "schema_version", "occurred_at", "region_id") values ($1, $2, $3, $4), ($5, $6, $7, $8)',
    );
    expect(auto.parameters.filter((p) => p === A)).toHaveLength(2);

    const own = await inRegion((db) =>
      db
        .insertInto("analytics_events")
        .values({ ...event, region_id: A.toUpperCase() })
        .execute(),
    );
    expect(own.sql).toContain('"region_id"');

    const { db, queries } = recordingDb({ defaultTenant: inA });
    for (const region_id of [B, null])
      await expect(
        db
          .insertInto("analytics_events")
          .values({ ...event, region_id })
          .execute(),
      ).rejects.toThrow(/не совпадает с регионом/);
    await expect(
      db.insertInto("audit_logs").expression(db.selectFrom("audit_logs").selectAll()).execute(),
    ).rejects.toThrow(/INSERT … SELECT/);
    expect(queries).toEqual([]);
  });

  it("ON CONFLICT DO UPDATE: только строка своего региона, region_id менять нельзя", async () => {
    const entry = { actor_type: "system" as const, action: "a", entity_type: "t", id: "x" };
    const q = await inRegion((db) =>
      db
        .insertInto("audit_logs")
        .values(entry)
        .onConflict((oc) => oc.column("id").doUpdateSet({ reason: "r" } as never))
        .execute(),
    );
    expect(q.sql).toBe(
      'insert into "audit_logs" ("actor_type", "action", "entity_type", "id", "region_id") values ($1, $2, $3, $4, $5)' +
        ' on conflict ("id") do update set "reason" = $6 where "audit_logs"."region_id" = $7',
    );
    expect(q.parameters.at(-1)).toBe(A);
    const withWhere = await inRegion((db) =>
      db
        .insertInto("audit_logs")
        .values(entry)
        .onConflict((oc) =>
          oc
            .column("id")
            .doUpdateSet({ reason: "r" } as never)
            .where("action", "=", "a"),
        )
        .execute(),
    );
    expect(withWhere.sql).toMatch(/where \("action" = \$7\) and "audit_logs"\."region_id" = \$8$/);
    const nothing = await inRegion((db) =>
      db
        .insertInto("audit_logs")
        .values(entry)
        .onConflict((oc) => oc.column("id").doNothing())
        .execute(),
    );
    expect(nothing.sql).toMatch(/on conflict \("id"\) do nothing$/);

    const { db } = recordingDb({ defaultTenant: inA });
    await expect(
      db
        .insertInto("audit_logs")
        .values(entry)
        .onConflict((oc) => oc.column("id").doUpdateSet({ region_id: B } as never))
        .execute(),
    ).rejects.toThrow(/неизменяем/);
  });

  it("сырой SQL с tenant-таблицей в контексте не меняется — его фильтрует RLS", async () => {
    const q = await inRegion((db) => sql`SELECT count(*) FROM audit_logs`.execute(db));
    expect(q.sql).toBe("SELECT count(*) FROM audit_logs");
  });
});

describe("TenantGuardPlugin: SYSTEM и PLATFORM", () => {
  it("кросс-tenant: запросы не меняются", async () => {
    for (const ctx of [SYSTEM_CONTEXT, PLATFORM_CONTEXT]) {
      const { db, queries } = recordingDb({ defaultTenant: ctx });
      await db.selectFrom("audit_logs").selectAll().execute();
      await db
        .insertInto("audit_logs")
        .values({ actor_type: "system", action: "a", entity_type: "t" })
        .execute();
      expect(queries.map((q) => q.sql)).toEqual([
        'select * from "audit_logs"',
        'insert into "audit_logs" ("actor_type", "action", "entity_type") values ($1, $2, $3)',
      ]);
    }
  });

  it("свои tenant-таблицы через опцию tables", async () => {
    const { db, queries } = recordingDb({
      tables: { ...TABLE_TENANCY, places: "tenant" },
      defaultTenant: inA,
    });
    await sql`select 1`.execute(db);
    await db
      .withTables<{ places: { id: string; region_id: string } }>()
      .selectFrom("places")
      .selectAll()
      .execute();
    expect(queries.at(-1)?.sql).toBe('select * from "places" where "places"."region_id" = $1');
  });
});

describe("withTenant", () => {
  it("первой командой транзакции выставляет переменные RLS; контекст виден только внутри", async () => {
    const { db, queries } = recordingDb();
    const seen = await withTenant(db, inA, async (trx) => {
      await trx.selectFrom("audit_logs").select("id").execute();
      return currentTenant();
    });
    expect(seen).toEqual(inA);
    expect(currentTenant()).toBeUndefined();
    expect(queries[0]?.sql).toBe(
      "SELECT set_config('app.region_id', $1, true), set_config('app.actor', $2, true)",
    );
    expect(queries[0]?.parameters).toEqual([A, ""]);
    expect(queries[1]?.sql).toBe('select "id" from "audit_logs" where "audit_logs"."region_id" = $1');

    await withTenant(db, SYSTEM_CONTEXT, async () => undefined);
    expect(queries.at(-1)?.parameters).toEqual(["", "system"]);
    await withTenant(db, PLATFORM_CONTEXT, async () => undefined);
    expect(queries.at(-1)?.parameters).toEqual(["", "platform"]);
  });

  it("репозиторий с @InjectDb внутри withTenant: currentDb(db) — транзакция запроса с фильтром", async () => {
    const { db, queries } = recordingDb();
    await withTenant(db, inA, () => currentDb(db).selectFrom("audit_logs").select("id").execute());
    expect(queries.at(-1)?.parameters).toEqual([A]);
  });

  it("вложенный вызов: тот же контекст — та же транзакция, другой — ошибка", async () => {
    const { db } = recordingDb();
    await withTenant(db, inA, async (outer) => {
      await withTenant(db, regionContext(A.toUpperCase()), async (inner) => expect(inner).toBe(outer));
      await expect(withTenant(db, regionContext(B), async () => 1)).rejects.toBeInstanceOf(
        TenantContextError,
      );
      await expect(withTenant(db, SYSTEM_CONTEXT, async () => 1)).rejects.toBeInstanceOf(TenantContextError);
    });
  });

  it("db.transaction() на корневом db внутри withTenant — ошибка (второе соединение без RLS-контекста)", async () => {
    const { db } = recordingDb();
    await withTenant(db, inA, async (trx) => {
      const attempts = [
        () => db.transaction().execute(async () => 1),
        () => db.startTransaction().execute(),
        () => db.selectFrom("regions").selectAll().execute(),
        () => db.withSchema("public").selectFrom("regions").selectAll().execute(),
        () => db.withTables<{ x: { id: string } }>().selectFrom("x").selectAll().execute(),
        () => db.withoutPlugins().selectFrom("regions").selectAll().execute(),
        () => db.connection().execute(async (c) => c.selectFrom("regions").selectAll().execute()),
      ];
      for (const run of attempts) await expect(run()).rejects.toThrow(/currentDb/);
      // Транзакция запроса — через trx/currentDb.
      await trx.selectFrom("regions").selectAll().execute();
      await currentDb(db).withSchema("public").selectFrom("regions").selectAll().execute();
    });
    // Вне withTenant — как обычно.
    await db.transaction().execute(async () => undefined);
  });

  it("region_id контекста — только uuid", async () => {
    expect(() => regionContext("A' OR 1=1 --")).toThrow(TenantContextError);
    const { db, queries } = recordingDb();
    await expect(withTenant(db, { kind: "region", regionId: "nope" }, async () => 1)).rejects.toThrow(
      /не uuid/,
    );
    expect(queries).toEqual([]);
  });
});
