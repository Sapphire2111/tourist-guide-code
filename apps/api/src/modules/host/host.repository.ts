import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  InjectDb,
  type Db,
  type HostModule,
  type HostSectionRecord,
  type HostServiceRecord,
  type LocalizedText,
  type RoomSource,
  type ServiceRequest,
  type ServiceRequestActor,
  type ServiceRequestEvent,
  type ServiceRequestStatus,
} from "../../db/index.js";

// Данные блока 5 (миграция 0015, ADR-0020): «Про заклад», заявки, их история, персонал места. Вызывается в
// withTenant(региона): TenantGuardPlugin фильтрует region_id, второй рубеж — RLS. Пользовательские фильтры
// (автор заявки, места сотрудника) ставит сервис.

export const MY_REQUESTS_MAX = 100;
export const STAFF_REQUESTS_MAX = 200;

export type PlaceRef = { id: string; region_id: string; name_i18n: LocalizedText; status: string };

export type HostModuleWrite = {
  enabled: boolean;
  wifi_ssid: string | null;
  wifi_password: string | null;
  reception_phone: string | null;
  hours_from: string | null;
  hours_to: string | null;
  sections: HostSectionRecord[];
  services: HostServiceRecord[];
  updated_by: string | null;
};

export type NewServiceRequestRow = {
  place_id: string;
  user_id: string;
  entry_context_id: string | null;
  service_code: string;
  service_title_i18n: LocalizedText;
  room_label: string | null;
  room_source: RoomSource | null;
  comment: string | null;
  outside_hours: boolean;
  process_from: Date | null;
  sla_minutes: number | null;
  sla_due_at: Date | null;
};

export type StatusPatch = {
  status: ServiceRequestStatus;
  status_reason?: string | null;
  assigned_to?: string | null;
  accepted_at?: Date | null;
  started_at?: Date | null;
  closed_at?: Date | null;
};

export type StaffMemberRow = {
  assignment_id: string;
  user_id: string;
  role: string;
  granted_at: Date;
  telegram_user_id: string | null;
  username: string | null;
  first_name: string | null;
  service_consent: boolean;
};

@Injectable()
export class HostRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  private get q(): Db {
    return currentDb(this.db);
  }

  findPlace(id: string): Promise<PlaceRef | undefined> {
    return this.q
      .selectFrom("places")
      .select(["id", "region_id", "name_i18n", "status"])
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

  // --- «Про заклад» ---

  findModule(placeId: string): Promise<HostModule | undefined> {
    return this.q.selectFrom("host_modules").selectAll().where("place_id", "=", placeId).executeTakeFirst();
  }

  async upsertModule(placeId: string, w: HostModuleWrite): Promise<HostModule> {
    const values = {
      enabled: w.enabled,
      wifi_ssid: w.wifi_ssid,
      wifi_password: w.wifi_password,
      reception_phone: w.reception_phone,
      hours_from: w.hours_from,
      hours_to: w.hours_to,
      sections: JSON.stringify(w.sections),
      services: JSON.stringify(w.services),
      updated_by: w.updated_by,
    };
    return this.q
      .insertInto("host_modules")
      .values({ place_id: placeId, ...values })
      .onConflict((oc) => oc.column("place_id").doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Номер комнаты QR, по которому открыт контекст входа (только если контекст — этого места). */
  async entryRoom(
    entryContextId: string,
    placeId: string,
  ): Promise<{ matches: boolean; room_label: string | null } | undefined> {
    const row = await this.q
      .selectFrom("entry_contexts")
      .leftJoin("qr_points", "qr_points.id", "entry_contexts.qr_point_id")
      .select(["entry_contexts.place_id", "qr_points.room_label", "qr_points.active"])
      .where("entry_contexts.id", "=", entryContextId)
      .executeTakeFirst();
    if (!row) return undefined;
    const matches = row.place_id === placeId;
    return { matches, room_label: matches && row.active !== false ? (row.room_label ?? null) : null };
  }

  // --- заявки ---

  insertRequest(row: NewServiceRequestRow): Promise<ServiceRequest> {
    return this.q.insertInto("service_requests").values(row).returningAll().executeTakeFirstOrThrow();
  }

  findRequest(id: string, forUpdate = false): Promise<ServiceRequest | undefined> {
    let q = this.q.selectFrom("service_requests").selectAll().where("id", "=", id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** Открытая заявка той же услуги в том же месте от этого гостя или с этой комнаты (S-03: «Така заявка вже є»). */
  findActiveDuplicate(
    placeId: string,
    serviceCode: string,
    userId: string,
    roomLabel: string | null,
  ): Promise<ServiceRequest | undefined> {
    return this.q
      .selectFrom("service_requests")
      .selectAll()
      .where("place_id", "=", placeId)
      .where("service_code", "=", serviceCode)
      .where("status", "in", ["new", "accepted", "in_progress"])
      .where((eb) =>
        roomLabel === null
          ? eb("user_id", "=", userId)
          : eb.or([eb("user_id", "=", userId), eb("room_label", "=", roomLabel)]),
      )
      .orderBy("created_at", "desc")
      .executeTakeFirst();
  }

  listByUser(userId: string): Promise<ServiceRequest[]> {
    return this.q
      .selectFrom("service_requests")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(MY_REQUESTS_MAX)
      .execute();
  }

  listByPlaces(placeIds: readonly string[], status?: ServiceRequestStatus): Promise<ServiceRequest[]> {
    if (placeIds.length === 0) return Promise.resolve([]);
    let q = this.q
      .selectFrom("service_requests")
      .selectAll()
      .where("place_id", "in", [...placeIds]);
    if (status) q = q.where("status", "=", status);
    return q.orderBy("created_at", "desc").orderBy("id", "desc").limit(STAFF_REQUESTS_MAX).execute();
  }

  async openCounts(placeIds: readonly string[]): Promise<Map<string, number>> {
    if (placeIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("service_requests")
      .select(["place_id", (eb) => eb.fn.countAll<string>().as("n")])
      .where("place_id", "in", [...placeIds])
      .where("status", "in", ["new", "accepted", "in_progress"])
      .groupBy("place_id")
      .execute();
    return new Map(rows.map((r) => [r.place_id, Number(r.n)]));
  }

  /** Смена статуса с проверкой текущего (гонка двух сотрудников): undefined — статус уже другой. */
  updateStatus(
    id: string,
    from: ServiceRequestStatus,
    patch: StatusPatch,
  ): Promise<ServiceRequest | undefined> {
    return this.q
      .updateTable("service_requests")
      .set(patch)
      .where("id", "=", id)
      .where("status", "=", from)
      .returningAll()
      .executeTakeFirst();
  }

  insertEvent(e: {
    service_request_id: string;
    from_status: ServiceRequestStatus | null;
    to_status: ServiceRequestStatus;
    actor_type: ServiceRequestActor;
    actor_user_id: string | null;
    reason?: string | null;
  }): Promise<void> {
    return this.q
      .insertInto("service_request_events")
      .values(e)
      .execute()
      .then(() => undefined);
  }

  async events(requestIds: readonly string[]): Promise<Map<string, ServiceRequestEvent[]>> {
    const out = new Map<string, ServiceRequestEvent[]>();
    if (requestIds.length === 0) return out;
    const rows = await this.q
      .selectFrom("service_request_events")
      .selectAll()
      .where("service_request_id", "in", [...requestIds])
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    for (const r of rows) {
      const list = out.get(r.service_request_id) ?? [];
      list.push(r);
      out.set(r.service_request_id, list);
    }
    return out;
  }

  /** Имя гостя в Telegram (first_name) — для экрана персонала (D-49 А). */
  async guestNames(userIds: readonly string[]): Promise<Map<string, string | null>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("telegram_accounts")
      .select(["user_id", "first_name"])
      .where("user_id", "in", [...new Set(userIds)])
      .execute();
    return new Map(rows.map((r) => [r.user_id, r.first_name]));
  }

  // --- персонал места ---

  /** Действующие назначения персонала на место (регион контекста). */
  staffOf(placeId: string, roles: readonly string[]): Promise<StaffMemberRow[]> {
    return this.q
      .selectFrom("role_assignments as ra")
      .leftJoin("telegram_accounts as ta", "ta.user_id", "ra.user_id")
      .select([
        "ra.id as assignment_id",
        "ra.user_id",
        "ra.role",
        "ra.granted_at",
        "ta.telegram_user_id",
        "ta.username",
        "ta.first_name",
      ])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom("messaging_consents as mc")
              .select("mc.id")
              .whereRef("mc.user_id", "=", "ra.user_id")
              .where("mc.purpose", "=", "service")
              .where("mc.granted", "=", true),
          )
          .as("service_consent"),
      )
      .where("ra.scope_type", "=", "PLACE")
      .where("ra.scope_id", "=", placeId)
      .where("ra.role", "in", [...roles])
      .where("ra.revoked_at", "is", null)
      .where((eb) => eb.or([eb("ra.valid_until", "is", null), eb("ra.valid_until", ">", sql<Date>`now()`)]))
      .orderBy("ra.granted_at")
      .execute() as Promise<StaffMemberRow[]>;
  }

  /** Пользователь, входивший в Mini App, по Telegram id или username (без учёта регистра). */
  findUserByTelegram(by: {
    telegramUserId?: string;
    username?: string;
  }): Promise<{ user_id: string } | undefined> {
    let q = this.q.selectFrom("telegram_accounts").select("user_id");
    if (by.telegramUserId !== undefined) q = q.where("telegram_user_id", "=", by.telegramUserId);
    else if (by.username !== undefined)
      q = q.where(sql<boolean>`lower(username) = ${by.username.replace(/^@/, "").toLowerCase()}`);
    else return Promise.resolve(undefined);
    return q.executeTakeFirst();
  }
}
