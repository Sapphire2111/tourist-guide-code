// T1-23: seed на реальной PostgreSQL — идемпотентность, два tenant, аудит назначений, объём. README apps/api, «Seed».
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/index.js";
import { seedBase, seedVolume, SEED_REGIONS, SEED_USERS } from "../../src/seed/seed.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

describe.skipIf(!dockerAvailable)(`Seed (T1-23)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let db: Db;

  const count = async (table: string, where = ""): Promise<number> =>
    Number((await tdb!.client.query(`SELECT count(*) AS n FROM ${table} ${where}`)).rows[0]!.n);

  beforeAll(async () => {
    tdb = await startDatabase();
    // Владелец контейнера — суперпользователь; withTenant(SYSTEM) выставляет контекст, как в CLI.
    db = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
  });

  afterAll(async () => {
    await db?.destroy();
    await stopDatabase(tdb);
  });

  it("создаёт два региона, пользователей и назначения; повторный запуск ничего не дублирует", async () => {
    const first = await seedBase(db);
    expect(first.assignmentsCreated).toBe(SEED_USERS.reduce((n, u) => n + u.assignments.length, 0));
    await seedVolume(db, first.regions, { users: 25, events: 40 });

    const snapshot = async () => ({
      regions: await count("regions"),
      users: await count("users"),
      assignments: await count("role_assignments"),
      audit: await count("audit_logs", "WHERE action = 'role.assign'"),
      events: await count("analytics_events"),
    });
    const before = await snapshot();
    expect(before).toEqual({
      regions: SEED_REGIONS.length,
      users: SEED_USERS.length + 25,
      assignments: first.assignmentsCreated,
      audit: first.assignmentsCreated,
      events: 40,
    });

    const second = await seedBase(db);
    await seedVolume(db, second.regions, { users: 25, events: 40 });
    expect(second.assignmentsCreated).toBe(0);
    expect(second.regions).toEqual(first.regions);
    expect(second.users).toEqual(first.users);
    expect(await snapshot()).toEqual(before);
  });

  it("регион-админы привязаны каждый к своему региону, суперпользователь — к PLATFORM", async () => {
    const { regions, users } = await seedBase(db);
    const rows = (
      await tdb!.client.query(
        "SELECT user_id, role, scope_type, scope_id, region_id FROM role_assignments WHERE revoked_at IS NULL",
      )
    ).rows;
    const of = (user: string) => rows.filter((r) => r.user_id === user);
    expect(of(users["admin-a"])).toEqual([
      expect.objectContaining({ role: "TECH_REGION_ADMIN", scope_type: "REGION", region_id: regions.a }),
    ]);
    expect(of(users["admin-b"])).toEqual([
      expect.objectContaining({ scope_type: "REGION", region_id: regions.b }),
    ]);
    expect(of(users.superuser)).toEqual([
      expect.objectContaining({ role: "TECH_SUPERUSER", scope_type: "PLATFORM", region_id: null }),
    ]);
  });

  it("достраивает объём при увеличении и не дублирует при повторе", async () => {
    const { regions } = await seedBase(db);
    // Независимо от порядка тестов: считаем относительно значений до запуска; предыдущие тесты могли уже
    // вставить часть volume-записей (они детерминированы по номеру и пересекаются).
    const eventsBefore = await count("analytics_events");
    const usersBefore = await count("users");
    const eventsTarget = 120;
    const usersTarget = 70;
    await seedVolume(db, regions, { users: usersTarget, events: eventsTarget });
    const eventsAfter = await count("analytics_events");
    const usersAfter = await count("users");
    expect(eventsAfter - eventsBefore).toBeLessThanOrEqual(eventsTarget);
    expect(usersAfter - usersBefore).toBeLessThanOrEqual(usersTarget);
    // Событий с номерами 0..eventsTarget-1 ровно eventsTarget (по id), сколько бы их ни было до запуска.
    expect(await count("analytics_events", "WHERE properties->>'synthetic' = 'true'")).toBe(eventsAfter);
    expect(eventsAfter).toBe(eventsTarget);
    await seedVolume(db, regions, { users: usersTarget, events: eventsTarget });
    expect(await count("analytics_events")).toBe(eventsAfter);
    expect(await count("users")).toBe(usersAfter);
    // События делятся поровну между регионами A, B и «гостем» (NULL).
    expect(await count("analytics_events", "WHERE region_id IS NULL")).toBe(eventsTarget / 3);
    expect(await count("analytics_events", `WHERE region_id = '${regions.a}'`)).toBe(eventsTarget / 3);
  });
});
