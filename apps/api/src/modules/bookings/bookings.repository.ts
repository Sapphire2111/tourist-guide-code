import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  InjectDb,
  type Booking,
  type BookingActor,
  type BookingEvent,
  type BookingMode,
  type BookingSource,
  type BookingStatus,
  type Db,
  type JsonObject,
  type LocalizedText,
  type ManualAvailability,
  type PhoneSource,
  type Resource,
  type ResourceStatus,
} from "../../db/index.js";
import { OCCUPYING_STATUSES, UNCONFIRMED_STATUSES, type BusyRange, type RuleInput } from "./booking-rules.js";

// Данные блока 7 (миграция 0022): ресурсы, правила, согласие на телефон, брони и история. Вызывается в
// withTenant(региона): TenantGuardPlugin фильтрует region_id, второй рубеж — RLS. Пользовательские фильтры (автор
// брони, места партнёра) ставит сервис.

export const MY_BOOKINGS_MAX = 100;
export const PARTNER_BOOKINGS_MAX = 300;
/** Роли организации, которым уходит уведомление о новой брони. */
const NOTIFY_ROLES = ["ORG_OWNER", "ORG_MANAGER", "ORG_STAFF"] as const;

export type PlaceRef = {
  id: string;
  organization_id: string | null;
  status: string;
  name_i18n: LocalizedText;
};

export type ResourceWrite = {
  name_i18n?: LocalizedText;
  description_i18n?: LocalizedText | null;
  capacity_people?: number;
  slot_duration_min?: number;
  buffer_before_min?: number;
  buffer_after_min?: number;
  lead_time_min?: number;
  horizon_days?: number;
  confirm_sla_min?: number;
  booking_mode?: BookingMode;
  price_minor?: number | null;
  currency?: string | null;
  status?: ResourceStatus;
};

export type NewBookingRow = {
  organization_id: string;
  place_id: string;
  resource_id: string;
  user_id: string | null;
  source: BookingSource;
  entry_context_id: string | null;
  starts_at: Date;
  ends_at: Date;
  occupied_from: Date;
  occupied_until: Date;
  people_count: number;
  comment: string | null;
  customer_name: string | null;
  contact_phone: string | null;
  contact_phone_source: PhoneSource | null;
  phone_consent_id: string | null;
  price_quote_minor: string | null;
  currency: string | null;
  status: BookingStatus;
  partner_response_due_at: Date | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_by: string | null;
};

export type BookingPatch = {
  status: BookingStatus;
  status_reason?: string | null;
  starts_at?: Date;
  ends_at?: Date;
  occupied_from?: Date;
  occupied_until?: Date;
  partner_response_due_at?: Date | null;
  alternative_starts_at?: Date | null;
  alternative_ends_at?: Date | null;
  customer_response_due_at?: Date | null;
  confirmed_by?: string | null;
  confirmed_at?: Date | null;
  completed_at?: Date | null;
  closed_at?: Date | null;
};

export type NewEventRow = {
  booking_id: string;
  from_status: BookingStatus | null;
  to_status: BookingStatus;
  actor_type: BookingActor;
  actor_user_id: string | null;
  role_assignment_id?: string | null;
  reason?: string | null;
  payload?: JsonObject;
};

export type BookingUser = {
  id: string;
  display_name: string | null;
  analytics_id: string;
  booking_no_show_count: number;
};

export type PartnerBookingFilter = {
  status?: BookingStatus;
  from?: Date;
  to?: Date;
};

@Injectable()
export class BookingsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  private get q(): Db {
    return currentDb(this.db);
  }

  // --- места и ресурсы ---

  findPlace(id: string): Promise<PlaceRef | undefined> {
    return this.q
      .selectFrom("places")
      .select(["id", "organization_id", "status", "name_i18n"])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  placeNames(ids: readonly string[]): Promise<Map<string, LocalizedText>> {
    if (ids.length === 0) return Promise.resolve(new Map());
    return this.q
      .selectFrom("places")
      .select(["id", "name_i18n"])
      .where("id", "in", [...new Set(ids)])
      .execute()
      .then((rows) => new Map(rows.map((r) => [r.id, r.name_i18n])));
  }

  /** Места организаций (партнёр работает со всеми местами своей организации), кроме архива. */
  async placesOfOrganizations(
    organizationIds: readonly string[],
  ): Promise<{ id: string; organization_id: string }[]> {
    if (organizationIds.length === 0) return [];
    const rows = await this.q
      .selectFrom("places")
      .select(["id", "organization_id"])
      .where("organization_id", "in", [...new Set(organizationIds)])
      .where("status", "<>", "archived")
      .execute();
    return rows.flatMap((r) => (r.organization_id ? [{ id: r.id, organization_id: r.organization_id }] : []));
  }

  findResource(id: string, lock = false): Promise<Resource | undefined> {
    let query = this.q.selectFrom("resources").selectAll().where("id", "=", id);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  resourcesOfPlaces(placeIds: readonly string[], statuses?: readonly ResourceStatus[]): Promise<Resource[]> {
    if (placeIds.length === 0) return Promise.resolve([]);
    let query = this.q
      .selectFrom("resources")
      .selectAll()
      .where("place_id", "in", [...new Set(placeIds)]);
    if (statuses) query = query.where("status", "in", [...statuses]);
    return query.orderBy("created_at").orderBy("id").execute();
  }

  resourceNames(ids: readonly string[]): Promise<Map<string, LocalizedText>> {
    if (ids.length === 0) return Promise.resolve(new Map());
    return this.q
      .selectFrom("resources")
      .select(["id", "name_i18n"])
      .where("id", "in", [...new Set(ids)])
      .execute()
      .then((rows) => new Map(rows.map((r) => [r.id, r.name_i18n])));
  }

  insertResource(
    row: ResourceWrite & {
      organization_id: string;
      place_id: string;
      name_i18n: LocalizedText;
      created_by: string;
    },
  ): Promise<Resource> {
    return this.q
      .insertInto("resources")
      .values({
        ...row,
        name_i18n: row.name_i18n,
        description_i18n: row.description_i18n ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateResource(id: string, patch: ResourceWrite): Promise<Resource | undefined> {
    return this.q
      .updateTable("resources")
      .set({ ...patch, version: sql<number>`version + 1` })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  setManualAvailability(
    id: string,
    v: { status: ManualAvailability; expiresAt: Date | null; setBy: string | null; setAt: Date | null },
  ): Promise<Resource | undefined> {
    return this.q
      .updateTable("resources")
      .set({
        manual_availability: v.status,
        manual_availability_expires_at: v.expiresAt,
        manual_availability_set_by: v.setBy,
        manual_availability_set_at: v.setAt,
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  /** Правила ресурсов; date — строкой "YYYY-MM-DD" (без сдвига таймзоны драйвера). */
  async rulesOf(resourceIds: readonly string[]): Promise<Map<string, RuleInput[]>> {
    const out = new Map<string, RuleInput[]>();
    if (resourceIds.length === 0) return out;
    const rows = await this.q
      .selectFrom("availability_rules")
      .select(["resource_id", "day_of_week", "closed", "opens_min", "closes_min"])
      .select(sql<string | null>`to_char(date, 'YYYY-MM-DD')`.as("date_text"))
      .where("resource_id", "in", [...new Set(resourceIds)])
      .orderBy("day_of_week")
      .orderBy("date")
      .orderBy("opens_min")
      .execute();
    for (const r of rows)
      out.set(r.resource_id, [
        ...(out.get(r.resource_id) ?? []),
        {
          dayOfWeek: r.day_of_week,
          date: r.date_text,
          closed: r.closed,
          opensMin: r.opens_min,
          closesMin: r.closes_min,
        },
      ]);
    return out;
  }

  async replaceRules(resourceId: string, rules: readonly RuleInput[]): Promise<void> {
    await this.q.deleteFrom("availability_rules").where("resource_id", "=", resourceId).execute();
    if (rules.length === 0) return;
    await this.q
      .insertInto("availability_rules")
      .values(
        rules.map((r) => ({
          resource_id: resourceId,
          day_of_week: r.dayOfWeek,
          date: r.date,
          closed: r.closed,
          opens_min: r.opensMin,
          closes_min: r.closesMin,
        })),
      )
      .execute();
  }

  /** Занятые интервалы ресурса, пересекающие [from, until) (занимающие статусы, BR-08). */
  async busyRanges(
    resourceIds: readonly string[],
    from: Date,
    until: Date,
  ): Promise<Map<string, BusyRange[]>> {
    const out = new Map<string, BusyRange[]>();
    if (resourceIds.length === 0) return out;
    const rows = await this.q
      .selectFrom("bookings")
      .select(["resource_id", "occupied_from", "occupied_until"])
      .where("resource_id", "in", [...new Set(resourceIds)])
      .where("status", "in", [...OCCUPYING_STATUSES])
      .where("occupied_until", ">", from)
      .where("occupied_from", "<", until)
      .execute();
    for (const r of rows)
      out.set(r.resource_id, [
        ...(out.get(r.resource_id) ?? []),
        { from: r.occupied_from, until: r.occupied_until },
      ]);
    return out;
  }

  // --- согласие и брони ---

  async insertPhoneConsent(row: {
    user_id: string;
    organization_id: string;
    place_id: string;
    document_version: string;
  }): Promise<string> {
    const r = await this.q
      .insertInto("partner_phone_consents")
      .values(row)
      .returning("id")
      .executeTakeFirstOrThrow();
    return r.id;
  }

  /** Действующие (не отозванные) согласия из списка. */
  async activeConsents(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.q
      .selectFrom("partner_phone_consents")
      .select("id")
      .where("id", "in", [...new Set(ids)])
      .where("withdrawn_at", "is", null)
      .execute();
    return new Set(rows.map((r) => r.id));
  }

  /** Контекст входа существует и не чужой (анонимный или этого пользователя) — для атрибуции брони. */
  async entryContextOf(id: string, userId: string): Promise<boolean> {
    const row = await this.q
      .selectFrom("entry_contexts")
      .select("id")
      .where("id", "=", id)
      .where((eb) => eb.or([eb("user_id", "is", null), eb("user_id", "=", userId)]))
      .executeTakeFirst();
    return row !== undefined;
  }

  insertBooking(row: NewBookingRow): Promise<Booking> {
    return this.q.insertInto("bookings").values(row).returningAll().executeTakeFirstOrThrow();
  }

  findBooking(id: string, lock = false): Promise<Booking | undefined> {
    let query = this.q.selectFrom("bookings").selectAll().where("id", "=", id);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  /** Смена статуса с проверкой текущего (гонка двух участников): undefined — статус уже другой. */
  updateStatus(id: string, from: BookingStatus, patch: BookingPatch): Promise<Booking | undefined> {
    return this.q
      .updateTable("bookings")
      .set({ ...patch, version: sql<number>`version + 1` })
      .where("id", "=", id)
      .where("status", "=", from)
      .returningAll()
      .executeTakeFirst();
  }

  async insertEvent(row: NewEventRow): Promise<void> {
    await this.q
      .insertInto("booking_events")
      .values({ ...row, payload: row.payload ?? {} })
      .execute();
  }

  async events(bookingIds: readonly string[]): Promise<Map<string, BookingEvent[]>> {
    const out = new Map<string, BookingEvent[]>();
    if (bookingIds.length === 0) return out;
    const rows = await this.q
      .selectFrom("booking_events")
      .selectAll()
      .where("booking_id", "in", [...new Set(bookingIds)])
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    for (const r of rows) out.set(r.booking_id, [...(out.get(r.booking_id) ?? []), r]);
    return out;
  }

  listByUser(userId: string): Promise<Booking[]> {
    return this.q
      .selectFrom("bookings")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("starts_at", "desc")
      .orderBy("id", "desc")
      .limit(MY_BOOKINGS_MAX)
      .execute();
  }

  listByPlaces(placeIds: readonly string[], f: PartnerBookingFilter): Promise<Booking[]> {
    if (placeIds.length === 0) return Promise.resolve([]);
    let query = this.q
      .selectFrom("bookings")
      .selectAll()
      .where("place_id", "in", [...new Set(placeIds)]);
    if (f.status) query = query.where("status", "=", f.status);
    if (f.from) query = query.where("starts_at", ">=", f.from);
    if (f.to) query = query.where("starts_at", "<", f.to);
    return query.orderBy("starts_at").orderBy("id").limit(PARTNER_BOOKINGS_MAX).execute();
  }

  async countUnconfirmed(userId: string): Promise<number> {
    const r = await this.q
      .selectFrom("bookings")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("user_id", "=", userId)
      .where("status", "in", [...UNCONFIRMED_STATUSES])
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  // --- пользователи (global) ---

  async users(ids: readonly string[]): Promise<Map<string, BookingUser>> {
    if (ids.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("users")
      .select(["id", "display_name", "analytics_id", "booking_no_show_count"])
      .where("id", "in", [...new Set(ids)])
      .execute();
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Счётчик no_show (D-44): +1 при отметке, −1 при исправлении (не ниже 0). */
  async adjustNoShow(userId: string, delta: 1 | -1): Promise<void> {
    await this.q
      .updateTable("users")
      .set({ booking_no_show_count: sql<number>`greatest(booking_no_show_count + ${delta}, 0)` })
      .where("id", "=", userId)
      .execute();
  }

  /** Сотрудники организации и места (назначения ORGANIZATION/PLACE) — получатели уведомлений о брони. */
  async partnerUsers(organizationId: string, placeId: string): Promise<string[]> {
    const rows = await this.q
      .selectFrom("role_assignments")
      .select("user_id")
      .distinct()
      .where("revoked_at", "is", null)
      .where("role", "in", [...NOTIFY_ROLES])
      .where((eb) =>
        eb.or([
          eb.and([eb("scope_type", "=", "ORGANIZATION"), eb("scope_id", "=", organizationId)]),
          eb.and([eb("scope_type", "=", "PLACE"), eb("scope_id", "=", placeId)]),
        ]),
      )
      .where((eb) => eb.or([eb("valid_until", "is", null), eb("valid_until", ">", new Date())]))
      .execute();
    return rows.map((r) => r.user_id);
  }
}
