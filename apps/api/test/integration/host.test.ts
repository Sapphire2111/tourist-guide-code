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
import { writeDrafts } from "../../src/scenarios-gen/writer.js";
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
    const module = await host.guestModule(base.regions.a, HOTEL, entryContextId, GUEST);
    expect(module.room).toEqual({ label: SEED_ROOM_QR.room, source: "qr" });
    expect(module.wifi?.password).not.toBeNull();
    // Чужой контекст (привязан к другому пользователю), контекст другого места и устаревший — без пароля и номера.
    const foreign = await host.guestModule(base.regions.a, HOTEL, entryContextId, OTHER_STAFF);
    expect(foreign).toMatchObject({ room: null, wifi: { password: null } });
    const { rows: oldCtx } = await sql(
      `INSERT INTO entry_contexts (region_id, qr_point_id, place_id, entry_type, source, user_id, created_at)
       SELECT region_id, id, place_id, 'hotel', 'qr', $2, now() - interval '31 days' FROM qr_points WHERE code = $1
       RETURNING id`,
      [SEED_ROOM_QR.code, GUEST],
    );
    const stale = await host.guestModule(base.regions.a, HOTEL, oldCtx[0].id as string, GUEST);
    expect(stale).toMatchObject({ room: null, wifi: { password: null } });
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

  it("срок хранения (D-49): незакрытые старше срока закрываются, все поля ПДн и свободный текст обезличиваются", async () => {
    const staff = seedHotelStaffUserId();
    // Отклонённая с причиной (свободный текст) и незакрытая заявки того же гостя.
    const rejected = await host.createRequest(GUEST, {
      regionId: base.regions.a,
      placeId: HOTEL,
      serviceCode: "breakfast-room",
      roomLabel: "305",
      comment: "Без молока",
    });
    await host.staffUpdate(
      staff,
      rejected.id,
      { status: "rejected", reason: "Кухня зачинена" },
      staffMeta(staff),
    );
    const open = await host.createRequest(GUEST, {
      regionId: base.regions.a,
      placeId: HOTEL,
      serviceCode: "cleaning",
      roomLabel: "306",
    });
    // Дождаться фоновой отправки уведомлений, чтобы она не гонялась с обезличиванием.
    await vi.waitFor(async () => {
      const { rows } = await sql(`SELECT count(*)::int AS n FROM notifications WHERE status = 'pending'`);
      expect(rows[0].n).toBe(0);
    });
    const ids = [requestId, rejected.id, open.id];
    await sql(`UPDATE service_requests SET created_at = now() - interval '91 days' WHERE id = ANY($1)`, [
      ids,
    ]);
    // Под ролью приложения (как worker): у app есть EXECUTE, функция — SECURITY DEFINER в режиме SYSTEM.
    const app = new pg.Client({ connectionString: appUrl });
    await app.connect();
    const { rows } = await app
      .query<{ n: number }>("SELECT service_requests_anonymize_expired(90) AS n")
      .finally(() => app.end());
    expect(rows[0]!.n).toBe(3);
    const { rows: reqs } = await sql(
      `SELECT id, status, status_reason, room_label, room_source, comment, user_id, entry_context_id,
         anonymized_at IS NOT NULL AS anonymized
       FROM service_requests WHERE id = ANY($1)`,
      [ids],
    );
    for (const r of reqs)
      expect(r, r.id).toMatchObject({
        room_label: null,
        room_source: null,
        comment: null,
        user_id: null,
        entry_context_id: null,
        anonymized: true,
      });
    const byId = new Map(reqs.map((r) => [r.id, r]));
    expect(byId.get(requestId)).toMatchObject({ status: "done", status_reason: null });
    expect(byId.get(rejected.id)).toMatchObject({ status: "rejected", status_reason: "—" });
    // Незакрытая — закрыта системой (rejected, expired) с событием истории.
    // Пометка expired сохраняется (по системному событию истории) — для SLA-статистики.
    expect(byId.get(open.id)).toMatchObject({ status: "rejected", status_reason: "expired" });
    // AuditLog не обезличивается: в нём нет свободного текста причины и действий гостя.
    const { rows: audits } = await sql(
      `SELECT reason, new_values FROM audit_logs WHERE entity_type = 'service_request' AND entity_id = ANY($1)`,
      [ids],
    );
    expect(audits.every((a) => a.reason === null && !JSON.stringify(a.new_values).includes("Кухня"))).toBe(
      true,
    );
    const { rows: events } = await sql(
      `SELECT service_request_id, actor_type, actor_user_id, reason, to_status
       FROM service_request_events WHERE service_request_id = ANY($1)`,
      [ids],
    );
    expect(events.filter((e) => e.actor_type === "guest").every((e) => e.actor_user_id === null)).toBe(true);
    expect(events.filter((e) => e.actor_type !== "system").every((e) => e.reason === null)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        service_request_id: open.id,
        actor_type: "system",
        to_status: "rejected",
        reason: "expired",
      }),
    );
    // Уведомления гостю удалены, персоналу — без текста.
    const { rows: notes } = await sql(
      `SELECT recipient_user_id, body FROM notifications WHERE entity_id = ANY($1)`,
      [ids],
    );
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.recipient_user_id !== GUEST && n.body === "—")).toBe(true);
    // Повтор — ничего не меняет.
    const again = new pg.Client({ connectionString: appUrl });
    await again.connect();
    const { rows: second } = await again
      .query<{ n: number }>("SELECT service_requests_anonymize_expired(90) AS n")
      .finally(() => again.end());
    expect(second[0]!.n).toBe(0);
    // Срок меньше 30 дней — ошибка (защита от случайного стирания свежих заявок).
    await expect(sql("SELECT service_requests_anonymize_expired(29)")).rejects.toThrow(/>= 30/);
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

  it("свой план (0019): параметры поездки, варианты из каталога, галочка — пункт в части дня", async () => {
    const plan = await planner.createPlan(GUEST, {
      regionId: base.regions.a,
      days: 2,
      adults: 2,
      children: 1,
      withCar: false,
    });
    expect(plan).toMatchObject({ scenarioId: null, trip: { days: 2, children: 1, withCar: false } });
    expect(plan.plan).toHaveLength(2);
    const option = plan.options[0]!.slots.flatMap((s) => s.options)[0]!;
    expect(option.place.categoryName.uk).toBeTruthy();
    const slot = plan.options[0]!.slots.find((s) => s.options.includes(option))!.slot;
    const added = await planner.updatePlan(GUEST, plan.id, {
      regionId: base.regions.a,
      addItem: { dayNo: 1, slot, placeId: option.place.id },
    });
    expect(added.plan[0]!.items).toEqual([
      expect.objectContaining({ slot, place: expect.objectContaining({ id: option.place.id }) }),
    ]);
    const fewer = await planner.updatePlan(GUEST, plan.id, {
      regionId: base.regions.a,
      days: 1,
      withCar: true,
    });
    expect(fewer.trip).toMatchObject({ days: 1, withCar: true });
    await planner.deletePlan(base.regions.a, GUEST, plan.id);
  });

  it("сезоны (0025): генератор пишет сценарий, турист видит его только в его сезон; повтор — пропуск", async () => {
    const draft = {
      code: "ai-test-summer-1d",
      title: { uk: "Літній день" },
      description: null,
      days: 1,
      tags: ["one_day" as const, "waterfalls" as const],
      seasons: ["summer" as const],
      items: [
        {
          dayNo: 1,
          placeId: OTHER_HOTEL,
          placeName: "—",
          category: "hotels",
          timeHint: "10:00",
          durationMin: 60,
          note: { uk: "Зручне взуття" },
          alternatives: [HOTEL],
        },
      ],
      dayStats: [],
    };
    expect(await writeDrafts(appDb, base.regions.a, [draft], { publish: true })).toMatchObject({
      written: 1,
    });
    expect(await writeDrafts(appDb, base.regions.a, [draft], { publish: true })).toMatchObject({
      written: 0,
      existing: 1,
    });
    const summer = await planner.scenarios(base.regions.a, { season: "summer" });
    expect(summer.items.find((x) => x.code === draft.code)).toMatchObject({
      seasons: ["summer"],
      itemCount: 1,
    });
    const winter = await planner.scenarios(base.regions.a, { season: "winter" });
    expect(winter.items.some((x) => x.code === draft.code)).toBe(false);
    // Демо-сценарии без сезонов — круглый год.
    expect(winter.items.some((x) => x.code === "one-day-yaremche")).toBe(true);
    const admin = await withTenant(appDb, regionContext(base.regions.a), () =>
      planner.adminList({ season: "winter" }),
    );
    expect(admin.items.some((x) => x.code === draft.code)).toBe(false);
    const { rows } = await sql("SELECT status, seasons FROM scenarios WHERE code = $1", [draft.code]);
    expect(rows[0]).toMatchObject({ status: "published", seasons: ["summer"] });
  });
});
