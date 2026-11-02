import { Injectable } from "@nestjs/common";
import { sql, type Expression, type ExpressionBuilder } from "kysely";
import {
  currentDb,
  InjectDb,
  type Database,
  type Db,
  type ModerationCase,
  type ModerationCaseStatus,
  type Offer,
  type OfferStatus,
  type Organization,
  type PartnerTemplate,
  type StaffInvite,
  distanceMeters,
  point,
  withinMeters,
  type Geometry,
  type LonLat,
} from "../../db/index.js";
import { likePattern } from "../catalog/index.js";

/** Колонка точки места как geometry (для PostGIS-хелперов db/geo). */
const geomOf = (eb: ExpressionBuilder<Database & { p: Database["places"] }, "p">) =>
  eb.ref("p.location") as Expression<Geometry>;

/** Открытые заявки гостей (как экран персонала, блок 5). */
const OPEN_REQUEST_STATUSES = ["new", "accepted", "in_progress"] as const;
const PARTNER_ROLE_CODES = ["ORG_OWNER", "ORG_MANAGER", "ORG_STAFF"] as const;

export type CategoryRef = { id: string; code: string; name_i18n: { uk: string; en?: string } };

export type StaffMemberRow = {
  assignment_id: string;
  user_id: string;
  role: string;
  granted_at: Date;
  display_name: string | null;
  username: string | null;
};

export type ModerationCaseRow = ModerationCase & {
  place_name: { uk: string; en?: string };
  place_status: string;
  organization_name: string;
  template_code: string | null;
  template_name: { uk: string; en?: string } | null;
  submitted_by_name: string | null;
  decided_by_name: string | null;
};

/** Возможный дубль места (AD02): рядом по точке или похожее название. */
export type DuplicateRow = {
  id: string;
  name_i18n: { uk: string; en?: string };
  status: string;
  source: string;
  distance: number | null;
};

/**
 * Данные кабинета партнёра (блок 6, ADR-0021). Все запросы — в транзакции региона (withTenant): RLS и
 * TenantGuardPlugin ограничивают регионом; функции app_* (режим SYSTEM) — для поиска региона вне транзакции.
 */
@Injectable()
export class PartnerRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  private get q(): Db {
    return currentDb(this.db);
  }

  // --- поиск региона (вне транзакции региона; функции БД в режиме SYSTEM, миграция 0017) ---

  async inviteRegion(tokenHash: Buffer): Promise<string | undefined> {
    const row = await this.q
      .selectNoFrom(sql<string | null>`app_staff_invite_region(${tokenHash})`.as("region_id"))
      .executeTakeFirst();
    return row?.region_id ?? undefined;
  }

  async caseRegion(caseId: string): Promise<string | undefined> {
    const row = await this.q
      .selectNoFrom(sql<string | null>`app_moderation_case_region(${caseId}::uuid)`.as("region_id"))
      .executeTakeFirst();
    return row?.region_id ?? undefined;
  }

  // --- шаблоны и категории ---

  listTemplates(): Promise<PartnerTemplate[]> {
    return this.q
      .selectFrom("partner_templates")
      .selectAll()
      .where("active", "=", true)
      .orderBy("sort_order")
      .orderBy("code")
      .execute();
  }

  findTemplateByCode(code: string): Promise<PartnerTemplate | undefined> {
    return this.q
      .selectFrom("partner_templates")
      .selectAll()
      .where("code", "=", code)
      .where("active", "=", true)
      .executeTakeFirst();
  }

  findTemplate(id: string): Promise<PartnerTemplate | undefined> {
    return this.q.selectFrom("partner_templates").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Активные категории региона по кодам. */
  categoriesByCodes(codes: readonly string[]): Promise<CategoryRef[]> {
    if (codes.length === 0) return Promise.resolve([]);
    return this.q
      .selectFrom("categories")
      .select(["id", "code", "name_i18n"])
      .where("code", "in", [...codes])
      .where("active", "=", true)
      .orderBy("sort_order")
      .orderBy("code")
      .execute();
  }

  // --- организации и места ---

  createOrganization(row: { name: string; created_by: string }): Promise<Organization> {
    return this.q.insertInto("organizations").values(row).returningAll().executeTakeFirstOrThrow();
  }

  organizations(ids: readonly string[]): Promise<Organization[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.q
      .selectFrom("organizations")
      .selectAll()
      .where("id", "in", [...ids])
      .execute();
  }

  findOrganization(id: string): Promise<Organization | undefined> {
    return this.q.selectFrom("organizations").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Места организаций (кроме архива) — для переключателя и дашборда. */
  placesOf(organizationIds: readonly string[]) {
    if (organizationIds.length === 0) return Promise.resolve([]);
    return this.q
      .selectFrom("places")
      .leftJoin("partner_templates as t", "t.id", "places.partner_template_id")
      .select([
        "places.id",
        "places.organization_id",
        "places.name_i18n",
        "places.status",
        "places.created_at",
        "t.code as template_code",
        "t.modules as template_modules",
      ])
      .where("places.organization_id", "in", [...organizationIds])
      .where("places.status", "<>", "archived")
      .orderBy("places.created_at")
      .execute();
  }

  async placeNames(organizationId: string): Promise<{ uk: string; en?: string }[]> {
    const rows = await this.q
      .selectFrom("places")
      .select("name_i18n")
      .where("organization_id", "=", organizationId)
      .where("status", "<>", "archived")
      .orderBy("created_at")
      .execute();
    return rows.map((r) => r.name_i18n);
  }

  async openRequestCounts(placeIds: readonly string[]): Promise<Map<string, number>> {
    if (placeIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("service_requests")
      .select(["place_id", (eb) => eb.fn.countAll<string>().as("n")])
      .where("place_id", "in", [...placeIds])
      .where("status", "in", [...OPEN_REQUEST_STATUSES])
      .groupBy("place_id")
      .execute();
    return new Map(rows.map((r) => [r.place_id, Number(r.n)]));
  }

  async activeOfferCounts(placeIds: readonly string[]): Promise<Map<string, number>> {
    if (placeIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("offers")
      .select(["place_id", (eb) => eb.fn.countAll<string>().as("n")])
      .where("place_id", "in", [...placeIds])
      .where("status", "=", "active")
      .groupBy("place_id")
      .execute();
    return new Map(rows.map((r) => [r.place_id, Number(r.n)]));
  }

  // --- модерация ---

  /** Последняя заявка по каждому месту. */
  async lastCases(placeIds: readonly string[]): Promise<Map<string, ModerationCase>> {
    if (placeIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("moderation_cases")
      .selectAll()
      .distinctOn("place_id")
      .where("place_id", "in", [...placeIds])
      .orderBy("place_id")
      .orderBy("submitted_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return new Map(rows.map((r) => [r.place_id, r]));
  }

  insertCase(row: {
    place_id: string;
    organization_id: string;
    submitted_by: string;
    partner_note: string | null;
    place_snapshot: Record<string, unknown>;
  }): Promise<ModerationCase> {
    return this.q.insertInto("moderation_cases").values(row).returningAll().executeTakeFirstOrThrow();
  }

  findCase(id: string, lock = false): Promise<ModerationCase | undefined> {
    let q = this.q.selectFrom("moderation_cases").selectAll().where("id", "=", id);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** Решение по открытой заявке; уже решённая — undefined (гонка двух модераторов). */
  decideCase(
    id: string,
    patch: {
      decision: ModerationCase["decision"];
      comment: string | null;
      verification_method: ModerationCase["verification_method"];
      decided_by: string;
    },
  ): Promise<ModerationCase | undefined> {
    return this.q
      .updateTable("moderation_cases")
      .set({ ...patch, status: "decided", decided_at: new Date() })
      .where("id", "=", id)
      .where("status", "=", "open")
      .returningAll()
      .executeTakeFirst();
  }

  /** Очередь: заявки текущего контекста (регион или PLATFORM — все) с названием места и организации. */
  listCases(filter: {
    status: ModerationCaseStatus;
    placeId?: string;
    limit: number;
  }): Promise<ModerationCaseRow[]> {
    let q = this.caseQuery().where("c.status", "=", filter.status);
    if (filter.placeId) q = q.where("c.place_id", "=", filter.placeId);
    q =
      filter.status === "open"
        ? q.orderBy("c.submitted_at", "asc").orderBy("c.id", "asc")
        : q.orderBy("c.submitted_at", "desc").orderBy("c.id", "desc");
    return q.limit(filter.limit).execute() as Promise<ModerationCaseRow[]>;
  }

  caseRow(id: string): Promise<ModerationCaseRow | undefined> {
    return this.caseQuery().where("c.id", "=", id).executeTakeFirst() as Promise<
      ModerationCaseRow | undefined
    >;
  }

  placeHistory(placeId: string, exceptId: string): Promise<ModerationCaseRow[]> {
    return this.caseQuery()
      .where("c.place_id", "=", placeId)
      .where("c.id", "<>", exceptId)
      .orderBy("c.submitted_at", "desc")
      .limit(20)
      .execute() as Promise<ModerationCaseRow[]>;
  }

  private caseQuery() {
    return this.q
      .selectFrom("moderation_cases as c")
      .innerJoin("places as p", (j) =>
        j.onRef("p.id", "=", "c.place_id").onRef("p.region_id", "=", "c.region_id"),
      )
      .innerJoin("organizations as o", (j) =>
        j.onRef("o.id", "=", "c.organization_id").onRef("o.region_id", "=", "c.region_id"),
      )
      .leftJoin("partner_templates as t", "t.id", "p.partner_template_id")
      .leftJoin("users as u", "u.id", "c.submitted_by")
      .leftJoin("users as du", "du.id", "c.decided_by")
      .leftJoin("admin_credentials as ac", "ac.user_id", "c.decided_by")
      .selectAll("c")
      .select([
        "p.name_i18n as place_name",
        "p.status as place_status",
        "o.name as organization_name",
        "t.code as template_code",
        "t.name_i18n as template_name",
        "u.display_name as submitted_by_name",
        (eb) => eb.fn.coalesce("du.display_name", "ac.login").as("decided_by_name"),
      ]);
  }

  /**
   * Возможные дубли места (D-47, места Google): другие места региона (кроме архива) в радиусе radiusMeters от точки
   * или с похожим названием (uk, ILIKE в обе стороны; pg_trgm не подключён). Ближние — первыми.
   */
  possibleDuplicates(
    placeId: string,
    name: string,
    location: LonLat | null,
    radiusMeters: number,
    limit: number,
  ): Promise<DuplicateRow[]> {
    const nameUk = sql<string>`p.name_i18n->>'uk'`;
    const target = location ? point(location) : null;
    // Экранирование % _ \ для ILIKE (chr(92) — обратная косая черта).
    const escaped = sql<string>`replace(replace(replace(${nameUk}, chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_')`;
    return this.q
      .selectFrom("places as p")
      .select([
        "p.id",
        "p.name_i18n",
        "p.status",
        "p.source",
        (eb) =>
          (target
            ? sql<
                number | null
              >`CASE WHEN p.location IS NULL THEN NULL ELSE ${distanceMeters(geomOf(eb), target)} END`
            : sql<number | null>`NULL::float8`
          ).as("distance"),
      ])
      .where("p.id", "<>", placeId)
      .where("p.status", "<>", "archived")
      .where((eb) =>
        eb.or([
          ...(target
            ? [eb.and([eb("p.location", "is not", null), withinMeters(geomOf(eb), target, radiusMeters)])]
            : []),
          sql<boolean>`${nameUk} ILIKE ${likePattern(name)}`,
          sql<boolean>`${name} ILIKE ('%' || ${escaped} || '%')`,
        ]),
      )
      .orderBy(sql`distance NULLS LAST`)
      .orderBy("p.id")
      .limit(limit)
      .execute() as Promise<DuplicateRow[]>;
  }

  // --- сотрудники ---

  /** Действующие назначения ролей партнёра на организацию с именем и username. */
  staffOf(organizationId: string): Promise<StaffMemberRow[]> {
    return this.q
      .selectFrom("role_assignments as ra")
      .innerJoin("users as u", "u.id", "ra.user_id")
      .leftJoin("telegram_accounts as ta", "ta.user_id", "ra.user_id")
      .select([
        "ra.id as assignment_id",
        "ra.user_id",
        "ra.role",
        "ra.granted_at",
        "u.display_name",
        "ta.username",
      ])
      .where("ra.scope_type", "=", "ORGANIZATION")
      .where("ra.scope_id", "=", organizationId)
      .where("ra.role", "in", [...PARTNER_ROLE_CODES])
      .where("ra.revoked_at", "is", null)
      .where((eb) => eb.or([eb("ra.valid_until", "is", null), eb("ra.valid_until", ">", new Date())]))
      .orderBy("ra.granted_at")
      .execute();
  }

  /** Получатели уведомления о новой заявке: модераторы и администраторы региона (C-15). */
  async regionModerators(regionId: string): Promise<string[]> {
    const rows = await this.q
      .selectFrom("role_assignments")
      .select("user_id")
      .distinct()
      .where("scope_type", "=", "REGION")
      .where("scope_id", "=", regionId)
      .where("role", "in", ["MODERATOR", "REGION_ADMIN"])
      .where("revoked_at", "is", null)
      .where((eb) => eb.or([eb("valid_until", "is", null), eb("valid_until", ">", new Date())]))
      .execute();
    return rows.map((r) => r.user_id);
  }

  // --- приглашения ---

  createInvite(row: {
    organization_id: string;
    role: StaffInvite["role"];
    token_hash: Buffer;
    expires_at: Date;
    created_by: string;
  }): Promise<StaffInvite> {
    return this.q.insertInto("staff_invites").values(row).returningAll().executeTakeFirstOrThrow();
  }

  invites(organizationId: string) {
    return this.q
      .selectFrom("staff_invites as i")
      .leftJoin("users as u", "u.id", "i.accepted_by")
      .selectAll("i")
      .select("u.display_name as accepted_by_name")
      .where("i.organization_id", "=", organizationId)
      .orderBy("i.created_at", "desc")
      .limit(50)
      .execute();
  }

  findInvite(organizationId: string, id: string, lock = false): Promise<StaffInvite | undefined> {
    let q = this.q
      .selectFrom("staff_invites")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  findInviteByHash(tokenHash: Buffer, lock = false): Promise<StaffInvite | undefined> {
    let q = this.q.selectFrom("staff_invites").selectAll().where("token_hash", "=", tokenHash);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  revokeInvite(id: string, by: string): Promise<StaffInvite | undefined> {
    return this.q
      .updateTable("staff_invites")
      .set({ revoked_at: new Date(), revoked_by: by })
      .where("id", "=", id)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
  }

  /** Отметка «использовано»: только действующее (не принятое, не отозванное) — одноразовость. */
  acceptInvite(id: string, by: string, assignmentId: string): Promise<StaffInvite | undefined> {
    return this.q
      .updateTable("staff_invites")
      .set({ accepted_at: new Date(), accepted_by: by, role_assignment_id: assignmentId })
      .where("id", "=", id)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
  }

  // --- акции ---

  offers(placeId: string, status?: OfferStatus): Promise<Offer[]> {
    let q = this.q.selectFrom("offers").selectAll().where("place_id", "=", placeId);
    if (status) q = q.where("status", "=", status);
    return q.orderBy("created_at", "desc").limit(200).execute();
  }

  findOffer(placeId: string, id: string): Promise<Offer | undefined> {
    return this.q
      .selectFrom("offers")
      .selectAll()
      .where("id", "=", id)
      .where("place_id", "=", placeId)
      .forUpdate()
      .executeTakeFirst();
  }

  createOffer(row: {
    place_id: string;
    title_i18n: { uk: string; en?: string };
    description_i18n: { uk: string; en?: string } | null;
    starts_at: string | null;
    ends_at: string | null;
    created_by: string;
  }): Promise<Offer> {
    return this.q.insertInto("offers").values(row).returningAll().executeTakeFirstOrThrow();
  }

  updateOffer(
    id: string,
    patch: {
      title_i18n?: { uk: string; en?: string };
      description_i18n?: { uk: string; en?: string } | null;
      starts_at?: string | null;
      ends_at?: string | null;
      status?: OfferStatus;
    },
  ): Promise<Offer> {
    return this.q
      .updateTable("offers")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
