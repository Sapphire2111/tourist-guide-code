// Блок 7 (бронирования) на реальной PostgreSQL 17 под ролью приложения: миграция 0022 (RLS, права, btree_gist),
// ресурс и правила партнёра, слоты, две параллельные брони на один слот → ровно одна (ограничение исключения БД, 409),
// ручная запись блокирует слот, «Доступно зараз» только при реальном слоте или неистёкшем ручном статусе, телефон
// партнёру только при согласии (и не кассиру), expired по SLA функцией воркера, альтернатива освобождает исходный
// слот, no_show и счётчик, completed без проводок ledger. Без Docker — пропуск (CI).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/index.js";
import type { AnalyticsService } from "../../src/modules/analytics/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../../src/modules/audit/index.js";
import {
  BookingsRepository,
  BookingsService,
  type BookingAuditMeta,
  type CreateBookingDto,
} from "../../src/modules/bookings/index.js";
import { NotificationsService } from "../../src/modules/host/index.js";
import {
  dbScopeParentLoaders,
  RbacService,
  RoleAssignmentsRepository,
  ScopeHierarchy,
} from "../../src/modules/rbac/index.js";
import { RegionsRepository } from "../../src/modules/regions/index.js";
import { seedUuid } from "../../src/seed/ids.js";
import { seedCatalog } from "../../src/seed/seed-catalog.js";
import { seedBase, type SeedBaseResult } from "../../src/seed/seed.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const APP_LOGIN = "tg_api_bookings_test";
const APP_PASSWORD = "tg_api_bookings_test";

const OWNER = seedUuid("bookings-test:user:owner");
const STAFF = seedUuid("bookings-test:user:staff");
const STRANGER = seedUuid("bookings-test:user:stranger");
const TOURISTS = Array.from({ length: 24 }, (_, i) => seedUuid(`bookings-test:user:tourist-${i}`));
const ORG = seedUuid("bookings-test:org");

const meta = (userId: string): BookingAuditMeta => ({
  actor: { type: "user", userId },
  roleAssignmentId: null,
  requestId: "it-bookings",
});

/** Код ошибки и причина (ApiError: getStatus, code, details). */
async function failure(p: Promise<unknown>): Promise<{ status: number; code: string; reason?: unknown }> {
  const e = (await p.then(
    () => undefined,
    (err: unknown) => err,
  )) as { getStatus?: () => number; code?: string; details?: { reason?: unknown } } | undefined;
  if (!e?.getStatus) throw new Error(`Ожидалась ApiError, получено: ${String(e)}`);
  return { status: e.getStatus(), code: e.code ?? "", reason: e.details?.reason };
}

describe.skipIf(!dockerAvailable)(`Бронирования (блок 7, миграция 0022)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let appClient: pg.Client;
  let base: SeedBaseResult;
  let bookings: BookingsService;
  const events: { event: string; props: Record<string, unknown> }[] = [];
  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);

  let regionId = "";
  let placeId = "";
  let resourceId = "";
  let tourist = 0;
  /** Следующий турист (у каждого — свой лимит неподтверждённых броней). */
  const nextTourist = () => TOURISTS[tourist++]!;

  const bookingInput = (startsAt: string, extra: Partial<CreateBookingDto> = {}): CreateBookingDto => ({
    regionId,
    resourceId,
    startsAt,
    peopleCount: 2,
    phone: "+380501234567",
    phoneSource: "manual",
    phoneShareConsent: true,
    ...extra,
  });

  /** Свободные слоты ресурса с завтрашнего дня (местная дата). */
  const freeSlots = async (id = resourceId) => {
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
    const list = await bookings.slots(regionId, id, { from: tomorrow, days: 2 });
    return list.items.filter((s) => s.free).map((s) => s.startsAt);
  };

  beforeAll(async () => {
    tdb = await startDatabase();
    await sql(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    regionId = base.regions.a;
    let tg = 990000000700;
    for (const id of [OWNER, STAFF, STRANGER, ...TOURISTS]) {
      tg += 1;
      await sql(`INSERT INTO users (id, status, language, display_name) VALUES ($1, 'active', 'uk', $2)`, [
        id,
        `Користувач ${tg}`,
      ]);
      await sql(
        `INSERT INTO telegram_accounts (user_id, telegram_user_id, first_name, last_auth_date)
         VALUES ($1, $2, 'Тест', now())`,
        [id, tg],
      );
    }
    // Организация и опубликованное место демо-каталога региона A — заведение партнёра.
    await sql(
      `INSERT INTO organizations (id, region_id, name, created_by) VALUES ($1, $2, 'Чани Ворохти', $3)`,
      [ORG, regionId, OWNER],
    );
    const place = await sql(
      `SELECT id FROM places WHERE region_id = $1 AND status = 'published' ORDER BY id LIMIT 1`,
      [regionId],
    );
    placeId = place.rows[0].id as string;
    await sql(`UPDATE places SET organization_id = $1 WHERE id = $2`, [ORG, placeId]);
    for (const [user, role] of [
      [OWNER, "ORG_OWNER"],
      [STAFF, "ORG_STAFF"],
    ] as const)
      await sql(
        `INSERT INTO role_assignments (user_id, role, scope_type, scope_id, region_id)
         VALUES ($1, $2, 'ORGANIZATION', $3, $4)`,
        [user, role, ORG, regionId],
      );
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 6 });
    appClient = new pg.Client({ connectionString: url.toString() });
    await appClient.connect();
    const hierarchy = new ScopeHierarchy(dbScopeParentLoaders(appDb));
    const audit = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);
    const rbac = new RbacService(new RoleAssignmentsRepository(appDb), hierarchy);
    const notifications = new NotificationsService(appDb, { send: () => Promise.resolve() });
    const analytics = {
      emit: (e: { event: string; props: Record<string, unknown> }) => {
        events.push({ event: e.event, props: e.props });
        return Promise.resolve();
      },
    } as unknown as AnalyticsService;
    bookings = new BookingsService(
      appDb,
      new BookingsRepository(appDb),
      new RegionsRepository(appDb),
      rbac,
      audit,
      notifications,
      analytics,
    );
  }, 180_000);

  afterAll(async () => {
    await appClient?.end();
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  it("миграция 0022: RLS на новых tenant-таблицах, история — только дописывается, btree_gist", async () => {
    expect(tdb!.applied).toContain("0022_bookings.sql");
    const tables = [
      "resources",
      "availability_rules",
      "partner_phone_consents",
      "bookings",
      "booking_events",
    ];
    const { rows } = await sql(
      `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity`,
      [tables],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
    const privs = await sql(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'app' AND table_name = 'booking_events' ORDER BY 1`,
    );
    expect(privs.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
    expect((await sql(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`)).rowCount).toBe(1);
  });

  it("ресурс и правила: владелец создаёт, кассир — 403; слоты из правил", async () => {
    const denied = await failure(
      bookings.createResource(STAFF, { placeId, name: { uk: "Чан" } }, meta(STAFF)),
    );
    expect(denied).toMatchObject({ status: 403 });
    const created = await bookings.createResource(
      OWNER,
      { placeId, name: { uk: "Чан на 6 осіб" }, capacityPeople: 6, slotDurationMin: 60, leadTimeMin: 0 },
      meta(OWNER),
    );
    resourceId = created.id;
    expect(created).toMatchObject({ organizationId: ORG, status: "active", capacityPeople: 6 });
    const bad = await failure(
      bookings.putAvailability(
        OWNER,
        resourceId,
        {
          rules: [
            { dayOfWeek: 1, opensAt: "10:00", closesAt: "14:00" },
            { dayOfWeek: 1, opensAt: "13:00", closesAt: "15:00" },
          ],
        },
        meta(OWNER),
      ),
    );
    expect(bad).toMatchObject({ status: 422, reason: "rules_invalid" });
    const withRules = await bookings.putAvailability(
      OWNER,
      resourceId,
      { rules: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "00:00", closesAt: "24:00" })) },
      meta(OWNER),
    );
    expect(withRules.rules).toHaveLength(7);
    expect((await freeSlots()).length).toBeGreaterThanOrEqual(24);
    const audit = await sql(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at`, [
      resourceId,
    ]);
    expect(audit.rows.map((r) => r.action)).toEqual(["resource.create", "availability.update"]);
  });

  it("2 параллельные брони на один слот → ровно одна успешна, вторая 409 slotTaken (ограничение БД)", async () => {
    const [slot] = await freeSlots();
    const results = await Promise.allSettled([
      bookings.create(nextTourist(), bookingInput(slot!)),
      bookings.create(nextTourist(), bookingInput(slot!)),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const err = (failed[0] as PromiseRejectedResult).reason as {
      getStatus: () => number;
      details?: { reason?: string };
    };
    expect(err.getStatus()).toBe(409);
    expect(err.details?.reason).toBe("slot_taken");
    const booking = (ok[0] as PromiseFulfilledResult<{ id: string; status: string }>).value;
    // C-14: new — технический, сразу pending_partner со сроком ответа партнёра.
    expect(booking.status).toBe("pending_partner");
    const history = await sql(
      `SELECT from_status, to_status, actor_type FROM booking_events WHERE booking_id = $1 ORDER BY created_at, id`,
      [booking.id],
    );
    expect(history.rows).toEqual([
      { from_status: null, to_status: "new", actor_type: "user" },
      { from_status: "new", to_status: "pending_partner", actor_type: "system" },
    ]);
    expect(await freeSlots()).not.toContain(slot);
    expect(events.some((e) => e.event === "booking_created" && e.props.bookingId === booking.id)).toBe(true);
  });

  it("телефон: без согласия — 422; партнёру — только при действующем согласии и не кассиру", async () => {
    const [slot] = await freeSlots();
    const user = nextTourist();
    const noConsent = await failure(bookings.create(user, bookingInput(slot!, { phoneShareConsent: false })));
    expect(noConsent).toMatchObject({ status: 422, reason: "phone_consent_required" });
    const off = await failure(
      bookings.create(user, bookingInput(new Date(Date.parse(slot!) + 60_000).toISOString())),
    );
    expect(off).toMatchObject({ status: 422, reason: "slot_unavailable" });
    const b = await bookings.create(user, bookingInput(slot!, { phone: "+380671112233" }));
    const consent = await sql(
      `SELECT c.organization_id, c.place_id, c.user_id FROM bookings b JOIN partner_phone_consents c
       ON c.id = b.phone_consent_id WHERE b.id = $1`,
      [b.id],
    );
    expect(consent.rows[0]).toEqual({ organization_id: ORG, place_id: placeId, user_id: user });
    const ofOwner = (await bookings.partnerList(OWNER, {})).items.find((x) => x.id === b.id)!;
    expect(ofOwner.contactPhone).toBe("+380671112233");
    const ofStaff = (await bookings.partnerList(STAFF, {})).items.find((x) => x.id === b.id)!;
    expect(ofStaff.contactPhone).toBeNull();
    expect(ofStaff.allowedTransitions).toEqual(["confirmed"]);
    await sql(
      `UPDATE partner_phone_consents SET withdrawn_at = now() WHERE id = (
      SELECT phone_consent_id FROM bookings WHERE id = $1)`,
      [b.id],
    );
    const withdrawn = (await bookings.partnerList(OWNER, {})).items.find((x) => x.id === b.id)!;
    expect(withdrawn.contactPhone).toBeNull();
    // Чужой пользователь без назначений — 403; чужая бронь — 404.
    expect(await failure(bookings.partnerList(STRANGER, {}))).toMatchObject({ status: 403 });
    expect(
      await failure(bookings.updateStatus(STRANGER, b.id, { regionId, status: "confirmed" }, meta(STRANGER))),
    ).toMatchObject({ status: 404 });
  });

  it("ручная запись блокирует слот для онлайн-брони; на удержанный слот ручная — 409", async () => {
    const [a, b] = await freeSlots();
    const manual = await bookings.createManual(
      STAFF,
      { resourceId, startsAt: a!, peopleCount: 3, customerName: "Іван (дзвінок)", source: "phone" },
      meta(STAFF),
    );
    expect(manual).toMatchObject({ status: "confirmed", source: "phone", customerName: "Іван (дзвінок)" });
    expect(await failure(bookings.create(nextTourist(), bookingInput(a!)))).toMatchObject({
      status: 409,
      reason: "slot_taken",
    });
    await bookings.create(nextTourist(), bookingInput(b!));
    expect(
      await failure(
        bookings.createManual(
          OWNER,
          { resourceId, startsAt: b!, peopleCount: 1, customerName: "Петро" },
          meta(OWNER),
        ),
      ),
    ).toMatchObject({ status: 409, reason: "slot_taken" });
  });

  it("«Доступно зараз»: реальный свободный слот или ручной статус с неистёкшим TTL; иначе — нет", async () => {
    const list = await bookings.listResources(regionId, placeId);
    expect(list.items.find((r) => r.id === resourceId)!.availability).toMatchObject({
      availableNow: true,
      source: "slot",
    });
    const noRules = await bookings.createResource(OWNER, { placeId, name: { uk: "Сауна" } }, meta(OWNER));
    const plain = (await bookings.listResources(regionId, placeId)).items.find((r) => r.id === noRules.id)!;
    expect(plain.availability).toMatchObject({ availableNow: false, source: null });
    const manual = await bookings.putManualAvailability(
      STAFF,
      noRules.id,
      { status: "available_now", ttlMinutes: 15 },
      meta(STAFF),
    );
    expect(manual.availability).toMatchObject({ availableNow: true, source: "manual" });
    await sql(
      `UPDATE resources SET manual_availability_expires_at = now() - interval '1 minute',
         manual_availability_set_at = now() - interval '20 minutes' WHERE id = $1`,
      [noRules.id],
    );
    const expired = (await bookings.listResources(regionId, placeId)).items.find((r) => r.id === noRules.id)!;
    expect(expired.availability.availableNow).toBe(false);
    const journal = await sql(`SELECT action FROM audit_logs WHERE entity_id = $1 AND action = $2`, [
      noRules.id,
      "availability.status.manual",
    ]);
    expect(journal.rowCount).toBe(1);
  });

  it("SLA партнёра истёк → expired функцией воркера, слот освобождён, событие booking_expired", async () => {
    const [slot] = await freeSlots();
    const b = await bookings.create(nextTourist(), bookingInput(slot!));
    await sql(`UPDATE bookings SET partner_response_due_at = now() - interval '1 minute' WHERE id = $1`, [
      b.id,
    ]);
    const n = await appClient.query(`SELECT bookings_expire_due(100) AS n`);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
    const row = await sql(`SELECT status, status_reason FROM bookings WHERE id = $1`, [b.id]);
    expect(row.rows[0]).toEqual({ status: "expired", status_reason: "partner_sla" });
    const ev = await sql(
      `SELECT actor_type FROM booking_events WHERE booking_id = $1 AND to_status = 'expired'`,
      [b.id],
    );
    expect(ev.rows).toEqual([{ actor_type: "system" }]);
    const an = await sql(
      `SELECT properties FROM analytics_events WHERE event_name = 'booking_expired' AND properties->>'bookingId' = $1`,
      [b.id],
    );
    expect(an.rows[0].properties).toMatchObject({ reason: "partner_sla", placeId });
    // Слот снова свободен: повтор функции — без эффекта.
    expect(await freeSlots()).toContain(slot);
    expect((await appClient.query(`SELECT bookings_expire_due(100) AS n`)).rows[0].n).toBe(0);
    await bookings.create(nextTourist(), bookingInput(slot!));
  });

  it("альтернатива: исходный слот освобождается, предложенный занят; турист принимает", async () => {
    const [orig, alt] = (await freeSlots()).slice(-2);
    const user = nextTourist();
    const b = await bookings.create(user, bookingInput(orig!));
    // Кассир не предлагает альтернативу и не отказывает (ORG_MANAGER+).
    expect(
      await failure(
        bookings.updateStatus(
          STAFF,
          b.id,
          { regionId, status: "alternative_proposed", alternativeStartsAt: alt! },
          meta(STAFF),
        ),
      ),
    ).toMatchObject({ status: 403 });
    const proposed = await bookings.updateStatus(
      OWNER,
      b.id,
      { regionId, status: "alternative_proposed", alternativeStartsAt: alt! },
      meta(OWNER),
    );
    expect(proposed.status).toBe("alternative_proposed");
    expect(proposed.alternative?.startsAt).toBe(alt);
    const slots = await freeSlots();
    expect(slots).toContain(orig);
    expect(slots).not.toContain(alt);
    const accepted = await bookings.updateStatus(user, b.id, { regionId, status: "confirmed" }, meta(user));
    expect(accepted).toMatchObject({ status: "confirmed", startsAt: alt, alternative: null });
  });

  it("no_show: счётчик клиента; исправление — менеджер; completed → no_show запрещён; completed без ledger", async () => {
    const [slot] = await freeSlots();
    const user = nextTourist();
    const b = await bookings.create(user, bookingInput(slot!));
    await bookings.updateStatus(STAFF, b.id, { regionId, status: "confirmed" }, meta(STAFF));
    const early = await failure(
      bookings.updateStatus(STAFF, b.id, { regionId, status: "no_show" }, meta(STAFF)),
    );
    expect(early).toMatchObject({ status: 422, reason: "not_started" });
    // Бронь «в прошлом»: сдвигаем интервал на 3 ч назад (владельцем БД).
    await sql(
      `UPDATE bookings SET starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours',
         occupied_from = now() - interval '3 hours', occupied_until = now() - interval '2 hours' WHERE id = $1`,
      [b.id],
    );
    await bookings.updateStatus(STAFF, b.id, { regionId, status: "no_show" }, meta(STAFF));
    const count = async () =>
      (await sql(`SELECT booking_no_show_count AS n FROM users WHERE id = $1`, [user])).rows[0].n as number;
    expect(await count()).toBe(1);
    expect(
      await failure(bookings.updateStatus(STAFF, b.id, { regionId, status: "completed" }, meta(STAFF))),
    ).toMatchObject({ status: 403 });
    const ledger = async () => {
      const t = await sql(`SELECT to_regclass('public.ledger_entries') AS t`);
      return t.rows[0].t === null
        ? 0
        : Number((await sql(`SELECT count(*) AS n FROM ledger_entries`)).rows[0].n);
    };
    const before = await ledger();
    const done = await bookings.updateStatus(OWNER, b.id, { regionId, status: "completed" }, meta(OWNER));
    expect(done.status).toBe("completed");
    expect(await count()).toBe(0);
    // D-45 А: completed не создаёт проводок ledger.
    expect(await ledger()).toBe(before);
    const back = await failure(
      bookings.updateStatus(OWNER, b.id, { regionId, status: "no_show" }, meta(OWNER)),
    );
    expect(back).toMatchObject({ status: 409, reason: "invalid_transition" });
    expect(events.some((e) => e.event === "booking_completed" && e.props.bookingId === b.id)).toBe(true);
  });

  it("автозавершение confirmed после окончания (C-27): функция воркера", async () => {
    const [slot] = await freeSlots();
    const b = await bookings.create(nextTourist(), bookingInput(slot!));
    await bookings.updateStatus(OWNER, b.id, { regionId, status: "confirmed" }, meta(OWNER));
    await sql(
      `UPDATE bookings SET starts_at = now() - interval '30 hours', ends_at = now() - interval '29 hours',
         occupied_from = now() - interval '30 hours', occupied_until = now() - interval '29 hours' WHERE id = $1`,
      [b.id],
    );
    const n = await appClient.query(`SELECT bookings_auto_complete(24, 100) AS n`);
    expect(n.rows[0].n).toBe(1);
    expect((await sql(`SELECT status FROM bookings WHERE id = $1`, [b.id])).rows[0].status).toBe("completed");
  });

  /** Сдвиг интервала брони так, чтобы она начиналась через `minutes` (владельцем БД). */
  const shiftTo = (id: string, minutes: number) =>
    sql(
      `UPDATE bookings SET starts_at = now() + make_interval(mins => $2), ends_at = now() + make_interval(mins => $2 + 60),
         occupied_from = now() + make_interval(mins => $2), occupied_until = now() + make_interval(mins => $2 + 60)
       WHERE id = $1`,
      [id, minutes],
    );

  it("отмена туристом: confirmed — не позже чем за 2 ч до начала (422), раньше — можно", async () => {
    const [a, b] = await freeSlots();
    const user = nextTourist();
    const late = await bookings.create(user, bookingInput(a!));
    await bookings.updateStatus(OWNER, late.id, { regionId, status: "confirmed" }, meta(OWNER));
    await shiftTo(late.id, 60);
    expect(
      await failure(
        bookings.updateStatus(user, late.id, { regionId, status: "cancelled_by_user" }, meta(user)),
      ),
    ).toMatchObject({ status: 422, reason: "cancel_too_late" });
    const early = await bookings.create(user, bookingInput(b!));
    await bookings.updateStatus(OWNER, early.id, { regionId, status: "confirmed" }, meta(OWNER));
    const cancelled = await bookings.updateStatus(
      user,
      early.id,
      { regionId, status: "cancelled_by_user" },
      meta(user),
    );
    expect(cancelled.status).toBe("cancelled_by_user");
    expect(await freeSlots()).toContain(b);
  });

  it("подтверждение после срока ответа партнёра — 409, не дожидаясь воркера", async () => {
    const [slot] = await freeSlots();
    const b = await bookings.create(nextTourist(), bookingInput(slot!));
    await sql(`UPDATE bookings SET partner_response_due_at = now() - interval '1 minute' WHERE id = $1`, [
      b.id,
    ]);
    expect(
      await failure(bookings.updateStatus(OWNER, b.id, { regionId, status: "confirmed" }, meta(OWNER))),
    ).toMatchObject({ status: 409, reason: "partner_response_overdue" });
    await appClient.query(`SELECT bookings_expire_due(100)`);
  });

  it("альтернатива: отказ туриста — причина alternative_declined; без ответа — expired customer_timeout", async () => {
    const slots = await freeSlots();
    const [o1, a1, o2, a2] = slots.slice(-4);
    const user = nextTourist();
    const declined = await bookings.create(user, bookingInput(o1!));
    await bookings.updateStatus(
      OWNER,
      declined.id,
      { regionId, status: "alternative_proposed", alternativeStartsAt: a1! },
      meta(OWNER),
    );
    const out = await bookings.updateStatus(
      user,
      declined.id,
      { regionId, status: "cancelled_by_user" },
      meta(user),
    );
    expect(out).toMatchObject({ status: "cancelled_by_user", statusReason: "alternative_declined" });
    expect(await freeSlots()).toEqual(expect.arrayContaining([o1, a1]));

    const silent = await bookings.create(nextTourist(), bookingInput(o2!));
    await bookings.updateStatus(
      OWNER,
      silent.id,
      { regionId, status: "alternative_proposed", alternativeStartsAt: a2! },
      meta(OWNER),
    );
    await sql(`UPDATE bookings SET customer_response_due_at = now() - interval '1 minute' WHERE id = $1`, [
      silent.id,
    ]);
    expect((await appClient.query(`SELECT bookings_expire_due(100) AS n`)).rows[0].n).toBe(1);
    const row = await sql(
      `SELECT status, status_reason, alternative_starts_at, customer_response_due_at FROM bookings WHERE id = $1`,
      [silent.id],
    );
    expect(row.rows[0]).toEqual({
      status: "expired",
      status_reason: "customer_timeout",
      alternative_starts_at: null,
      customer_response_due_at: null,
    });
    expect(await freeSlots()).toEqual(expect.arrayContaining([o2, a2]));
  });

  it("ручная запись: пустое имя и неактивный ресурс — 422; правка ресурса со старой версией — 409", async () => {
    const [slot] = await freeSlots();
    expect(
      await failure(
        bookings.createManual(
          OWNER,
          { resourceId, startsAt: slot!, peopleCount: 1, customerName: "   " },
          meta(OWNER),
        ),
      ),
    ).toMatchObject({ status: 422, reason: "customer_name_blank" });
    const spare = await bookings.createResource(OWNER, { placeId, name: { uk: "Купіль" } }, meta(OWNER));
    const off = await bookings.updateResource(
      OWNER,
      spare.id,
      { status: "inactive", version: spare.version },
      meta(OWNER),
    );
    expect(off).toMatchObject({ status: "inactive", version: spare.version + 1 });
    expect(
      await failure(
        bookings.updateResource(OWNER, spare.id, { capacityPeople: 4, version: spare.version }, meta(OWNER)),
      ),
    ).toMatchObject({ status: 409, reason: "version_conflict" });
    expect(
      await failure(
        bookings.createManual(
          OWNER,
          { resourceId: spare.id, startsAt: slot!, peopleCount: 1, customerName: "Олена" },
          meta(OWNER),
        ),
      ),
    ).toMatchObject({ status: 422, reason: "resource_inactive" });
  });
});
