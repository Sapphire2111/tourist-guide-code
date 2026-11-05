// Блок 7 (бронирования) на реальной PostgreSQL 17 под ролью приложения: миграция 0022 (RLS, права, btree_gist),
// ресурс и правила партнёра, слоты, две параллельные брони на один слот → ровно одна (ограничение исключения БД, 409),
// ручная запись блокирует слот, «Доступно зараз» только при реальном слоте или неистёкшем ручном статусе, телефон
// партнёру только при согласии (и не кассиру), expired по SLA функцией воркера, альтернатива освобождает исходный
// слот, no_show и счётчик, completed без проводок ledger. Миграция 0023: уведомления переходов воркера (один раз),
// напоминания (один раз на бронь и вид), отправка outbox воркером, метка причины в payload, флаг по регионам партнёра.
// Без Docker — пропуск (CI).
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
const OWNER2 = seedUuid("bookings-test:user:owner2");
const TOURISTS = Array.from({ length: 40 }, (_, i) => seedUuid(`bookings-test:user:tourist-${i}`));
const ORG = seedUuid("bookings-test:org");
const ORG_B = seedUuid("bookings-test:org-b");
/** Шаблоны outbox, которые отправляет воркер (миграция 0023). */
const WORKER_TEMPLATES = [
  "booking.expired",
  "booking.auto_completed",
  "booking.reminder",
  "booking.partner_reminder",
];

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
  /** Регионы с выключенным флагом module.bookings (заглушка FeatureFlagsService). */
  const flagOff = new Set<string>();
  const flags = {
    isEnabled: (_key: string, region: string | null) => Promise.resolve(!flagOff.has(region ?? "env")),
  };
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
    for (const id of [OWNER, STAFF, STRANGER, OWNER2, ...TOURISTS]) {
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
      await sql(
        `INSERT INTO messaging_consents (user_id, purpose, granted, source, granted_at)
         VALUES ($1, 'service', true, 'settings', now())`,
        [id],
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
    // Владелец организаций в двух регионах (флаг по регионам назначений партнёра).
    await sql(
      `INSERT INTO organizations (id, region_id, name, created_by) VALUES ($1, $2, 'Купелі Буковелю', $3)`,
      [ORG_B, base.regions.b, OWNER2],
    );
    await sql(
      `UPDATE places SET organization_id = $1
       WHERE id = (SELECT id FROM places WHERE region_id = $2 AND status = 'published' ORDER BY id LIMIT 1)`,
      [ORG_B, base.regions.b],
    );
    for (const [org, region] of [
      [ORG, regionId],
      [ORG_B, base.regions.b],
    ] as const)
      await sql(
        `INSERT INTO role_assignments (user_id, role, scope_type, scope_id, region_id)
         VALUES ($1, 'ORG_OWNER', 'ORGANIZATION', $2, $3)`,
        [OWNER2, org, region],
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
      flags,
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
    // Свой ресурс 24/7 без броней: у общего ресурса ближайшие слоты (в горизонте 2 ч) могли занять прошлые тесты —
    // freeSlots берёт «завтра» по UTC, а это ближайшие часы по Києву, если тест запущен вечером.
    const fresh = await bookings.createResource(
      OWNER,
      { placeId, name: { uk: "Чан 24/7" }, capacityPeople: 4, slotDurationMin: 60, leadTimeMin: 0 },
      meta(OWNER),
    );
    await bookings.putAvailability(
      OWNER,
      fresh.id,
      { rules: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "00:00", closesAt: "24:00" })) },
      meta(OWNER),
    );
    const list = await bookings.listResources(regionId, placeId);
    expect(list.items.find((r) => r.id === fresh.id)!.availability).toMatchObject({
      availableNow: true,
      source: "slot",
    });
    // Ресурс без расписания туристу не виден (слотов нет никогда), пока у него нет ручного статуса «Є вільні місця».
    const noRules = await bookings.createResource(OWNER, { placeId, name: { uk: "Сауна" } }, meta(OWNER));
    const hidden = (await bookings.listResources(regionId, placeId)).items.find((r) => r.id === noRules.id);
    expect(hidden).toBeUndefined();
    const manual = await bookings.putManualAvailability(
      STAFF,
      noRules.id,
      { status: "available_now", ttlMinutes: 15 },
      meta(STAFF),
    );
    expect(manual.availability).toMatchObject({ availableNow: true, source: "manual" });
    const shown = (await bookings.listResources(regionId, placeId)).items.find((r) => r.id === noRules.id);
    expect(shown?.availability).toMatchObject({ availableNow: true, source: "manual" });
    await sql(
      `UPDATE resources SET manual_availability_expires_at = now() - interval '1 minute',
         manual_availability_set_at = now() - interval '20 minutes' WHERE id = $1`,
      [noRules.id],
    );
    const expired = (await bookings.listResources(regionId, placeId)).items.find((r) => r.id === noRules.id);
    expect(expired).toBeUndefined();
    // Только выходные на дату — тоже без слотов; появилось открытое окно — ресурс снова в списке.
    await bookings.putAvailability(
      OWNER,
      noRules.id,
      { rules: [{ date: "2099-01-01", closed: true }] },
      meta(OWNER),
    );
    const closedOnly = (await bookings.listResources(regionId, placeId)).items.find(
      (r) => r.id === noRules.id,
    );
    expect(closedOnly).toBeUndefined();
    await bookings.putAvailability(
      OWNER,
      noRules.id,
      { rules: [{ dayOfWeek: 1, opensAt: "10:00", closesAt: "21:00" }] },
      meta(OWNER),
    );
    const plain = (await bookings.listResources(regionId, placeId)).items.find((r) => r.id === noRules.id)!;
    expect(plain.availability).toMatchObject({ availableNow: false, source: null });
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
    const row = await sql(`SELECT status, status_reason, status_reason_code FROM bookings WHERE id = $1`, [
      b.id,
    ]);
    // 0024: служебный код — отдельно от свободного текста.
    expect(row.rows[0]).toEqual({
      status: "expired",
      status_reason: null,
      status_reason_code: "partner_sla",
    });
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

  /**
   * Сдвиг времени брони так, чтобы она начиналась через `minutes` (владельцем БД).
   * Занятость (occupied_*) не трогаем: иначе интервал «сейчас + N» пересечётся
   * с фиксированным слотом того же ресурса (bookings_no_overlap) в зависимости от часа запуска.
   */
  const shiftTo = (id: string, minutes: number) =>
    sql(
      `UPDATE bookings SET starts_at = now() + make_interval(mins => $2), ends_at = now() + make_interval(mins => $2 + 60)
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
    expect(out).toMatchObject({
      status: "cancelled_by_user",
      statusReason: null,
      statusReasonCode: "alternative_declined",
    });
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
      `SELECT status, status_reason, status_reason_code, alternative_starts_at, customer_response_due_at
       FROM bookings WHERE id = $1`,
      [silent.id],
    );
    expect(row.rows[0]).toEqual({
      status: "expired",
      status_reason: null,
      status_reason_code: "customer_timeout",
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

  // --- миграция 0023: уведомления и напоминания воркера, метка причины, флаг по регионам партнёра ---

  const PARTNERS = [OWNER, STAFF, OWNER2].sort();
  const HEAD = /^Бронювання №[0-9a-f]{6} \(.+ — .+, \d\d\.\d\d, \d\d:\d\d\)/;
  const notesOf = async (bookingId: string, template: string) =>
    (
      await sql(
        `SELECT recipient_user_id, body, status FROM notifications
         WHERE entity_id = $1 AND template = $2 ORDER BY recipient_user_id`,
        [bookingId, template],
      )
    ).rows as { recipient_user_id: string; body: string; status: string }[];

  it("0023: expired по SLA — уведомления туристу и партнёрам один раз, метка partner_sla в payload", async () => {
    const [slot] = await freeSlots();
    const user = nextTourist();
    const b = await bookings.create(user, bookingInput(slot!));
    await sql(`UPDATE bookings SET partner_response_due_at = now() - interval '1 minute' WHERE id = $1`, [
      b.id,
    ]);
    await appClient.query(`SELECT bookings_expire_due(100)`);
    await appClient.query(`SELECT bookings_expire_due(100)`);
    const notes = await notesOf(b.id, "booking.expired");
    expect(notes.map((n) => n.recipient_user_id).sort()).toEqual([user, ...PARTNERS].sort());
    const toUser = notes.find((n) => n.recipient_user_id === user)!;
    expect(toUser.body).toMatch(HEAD);
    expect(toUser.body).toContain("заклад не відповів вчасно");
    expect(notes.find((n) => n.recipient_user_id === OWNER)!.body).toContain("минув час на відповідь");
    const ev = await sql(
      `SELECT reason, payload FROM booking_events WHERE booking_id = $1 AND to_status = 'expired'`,
      [b.id],
    );
    expect(ev.rows).toEqual([{ reason: null, payload: { code: "partner_sla" } }]);
    // История для туриста: код отдельно, текста нет.
    const mine = (await bookings.myBookings(regionId, user)).items.find((x) => x.id === b.id)!;
    expect(mine).toMatchObject({ status: "expired", statusReason: null, statusReasonCode: "partner_sla" });
    expect(mine.history.at(-1)).toMatchObject({
      toStatus: "expired",
      reason: null,
      reasonCode: "partner_sla",
    });
  });

  it("0023: customer_timeout — уведомления и метка; отказ от альтернативы с текстом — метка всё равно в payload", async () => {
    const [o1, a1, o2, a2] = (await freeSlots()).slice(-4);
    const silentUser = nextTourist();
    const silent = await bookings.create(silentUser, bookingInput(o1!));
    await bookings.updateStatus(
      OWNER,
      silent.id,
      { regionId, status: "alternative_proposed", alternativeStartsAt: a1! },
      meta(OWNER),
    );
    await sql(`UPDATE bookings SET customer_response_due_at = now() - interval '1 minute' WHERE id = $1`, [
      silent.id,
    ]);
    await appClient.query(`SELECT bookings_expire_due(100)`);
    const notes = await notesOf(silent.id, "booking.expired");
    expect(notes.map((n) => n.recipient_user_id).sort()).toEqual([silentUser, ...PARTNERS].sort());
    expect(notes.find((n) => n.recipient_user_id === silentUser)!.body).toContain(
      "ви не відповіли на запропонований час",
    );
    const ev = await sql(
      `SELECT payload FROM booking_events WHERE booking_id = $1 AND to_status = 'expired'`,
      [silent.id],
    );
    expect(ev.rows[0].payload).toEqual({ code: "customer_timeout" });

    const user = nextTourist();
    const declined = await bookings.create(user, bookingInput(o2!));
    await bookings.updateStatus(
      OWNER,
      declined.id,
      { regionId, status: "alternative_proposed", alternativeStartsAt: a2! },
      meta(OWNER),
    );
    const out = await bookings.updateStatus(
      user,
      declined.id,
      { regionId, status: "cancelled_by_user", reason: "Не підходить час" },
      meta(user),
    );
    expect(out).toMatchObject({ statusReason: "Не підходить час", statusReasonCode: "alternative_declined" });
    const dec = await sql(
      `SELECT reason, payload FROM booking_events WHERE booking_id = $1 AND to_status = 'cancelled_by_user'`,
      [declined.id],
    );
    expect(dec.rows).toEqual([{ reason: "Не підходить час", payload: { code: "alternative_declined" } }]);
    const created = await sql(
      `SELECT reason, payload FROM booking_events WHERE booking_id = $1 AND to_status = 'pending_partner'`,
      [declined.id],
    );
    expect(created.rows[0]).toEqual({ reason: null, payload: { code: "delivered_to_partner" } });
  });

  it("0023: автозавершение — уведомление туристу один раз, метка auto_complete", async () => {
    const [slot] = await freeSlots();
    const user = nextTourist();
    const b = await bookings.create(user, bookingInput(slot!));
    await bookings.updateStatus(OWNER, b.id, { regionId, status: "confirmed" }, meta(OWNER));
    await sql(
      `UPDATE bookings SET starts_at = now() - interval '50 hours', ends_at = now() - interval '49 hours',
         occupied_from = now() - interval '50 hours', occupied_until = now() - interval '49 hours' WHERE id = $1`,
      [b.id],
    );
    await appClient.query(`SELECT bookings_auto_complete(24, 100)`);
    await appClient.query(`SELECT bookings_auto_complete(24, 100)`);
    const notes = await notesOf(b.id, "booking.auto_completed");
    expect(notes.map((n) => n.recipient_user_id)).toEqual([user]);
    expect(notes[0]!.body).toMatch(HEAD);
    const ev = await sql(
      `SELECT reason, payload FROM booking_events WHERE booking_id = $1 AND to_status = 'completed'`,
      [b.id],
    );
    expect(ev.rows[0]).toEqual({ reason: null, payload: { code: "auto_complete" } });
    const row = await sql(`SELECT status_reason, status_reason_code FROM bookings WHERE id = $1`, [b.id]);
    expect(row.rows[0]).toEqual({ status_reason: null, status_reason_code: "auto_complete" });
  });

  it("0023: напоминания — туристу за 24 ч и 2 ч, партнёру перед SLA; один раз; отменённым — нет", async () => {
    // Отдельный ресурс: брони сдвигаются к «сейчас» и не должны пересекаться с бронями других тестов.
    const own = await bookings.createResource(
      OWNER,
      { placeId, name: { uk: "Чан для нагадувань" }, leadTimeMin: 0, capacityPeople: 4 },
      meta(OWNER),
    );
    await bookings.putAvailability(
      OWNER,
      own.id,
      { rules: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "00:00", closesAt: "24:00" })) },
      meta(OWNER),
    );
    const [s1, s2, s3, s4] = await freeSlots(own.id);
    const input = (slot: string) => bookingInput(slot, { resourceId: own.id });
    const soonUser = nextTourist();
    const soon = await bookings.create(soonUser, input(s1!));
    const dayUser = nextTourist();
    const day = await bookings.create(dayUser, input(s2!));
    const goneUser = nextTourist();
    const gone = await bookings.create(goneUser, input(s3!));
    for (const id of [soon.id, day.id, gone.id])
      await bookings.updateStatus(OWNER, id, { regionId, status: "confirmed" }, meta(OWNER));
    await bookings.updateStatus(goneUser, gone.id, { regionId, status: "cancelled_by_user" }, meta(goneUser));
    const move = (id: string, minutes: number) =>
      sql(
        `UPDATE bookings SET starts_at = now() + make_interval(mins => $2),
           ends_at = now() + make_interval(mins => $2 + 60), occupied_from = now() + make_interval(mins => $2),
           occupied_until = now() + make_interval(mins => $2 + 60), confirmed_at = now() - interval '2 days'
         WHERE id = $1`,
        [id, minutes],
      );
    // Партнёру: неподтверждённая, срок ответа через 10 мин (поставлена час назад). Создаётся до сдвигов: сдвинутые
    // брони могли бы занять её слот.
    const pending = await bookings.create(nextTourist(), input(s4!));
    // Сначала все четыре — на 60 дней вперёд (взаимное расположение сохраняется), чтобы сдвиги ниже не задели исходные.
    await sql(
      `UPDATE bookings SET starts_at = starts_at + interval '60 days', ends_at = ends_at + interval '60 days',
         occupied_from = occupied_from + interval '60 days', occupied_until = occupied_until + interval '60 days'
       WHERE id = ANY($1)`,
      [[soon.id, day.id, gone.id, pending.id]],
    );
    await sql(
      `UPDATE bookings SET partner_response_due_at = now() + interval '10 minutes',
         created_at = now() - interval '1 hour', starts_at = now() + interval '5 hours',
         ends_at = now() + interval '6 hours', occupied_from = now() + interval '5 hours',
         occupied_until = now() + interval '6 hours' WHERE id = $1`,
      [pending.id],
    );
    // Сдвиги по одному: сначала освобождаются исходные слоты, сдвинутые интервалы не пересекаются (100, 300, 1200 мин).
    await move(soon.id, 100);
    await move(gone.id, 300);
    await move(day.id, 1200);
    const run = async () =>
      (await appClient.query(`SELECT bookings_send_reminders(ARRAY[1440, 120], 15, 100) AS n`)).rows[0]
        .n as number;
    expect(await run()).toBeGreaterThanOrEqual(3);
    expect(await run()).toBe(0);
    const kinds = await sql(
      `SELECT booking_id, kind FROM booking_reminders WHERE booking_id = ANY($1) ORDER BY kind`,
      [[soon.id, day.id, gone.id, pending.id]],
    );
    expect(kinds.rows).toEqual(
      expect.arrayContaining([
        { booking_id: pending.id, kind: "partner_sla" },
        { booking_id: soon.id, kind: "user_120" },
        { booking_id: day.id, kind: "user_1440" },
      ]),
    );
    expect(kinds.rowCount).toBe(3);
    const soonNotes = await notesOf(soon.id, "booking.reminder");
    expect(soonNotes.map((n) => n.recipient_user_id)).toEqual([soonUser]);
    expect(soonNotes[0]!.body).toMatch(/^Нагадування: Бронювання №/);
    expect((await notesOf(day.id, "booking.reminder")).map((n) => n.recipient_user_id)).toEqual([dayUser]);
    expect(await notesOf(gone.id, "booking.reminder")).toEqual([]);
    const partnerNotes = await notesOf(pending.id, "booking.partner_reminder");
    expect(partnerNotes.map((n) => n.recipient_user_id).sort()).toEqual(PARTNERS);
    expect(partnerNotes[0]!.body).toContain("чекає на підтвердження");
    // Подтверждённая уже внутри окна (только что) — напоминания нет: подтверждение пришло только что.
    await sql(`DELETE FROM booking_reminders WHERE booking_id = $1`, [soon.id]);
    await sql(`UPDATE bookings SET confirmed_at = now() WHERE id = $1`, [soon.id]);
    expect(await run()).toBe(0);

    // Отправка воркером: берёт только свои шаблоны и один раз; итог — notifications_mark_dispatched.
    const claim = async () =>
      (
        await appClient.query(`SELECT id, chat_id, body FROM notifications_claim_pending($1, 1000)`, [
          WORKER_TEMPLATES,
        ])
      ).rows as { id: string; chat_id: string; body: string }[];
    const claimed = await claim();
    const soonNote = claimed.find((c) => c.body === soonNotes[0]!.body)!;
    expect(soonNote.chat_id).toMatch(/^\d+$/);
    expect(await claim()).toEqual([]);
    const mark = (status: string) =>
      appClient.query(`SELECT notifications_mark_dispatched($1, $2, NULL) AS ok`, [soonNote.id, status]);
    expect((await mark("sent")).rows[0].ok).toBe(true);
    expect((await mark("failed")).rows[0].ok).toBe(false);
    expect((await notesOf(soon.id, "booking.reminder"))[0]!.status).toBe("sent");
    // Строки api (booking.status, booking.created) воркер не берёт.
    const foreign = await sql(
      `SELECT count(*)::int AS n FROM notifications WHERE id = ANY($1) AND NOT (template = ANY($2))`,
      [claimed.map((c) => c.id), WORKER_TEMPLATES],
    );
    expect(foreign.rows[0].n).toBe(0);
  });

  // --- миграция 0024: пробелы перед включением флага ---

  it("0024: имя клиента (обрезка), пояс и срок отмены в BookingDto, контекст входа (QR) в брони", async () => {
    const [slot] = await freeSlots();
    const user = nextTourist();
    const ctx = await sql(
      `INSERT INTO entry_contexts (region_id, entry_type, source, user_id) VALUES ($1, 'region', 'qr', $2)
       RETURNING id`,
      [regionId, user],
    );
    const entryContextId = ctx.rows[0].id as string;
    const b = await bookings.create(
      user,
      bookingInput(slot!, { customerName: `  Олена   ${"К".repeat(300)}`, entryContextId }),
    );
    expect(b).toMatchObject({
      timezone: "Europe/Kyiv",
      cancelDeadline: slot,
      cancelTooLate: false,
      cancelBeforeStartHours: 2,
      statusReason: null,
      // Обычный путь (передано закладу) — не причина статуса: код только в истории.
      statusReasonCode: null,
    });
    expect(b.history.at(-1)).toMatchObject({ reason: null, reasonCode: "delivered_to_partner" });
    const row = await sql(`SELECT customer_name, entry_context_id FROM bookings WHERE id = $1`, [b.id]);
    expect(Array.from(row.rows[0].customer_name as string)).toHaveLength(200);
    expect(row.rows[0].customer_name).toMatch(/^Олена К+$/);
    expect(row.rows[0].entry_context_id).toBe(entryContextId);
    const ofOwner = (await bookings.partnerList(OWNER, {})).items.find((x) => x.id === b.id)!;
    expect(ofOwner.customerName).toBe(row.rows[0].customer_name);
    // Подтверждённая: отмена — не позже чем за 2 ч; бронь «через час» — уже поздно.
    const confirmed = await bookings.updateStatus(
      OWNER,
      b.id,
      { regionId, status: "confirmed" },
      meta(OWNER),
    );
    expect(confirmed.cancelDeadline).toBe(new Date(Date.parse(slot!) - 2 * 3600_000).toISOString());
    expect(confirmed.statusReasonCode).toBeNull();
    // Сдвигается только время брони (не занятость): интервал «через час» уже занят бронью другого теста.
    await sql(
      `UPDATE bookings SET starts_at = now() + interval '60 minutes', ends_at = now() + interval '120 minutes'
       WHERE id = $1`,
      [b.id],
    );
    const late = (await bookings.myBookings(regionId, user)).items.find((x) => x.id === b.id)!;
    expect(late).toMatchObject({ cancelTooLate: true, allowedTransitions: ["cancelled_by_user"] });
    // Чужой контекст входа не сохраняется; пустое имя — имя профиля.
    const [other] = await freeSlots();
    const stranger = nextTourist();
    const foreign = await bookings.create(
      stranger,
      bookingInput(other!, { customerName: "   ", entryContextId }),
    );
    const foreignRow = await sql(`SELECT customer_name, entry_context_id FROM bookings WHERE id = $1`, [
      foreign.id,
    ]);
    expect(foreignRow.rows[0]).toEqual({ customer_name: null, entry_context_id: null });
  });

  it("0024: лимит неподтверждённых — параллельные брони одного пользователя не обходят его", async () => {
    const slots = (await freeSlots()).slice(0, 6);
    expect(slots).toHaveLength(6);
    const user = nextTourist();
    const results = await Promise.allSettled(slots.map((s) => bookings.create(user, bookingInput(s))));
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(3);
    for (const r of results.filter((x) => x.status === "rejected"))
      expect((r as PromiseRejectedResult).reason).toMatchObject({ details: { reason: "too_many_pending" } });
    const n = await sql(
      `SELECT count(*)::int AS n FROM bookings WHERE user_id = $1 AND status IN ('new', 'pending_partner')`,
      [user],
    );
    expect(n.rows[0].n).toBe(3);
  });

  it("0024: слоты неопубликованного места — партнёру можно, туристу 404", async () => {
    const draft = await sql(
      `UPDATE places SET organization_id = $1, status = 'draft'
       WHERE id = (SELECT id FROM places WHERE region_id = $2 AND status = 'published' AND id <> $3
                   ORDER BY id LIMIT 1)
       RETURNING id`,
      [ORG, regionId, placeId],
    );
    const draftPlaceId = draft.rows[0].id as string;
    const r = await bookings.createResource(
      OWNER,
      { placeId: draftPlaceId, name: { uk: "Чан у чернетці" }, leadTimeMin: 0 },
      meta(OWNER),
    );
    await bookings.putAvailability(
      OWNER,
      r.id,
      { rules: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: "09:00", closesAt: "18:00" })) },
      meta(OWNER),
    );
    expect(await failure(bookings.slots(regionId, r.id, {}))).toMatchObject({ status: 404 });
    const list = await bookings.partnerSlots(STAFF, r.id, { days: 3 });
    expect(list).toMatchObject({ resourceId: r.id, timezone: "Europe/Kyiv", days: 3 });
    expect(list.items.length).toBeGreaterThan(0);
    expect(await failure(bookings.partnerSlots(STRANGER, r.id, {}))).toMatchObject({ status: 404 });
  });

  it("0024: неизвестный PostgreSQL-пояс региона не роняет истечения — уведомление со временем в UTC", async () => {
    const [slot] = await freeSlots();
    const user = nextTourist();
    const b = await bookings.create(user, bookingInput(slot!));
    await sql(`UPDATE bookings SET partner_response_due_at = now() - interval '1 minute' WHERE id = $1`, [
      b.id,
    ]);
    const tz = (await sql(`SELECT timezone FROM regions WHERE id = $1`, [regionId])).rows[0]
      .timezone as string;
    try {
      await sql(`UPDATE regions SET timezone = 'Mars/Olympus_Mons' WHERE id = $1`, [regionId]);
      expect(
        (await appClient.query(`SELECT bookings_expire_due(100) AS n`)).rows[0].n,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await sql(`UPDATE regions SET timezone = $2 WHERE id = $1`, [regionId, tz]);
    }
    expect((await sql(`SELECT status FROM bookings WHERE id = $1`, [b.id])).rows[0].status).toBe("expired");
    const toUser = (await notesOf(b.id, "booking.expired")).find((n) => n.recipient_user_id === user)!;
    const utc = new Date(slot!).toISOString();
    expect(toUser.body).toContain(`${utc.slice(8, 10)}.${utc.slice(5, 7)}, ${utc.slice(11, 16)})`);
    const safe = await sql(
      `SELECT booking_safe_timezone('Europe/Kyiv') AS kyiv, booking_safe_timezone('Mars/Olympus_Mons') AS bad,
         booking_safe_timezone(NULL) AS none`,
    );
    expect(safe.rows[0]).toEqual({ kyiv: "Europe/Kyiv", bad: "UTC", none: "UTC" });
  });

  it("0024: outbox воркера — взятая и не отмеченная строка повторяется после аренды, затем failed", async () => {
    const [slot] = await freeSlots();
    const user = nextTourist();
    const b = await bookings.create(user, bookingInput(slot!));
    const ins = await sql(
      `INSERT INTO notifications (region_id, recipient_user_id, template, entity_type, entity_id, body)
       VALUES ($1, $2, 'booking.reminder', 'booking', $3, 'Нагадування 0024') RETURNING id`,
      [regionId, user, b.id],
    );
    const id = ins.rows[0].id as string;
    const claim = async () =>
      (
        await appClient.query(`SELECT id, attempts FROM notifications_claim_pending($1, 1000, 3, 600)`, [
          WORKER_TEMPLATES,
        ])
      ).rows.filter((r) => r.id === id) as { id: string; attempts: number }[];
    expect(await claim()).toEqual([{ id, attempts: 1 }]);
    // Воркер упал: строка взята (attempts = 1) — до конца аренды её никто не берёт, после — повтор.
    expect(await claim()).toEqual([]);
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await claim()).toEqual([{ id, attempts: 2 }]);
    // Просроченное взятие №1 не отмечает и не возвращает строку, которую уже держит взятие №2.
    const stale = await appClient.query(`SELECT notifications_mark_dispatched($1, 'sent', NULL, 1) AS ok`, [
      id,
    ]);
    expect(stale.rows[0].ok).toBe(false);
    const staleRelease = await appClient.query(`SELECT notifications_release($1, 0, 'x', 1, true) AS ok`, [
      id,
    ]);
    expect(staleRelease.rows[0].ok).toBe(false);
    // 429: отсрочка по retry_after без траты попытки — до срока не берётся, затем то же взятие №2.
    const rel = await appClient.query(
      `SELECT notifications_release($1, 30, 'Bot API sendMessage: 429', 2, true) AS ok`,
      [id],
    );
    expect(rel.rows[0].ok).toBe(true);
    expect(await claim()).toEqual([]);
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await claim()).toEqual([{ id, attempts: 2 }]);
    // 5xx: попытка посчитана.
    await appClient.query(`SELECT notifications_release($1, 0, 'Bot API sendMessage: 502', 2, false)`, [id]);
    expect(await claim()).toEqual([{ id, attempts: 3 }]);
    // Последняя попытка тоже не отмечена — после аренды строка failed (max_attempts), не висит pending.
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await claim()).toEqual([]);
    const final = await sql(`SELECT status, last_error, next_attempt_at FROM notifications WHERE id = $1`, [
      id,
    ]);
    expect(final.rows[0]).toMatchObject({ status: "failed", next_attempt_at: null });
    expect(final.rows[0].last_error).toContain("max_attempts");
  });

  it("флаг module.bookings у партнёра — по регионам назначений: включён хоть в одном — только его места", async () => {
    try {
      flagOff.add(regionId);
      // OWNER — назначения только в регионе A: модуль для него выключен (404).
      expect(await failure(bookings.partnerList(OWNER, {}))).toMatchObject({ status: 404 });
      expect(await failure(bookings.partnerResources(OWNER, placeId))).toMatchObject({ status: 404 });
      // OWNER2 — регионы A и B, включён только B: брони и ресурсы региона A не видны и не меняются.
      const list = await bookings.partnerList(OWNER2, {});
      expect(list.items.filter((i) => i.regionId === regionId)).toEqual([]);
      expect(await failure(bookings.partnerResources(OWNER2, placeId))).toMatchObject({ status: 403 });
      const [slot] = await freeSlots();
      expect(
        await failure(
          bookings.createManual(
            OWNER2,
            { resourceId, startsAt: slot!, peopleCount: 1, customerName: "Олена" },
            meta(OWNER2),
          ),
        ),
      ).toMatchObject({ status: 404 });
      flagOff.add(base.regions.b);
      expect(await failure(bookings.partnerList(OWNER2, {}))).toMatchObject({ status: 404 });
      flagOff.clear();
      expect((await bookings.partnerList(OWNER2, {})).items.some((i) => i.regionId === regionId)).toBe(true);
      expect((await bookings.partnerResources(OWNER2, placeId)).items.length).toBeGreaterThan(0);
    } finally {
      flagOff.clear();
    }
  });
});
