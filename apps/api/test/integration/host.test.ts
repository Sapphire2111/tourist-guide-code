// Блок 5 (ADR-0020) на реальной PostgreSQL 17 под ролью приложения: миграция 0015 (RLS, права), seed (≥5
// опубликованных сценариев, «Про заклад» и сотрудник демо-отеля), заявка гостя с номером из QR номера (D-49),
// уведомление сотруднику (outbox → отправка), полный цикл статусов с историей и AuditLog, 409 на недопустимый
// переход, изоляция: персонал другого отеля не видит и не меняет заявку (scope PLACE), назначение персонала админом
// по Telegram id, обезличивание по сроку хранения, «Мій план» с заменой пункта. Без Docker — пропуск (CI).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createDatabase, regionContext, withTenant, type Db } from "../../src/db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../../src/modules/audit/index.js";
import { HostRepository, HostService, NotificationsService } from "../../src/modules/host/index.js";
import { PlannerRepository, PlannerService } from "../../src/modules/planner/index.js";
import {
  placeParentLoader,
  RbacService,
  RoleAssignmentsRepository,
  ScopeHierarchy,
} from "../../src/modules/rbac/index.js";
import { RegionsRepository } from "../../src/modules/regions/index.js";
import { RoleAssignmentService } from "../../src/modules/role-assignments/index.js";
import { seedCatalog } from "../../src/seed/seed-catalog.js";
import {
  SEED_HOTEL_PLACE_KEY,
  SEED_HOTEL_STAFF,
  SEED_ROOM_QR,
  seedHost,
  seedHotelStaffUserId,
} from "../../src/seed/seed-host.js";
import { seedBase, type SeedBaseResult } from "../../src/seed/seed.js";
import { seedUuid } from "../../src/seed/ids.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const APP_LOGIN = "tg_api_host_test";
const APP_PASSWORD = "tg_api_host_test";

const placeId = (key: string) => seedUuid(`catalog:a:place:${key}`);
const HOTEL = placeId(SEED_HOTEL_PLACE_KEY);
/** Второй «отель» региона A — другое опубликованное место демо-каталога. */
const OTHER_HOTEL = placeId("sadyba-prut");
const GUEST = seedUuid("host-test:user:guest");
const OTHER_STAFF = seedUuid("host-test:user:other-staff");
const NEW_STAFF = seedUuid("host-test:user:new-staff");

describe.skipIf(!dockerAvailable)(`Заявки гостиницы и планировщик (блок 5, миграция 0015)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let appUrl = "";
  let base: SeedBaseResult;
  let host: HostService;
  let planner: PlannerService;
  const sent: { chatId: string; text: string }[] = [];
  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);
  const staffMeta = (userId: string) => ({ actor: { type: "user" as const, userId } });

  beforeAll(async () => {
    tdb = await startDatabase();
    await sql(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    await seedHost(ownerDb, base.regions);
    // Гость, сотрудник другого отеля (ORG_STAFF на OTHER_HOTEL) и пользователь для назначения админом.
    for (const [id, tg] of [
      [GUEST, 990000000201],
      [OTHER_STAFF, 990000000202],
      [NEW_STAFF, 990000000203],
    ] as const) {
      await sql(`INSERT INTO users (id, status, language) VALUES ($1, 'active', 'uk')`, [id]);
      await sql(
        `INSERT INTO telegram_accounts (user_id, telegram_user_id, username, first_name, last_auth_date)
         VALUES ($1, $2, $3, 'Тест', now())`,
        [id, tg, `host_test_${tg}`],
      );
    }
    await sql(
      `INSERT INTO messaging_consents (user_id, purpose, granted, source, granted_at)
       VALUES ($1, 'service', true, 'settings', now())`,
      [GUEST],
    );
    await sql(
      `INSERT INTO role_assignments (user_id, role, scope_type, scope_id, region_id)
       VALUES ($1, 'ORG_STAFF', 'PLACE', $2, $3)`,
      [OTHER_STAFF, OTHER_HOTEL, base.regions.a],
    );
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appUrl = url.toString();
    appDb = createDatabase({ connectionString: appUrl, maxConnections: 4 });
    const hierarchy = new ScopeHierarchy({ PLACE: placeParentLoader(appDb) });
    const audit = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);
    host = new HostService(
      appDb,
      new HostRepository(appDb),
      new RegionsRepository(appDb),
      new RbacService(new RoleAssignmentsRepository(appDb), hierarchy),
      audit,
      new NotificationsService(appDb, {
        send: (chatId, text) => {
          sent.push({ chatId, text });
          return Promise.resolve();
        },
      }),
      new RoleAssignmentService(audit, hierarchy),
    );
    // Понедельник 2026-11-02, 12:00 Киева — часы приёма демо-отеля 08:00–22:00.
    host.now = () => new Date("2026-11-02T10:00:00Z");
    planner = new PlannerService(appDb, new PlannerRepository(appDb), new RegionsRepository(appDb), audit);
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  it("миграция 0015: RLS на новых таблицах, история заявки — только SELECT и INSERT", async () => {
    expect(tdb!.applied).toContain("0015_host_requests_planner.sql");
    const tables = [
      "host_modules",
      "service_requests",
      "service_request_events",
      "notifications",
      "scenarios",
      "scenario_items",
      "user_plans",
    ];
    const { rows } = await sql(
      `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity`,
      [tables],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
    const { rows: grants } = await sql(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'service_request_events' AND grantee = 'app' ORDER BY privilege_type`,
    );
    expect(grants.map((g) => g.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });

  it("seed: ≥5 опубликованных сценариев, «Про заклад» отеля, сотрудник ORG_STAFF; повтор ничего не меняет", async () => {
    const list = await planner.scenarios(base.regions.a, {});
    expect(list.items.length).toBeGreaterThanOrEqual(5);
    expect(list.items.every((s) => s.itemCount > 0)).toBe(true);
    const again = await seedHost(ownerDb, base.regions);
    expect(again).toEqual({ hostModules: 0, scenarios: 0, staffAssigned: false });
    const places = await host.staffPlaces(seedHotelStaffUserId());
    expect(places.items.map((p) => p.placeId)).toEqual([HOTEL]);
  });

  let requestId = "";

  it("заявка с QR номера: комната из контекста (qr), персоналу — уведомление ботом", async () => {
    const { rows } = await sql(
      `INSERT INTO entry_contexts (region_id, qr_point_id, place_id, entry_type, source, user_id)
       SELECT region_id, id, place_id, 'hotel', 'qr', $2 FROM qr_points WHERE code = $1 RETURNING id`,
      [SEED_ROOM_QR.code, GUEST],
    );
    const entryContextId = rows[0].id as string;
    const module = await host.guestModule(base.regions.a, HOTEL, entryContextId);
    expect(module.room).toEqual({ label: SEED_ROOM_QR.room, source: "qr" });
    expect(module.wifi?.password).not.toBeNull();
    const dto = await host.createRequest(GUEST, {
      regionId: base.regions.a,
      placeId: HOTEL,
      serviceCode: "towels",
      entryContextId,
      roomLabel: "999",
      comment: "Дві штуки",
    });
    requestId = dto.id;
    expect(dto).toMatchObject({ status: "new", room: { label: "204", source: "qr" }, outsideHours: false });
    await vi.waitFor(() => expect(sent.some((m) => m.chatId === SEED_HOTEL_STAFF.telegramUserId)).toBe(true));
    await vi.waitFor(async () => {
      const { rows: n } = await sql(`SELECT status FROM notifications WHERE entity_id = $1`, [requestId]);
      expect(n.map((r) => r.status)).toEqual(["sent"]);
    });
    // Повтор той же услуги — 409 со ссылкой на открытую заявку.
    await expect(
      host.createRequest(GUEST, { regionId: base.regions.a, placeId: HOTEL, serviceCode: "towels" }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { existingId: requestId } });
  });

  it("изоляция: персонал другого отеля не видит заявку и не меняет её статус", async () => {
    const other = await host.staffList(OTHER_STAFF, {});
    expect(other.items.map((r) => r.id)).not.toContain(requestId);
    await expect(
      host.staffUpdate(OTHER_STAFF, requestId, { status: "accepted" }, staffMeta(OTHER_STAFF)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const own = await host.staffList(seedHotelStaffUserId(), { status: "new" });
    expect(own.items.map((r) => r.id)).toContain(requestId);
    // Пользователь без назначения персонала — 403.
    await expect(host.staffList(GUEST, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("new → accepted → in_progress → done; недопустимый переход — 409; история и AuditLog каждого перехода", async () => {
    const staff = seedHotelStaffUserId();
    await expect(
      host.staffUpdate(staff, requestId, { status: "done" }, staffMeta(staff)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    for (const status of ["accepted", "in_progress", "done"] as const)
      await host.staffUpdate(staff, requestId, { status }, staffMeta(staff));
    await expect(
      host.staffUpdate(staff, requestId, { status: "accepted" }, staffMeta(staff)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const mine = await host.myRequests(base.regions.a, GUEST);
    const req = mine.items.find((r) => r.id === requestId)!;
    expect(req.status).toBe("done");
    expect(req.history.map((h) => h.toStatus)).toEqual(["new", "accepted", "in_progress", "done"]);
    const { rows } = await sql(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'service_request.status' AND entity_id = $1`,
      [requestId],
    );
    expect(rows[0].n).toBe(3);
    // Гостю (с согласием) — уведомления о смене статуса.
    await vi.waitFor(() => expect(sent.filter((m) => m.chatId === "990000000201").length).toBe(3));
  });

  it("админ назначает сотрудника по Telegram id; новый сотрудник видит заявки отеля; снятие — доступ пропадает", async () => {
    const { rows } = await sql(
      `SELECT id FROM role_assignments WHERE user_id = $1 AND role = 'REGION_ADMIN' AND revoked_at IS NULL`,
      [base.users["region-admin-a"]],
    );
    const meta = {
      actor: { type: "user" as const, userId: base.users["region-admin-a"] },
      roleAssignmentId: rows[0].id as string,
    };
    const member = await withTenant(appDb, regionContext(base.regions.a), () =>
      host.adminAssignStaff(HOTEL, { telegramUserId: "990000000203" }, meta),
    );
    expect(member).toMatchObject({ userId: NEW_STAFF, role: "ORG_STAFF" });
    expect((await host.staffList(NEW_STAFF, {})).items.map((r) => r.id)).toContain(requestId);
    await withTenant(appDb, regionContext(base.regions.a), () =>
      host.adminRevokeStaff(HOTEL, member.assignmentId, meta),
    );
    await expect(host.staffList(NEW_STAFF, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("срок хранения: закрытая заявка старше срока обезличивается функцией БД (D-49)", async () => {
    await sql(`UPDATE service_requests SET closed_at = now() - interval '91 days' WHERE id = $1`, [
      requestId,
    ]);
    // Под ролью приложения (как worker): у app есть EXECUTE, функция сама переходит в режим SYSTEM.
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    const { rows } = await app
      .query<{ n: number }>("SELECT service_requests_anonymize_expired(90) AS n")
      .finally(() => app.end());
    expect(rows[0]!.n).toBe(1);
    const { rows: after } = await sql(
      `SELECT room_label, comment, user_id, anonymized_at IS NOT NULL AS done FROM service_requests WHERE id = $1`,
      [requestId],
    );
    expect(after[0]).toEqual({ room_label: null, comment: null, user_id: null, done: true });
  });

  it("«Мій план»: копия сценария, замена пункта альтернативой, удаление пункта", async () => {
    const list = await planner.scenarios(base.regions.a, { tag: "one_day" });
    const one = list.items.find((s) => s.code === "one-day-yaremche")!;
    const plan = await planner.createPlan(GUEST, { regionId: base.regions.a, scenarioId: one.id });
    const withAlt = plan.plan[0]!.items.find((i) => i.alternatives.length > 0)!;
    const target = withAlt.alternatives[0]!.id;
    const updated = await planner.updatePlan(GUEST, plan.id, {
      regionId: base.regions.a,
      replaceItem: { itemId: withAlt.id, placeId: target },
    });
    const replaced = updated.plan[0]!.items.find((i) => i.id === withAlt.id)!;
    expect(replaced).toMatchObject({ replaced: true, place: { id: target } });
    const removed = await planner.updatePlan(GUEST, plan.id, {
      regionId: base.regions.a,
      removeItemId: withAlt.id,
    });
    expect(removed.plan.flatMap((d) => d.items).some((i) => i.id === withAlt.id)).toBe(false);
    expect((await planner.plans(base.regions.a, GUEST)).items.map((p) => p.id)).toEqual([plan.id]);
    // Чужой план не виден.
    await expect(planner.plan(base.regions.a, OTHER_STAFF, plan.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
