import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ANALYTICS_SCHEMA_VERSION, type AnalyticsEvent } from "@tg/shared";
import { uuidv7 } from "@tg/media";
import { ApiError, toLocalized } from "../../common/http/index.js";
import {
  currentDb,
  currentTenant,
  InjectDb,
  regionContext,
  withTenant,
  type Booking,
  type BookingEvent,
  type BookingStatus,
  type Db,
  type JsonObject,
  type LocalizedText,
  type Region,
  type Resource,
} from "../../db/index.js";
import { AnalyticsService } from "../analytics/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import { NotificationsService, type NotificationDraft } from "../host/index.js";
import {
  findGrant,
  isGrantActive,
  PLATFORM_SCOPE,
  RbacService,
  regionScope,
  roleHasPermission,
  scope,
  type Grant,
  type PermissionCode,
  type ScopeChain,
} from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import {
  availabilityNow,
  BOOKING_PARAMS,
  customerResponseDue,
  findSlot,
  generateSlots,
  isFree,
  localDate,
  occupiedRange,
  partnerPermission,
  partnerResponseDue,
  partnerTransitions,
  rulesProblems,
  transitionActor,
  userTransitions,
  type AvailabilityNow,
  type RuleInput,
} from "./booking-rules.js";
import type {
  AvailabilityNowDto,
  BookingDto,
  BookingListDto,
  BookingTargetStatus,
  CreateBookingDto,
  CreateManualBookingDto,
  CreateResourceDto,
  PartnerBookingDto,
  PartnerBookingListDto,
  PartnerBookingsQueryDto,
  PartnerResourceDto,
  PartnerResourceListDto,
  PutAvailabilityDto,
  PutManualAvailabilityDto,
  ResourceDto,
  ResourceListDto,
  SlotListDto,
  UpdateBookingStatusDto,
  UpdateResourceDto,
} from "./bookings.dto.js";
import { BookingsRepository, type BookingPatch, type ResourceWrite } from "./bookings.repository.js";

export type BookingAuditMeta = Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">;

export const BOOKING_ENTITY = "booking";
export const RESOURCE_ENTITY = "resource";
export const BOOKING_AUDIT = {
  status: "booking.status",
  manualCreate: "booking.manual.create",
  resourceCreate: "resource.create",
  resourceUpdate: "resource.update",
  availabilityUpdate: "availability.update",
  manualStatus: "availability.status.manual",
} as const;
export const BOOKING_NOTIFICATIONS = {
  created: "booking.created",
  status: "booking.status",
} as const;
/** Версия текста согласия на передачу телефона партнёру (D-42; формулировка — LEG, на staging заглушка). */
export const PHONE_SHARE_CONSENT_VERSION = "2026-11-03";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Место партнёра: организация и регион — из БД; назначение — то, что дало право (в аудит). */
type PartnerPlace = { placeId: string; organizationId: string; regionId: string };

const STATUS_TEXT: Readonly<Record<BookingStatus, string>> = {
  new: "нове",
  pending_partner: "очікує підтвердження",
  confirmed: "підтверджено",
  alternative_proposed: "запропоновано інший час",
  cancelled_by_user: "скасовано клієнтом",
  cancelled_by_partner: "скасовано закладом",
  expired: "минув час на відповідь",
  completed: "завершено",
  no_show: "клієнт не прийшов",
};

const notFound = () => new ApiError("NOT_FOUND");

/**
 * Бронирования (блок 7; ТЗ §10, §14.1, §16; states-and-rules §3, BR-04, BR-08, BR-29). Турист — регион из запроса
 * (как каталог гида): чтение и запись в withTenant(региона). Партнёр — права из назначений ORG_* на место/организацию
 * (RBAC на сервере, не из запроса): чужая бронь — 404. Занятость слота защищает ограничение исключения БД
 * bookings_no_overlap (гонка двух броней → 409 errors.booking.slotTaken). Уведомления — outbox notifications (как
 * блок 5), аналитика — после коммита.
 */
@Injectable()
export class BookingsService {
  private readonly logger = new Logger("Bookings");

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(BookingsRepository) private readonly repo: BookingsRepository,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Optional() @Inject(AnalyticsService) private readonly analytics?: AnalyticsService,
  ) {}

  /** Часы сервиса (подменяется в тестах). */
  now: () => Date = () => new Date();

  // --- турист: ресурсы и слоты (C07) ---

  async listResources(regionId: string, placeId: string): Promise<ResourceListDto> {
    return this.inRegion(regionId, async (region) => {
      const place = await this.repo.findPlace(placeId);
      if (place?.status !== "published") throw notFound();
      const resources = await this.repo.resourcesOfPlaces([place.id], ["active"]);
      const availability = await this.availabilityOf(resources, region.timezone);
      return { items: resources.map((r) => toResourceDto(r, availability.get(r.id)!)) };
    });
  }

  async slots(
    regionId: string,
    resourceId: string,
    q: { from?: string; days?: number },
  ): Promise<SlotListDto> {
    return this.inRegion(regionId, async (region) => {
      const resource = await this.bookableResource(resourceId);
      const now = this.now();
      const from = q.from ?? localDate(now, region.timezone);
      const days = q.days ?? 7;
      const rules = (await this.repo.rulesOf([resource.id])).get(resource.id) ?? [];
      const slots = generateSlots(resource, rules, from, days, region.timezone, now);
      const busy =
        slots.length === 0
          ? []
          : ((
              await this.repo.busyRanges([resource.id], slots[0]!.occupiedFrom, slots.at(-1)!.occupiedUntil)
            ).get(resource.id) ?? []);
      const availability = (await this.availabilityOf([resource], region.timezone)).get(resource.id)!;
      return {
        resourceId: resource.id,
        timezone: region.timezone,
        from,
        days,
        items: slots.map((s) => ({
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          free: isFree(s, busy),
        })),
        availability: toAvailabilityDto(availability),
      };
    });
  }

  // --- турист: брони (C08) ---

  /**
   * Онлайн-бронь (states-and-rules §3.4, «— → new»): телефон и согласие на передачу этому партнёру (BR-29), слот из
   * правил ресурса в будущем и в горизонте, людей ≤ вместимость, порог no_show (D-44 А) и лимит неподтверждённых.
   * new — технический статус (C-14): в той же транзакции система переводит бронь в pending_partner со сроком ответа
   * (D-43) или в confirmed при автоподтверждении ресурса.
   */
  async create(userId: string, input: CreateBookingDto): Promise<BookingDto> {
    const { dto, regionId, notify, booking } = await this.inRegion(input.regionId, async (region) => {
      const resource = await this.bookableResource(input.resourceId);
      if (!input.phoneShareConsent)
        throw unprocessable("errors.booking.phoneConsentRequired", "phone_consent_required");
      const user = (await this.repo.users([userId])).get(userId);
      if (!user) throw new ApiError("UNAUTHENTICATED");
      if (user.booking_no_show_count >= BOOKING_PARAMS.noShowLimit)
        throw unprocessable("errors.booking.noShowLimit", "no_show_limit");
      if (input.peopleCount > resource.capacity_people)
        throw unprocessable("errors.booking.capacityExceeded", "capacity_exceeded", {
          capacity: resource.capacity_people,
        });
      if ((await this.repo.countUnconfirmed(userId)) >= BOOKING_PARAMS.maxUnconfirmedPerUser)
        throw unprocessable("errors.booking.tooManyPending", "too_many_pending");
      const now = this.now();
      const rules = (await this.repo.rulesOf([resource.id])).get(resource.id) ?? [];
      const slot = findSlot(resource, rules, new Date(input.startsAt), region.timezone, now);
      if (!slot) throw unprocessable("errors.booking.slotUnavailable", "slot_unavailable");
      const entryContextId =
        input.entryContextId && (await this.repo.entryContextOf(input.entryContextId, userId))
          ? input.entryContextId
          : null;
      const consentId = await this.repo.insertPhoneConsent({
        user_id: userId,
        organization_id: resource.organization_id,
        place_id: resource.place_id,
        document_version: PHONE_SHARE_CONSENT_VERSION,
      });
      const created = await this.repo
        .insertBooking({
          organization_id: resource.organization_id,
          place_id: resource.place_id,
          resource_id: resource.id,
          user_id: userId,
          source: "platform",
          entry_context_id: entryContextId,
          starts_at: slot.startsAt,
          ends_at: slot.endsAt,
          occupied_from: slot.occupiedFrom,
          occupied_until: slot.occupiedUntil,
          people_count: input.peopleCount,
          comment: input.comment?.trim() || null,
          customer_name: null,
          contact_phone: input.phone,
          contact_phone_source: input.phoneSource,
          phone_consent_id: consentId,
          price_quote_minor: resource.price_minor,
          currency: resource.currency,
          status: "new",
          partner_response_due_at: null,
          confirmed_by: null,
          confirmed_at: null,
          created_by: userId,
        })
        .catch(rethrowSlotTaken);
      await this.repo.insertEvent({
        booking_id: created.id,
        from_status: null,
        to_status: "new",
        actor_type: "user",
        actor_user_id: userId,
      });
      // C-14: new → pending_partner (SYSTEM доставил партнёру) или → confirmed (автоподтверждение ресурса).
      const auto = resource.booking_mode === "auto_confirm";
      const next: BookingStatus = auto ? "confirmed" : "pending_partner";
      const updated = await this.repo.updateStatus(created.id, "new", {
        status: next,
        ...(auto
          ? { confirmed_at: now }
          : { partner_response_due_at: partnerResponseDue(now, slot.startsAt, resource.confirm_sla_min) }),
      });
      if (!updated) throw new Error("Бронь не найдена сразу после создания");
      await this.repo.insertEvent({
        booking_id: created.id,
        from_status: "new",
        to_status: next,
        actor_type: "system",
        actor_user_id: null,
        reason: auto ? "auto_confirm" : "delivered_to_partner",
      });
      const partnerUsers = await this.repo.partnerUsers(resource.organization_id, resource.place_id);
      const placeName = (await this.repo.placeNames([resource.place_id])).get(resource.place_id);
      const body = [
        `Нове бронювання №${short(created.id)} — ${placeName?.uk ?? ""}`,
        `${resource.name_i18n.uk}: ${formatLocal(slot.startsAt, region.timezone)}, гостей: ${input.peopleCount}`,
        auto ? "Підтверджено автоматично." : "Підтвердіть або запропонуйте інший час.",
      ].join("\n");
      const notify = await this.notifications.enqueue(
        partnerUsers.map((u) => draft(u, BOOKING_NOTIFICATIONS.created, created.id, body)),
      );
      const [dto] = await this.toUserDtos([updated]);
      return { dto: dto!, regionId: region.id, notify, booking: updated };
    });
    this.notifications.dispatchInBackground(regionId, notify);
    await this.emit("booking_created", booking, userId, { source: "platform" });
    if (booking.status === "confirmed") await this.emit("booking_confirmed", booking, userId);
    return dto;
  }

  async myBookings(regionId: string, userId: string): Promise<BookingListDto> {
    return this.inRegion(regionId, async () => ({
      items: await this.toUserDtos(await this.repo.listByUser(userId)),
    }));
  }

  /**
   * Смена статуса (states-and-rules §3.4). Кто действует — по переходу: отмена и принятие альтернативы — турист-владелец
   * брони; остальное — партнёр с правом на место брони (RBAC: место → организация → регион). Чужая бронь — 404;
   * недопустимый переход или гонка — 409 с текущим статусом.
   */
  async updateStatus(
    userId: string,
    id: string,
    input: UpdateBookingStatusDto,
    meta: BookingAuditMeta,
  ): Promise<BookingDto | PartnerBookingDto> {
    const grants = await this.activeGrants(userId);
    const result = await this.inRegion(input.regionId, async (region) => {
      const row = await this.repo.findBooking(id, true);
      if (!row) throw notFound();
      const chain = bookingChain(row);
      const now = this.now();
      const isOwner = row.user_id === userId;
      const canRead = findGrant(grants, "booking.read", chain, now) !== undefined;
      if (!isOwner && !canRead) throw notFound();
      const to: BookingStatus = input.status;
      const actor = transitionActor(row.status, to);
      if (!actor) throw transitionError(row.status, to);
      let grant: Grant | undefined;
      if (actor === "user") {
        if (!isOwner) throw new ApiError("FORBIDDEN", { details: { reason: "not_booking_owner" } });
      } else {
        grant = findGrant(grants, partnerPermission(row.status, to), chain, now);
        if (!grant) throw new ApiError("FORBIDDEN", { details: { reason: "role_forbidden" } });
      }
      const resource = await this.repo.findResource(row.resource_id);
      if (!resource) throw notFound();
      const reason = input.reason?.trim() || null;
      const patch = this.transitionPatch(
        row,
        to,
        { reason, alternativeStartsAt: input.alternativeStartsAt },
        {
          resource,
          now,
          userId,
        },
      );
      const updated = await this.repo.updateStatus(row.id, row.status, patch).catch(rethrowSlotTaken);
      if (!updated) throw transitionError((await this.repo.findBooking(row.id))?.status ?? row.status, to);
      await this.repo.insertEvent({
        booking_id: row.id,
        from_status: row.status,
        to_status: to,
        actor_type: actor === "user" ? "user" : "staff",
        actor_user_id: userId,
        role_assignment_id: grant?.id ?? null,
        reason,
        payload:
          to === "alternative_proposed"
            ? {
                alternativeStartsAt: updated.alternative_starts_at!.toISOString(),
                alternativeEndsAt: updated.alternative_ends_at!.toISOString(),
              }
            : {},
      });
      // D-44 А: счётчик no_show пользователя; исправление no_show → completed — обратно.
      if (row.user_id && to === "no_show") await this.repo.adjustNoShow(row.user_id, 1);
      if (row.user_id && row.status === "no_show" && to === "completed")
        await this.repo.adjustNoShow(row.user_id, -1);
      // AuditLog — действия партнёра (влияют на клиента и рейтинг, C-27); причина — только в истории брони (свободный
      // текст может содержать ПДн), как в заявках гостиницы.
      if (actor === "partner")
        await this.audit.record(currentDb(this.db), {
          ...meta,
          roleAssignmentId: grant!.id,
          action: BOOKING_AUDIT.status,
          entityType: BOOKING_ENTITY,
          entityId: row.id,
          oldValues: { status: row.status },
          newValues: { status: to },
          reason: null,
          regionId: row.region_id,
        });
      const notify = await this.notifyStatus(updated, actor, region.timezone);
      const dto =
        actor === "user"
          ? (await this.toUserDtos([updated]))[0]!
          : (await this.toPartnerDtos([updated], grants))[0]!;
      return { dto, notify, booking: updated, from: row.status, actor };
    });
    this.notifications.dispatchInBackground(result.booking.region_id, result.notify);
    await this.emitTransition(result.booking, result.from, result.actor, userId);
    return result.dto;
  }

  // --- партнёр: брони (P04, P05) ---

  async partnerList(userId: string, q: PartnerBookingsQueryDto): Promise<PartnerBookingListDto> {
    const grants = await this.activeGrants(userId);
    let places = await this.partnerPlaces(grants, "booking.read");
    if (places.length === 0) throw new ApiError("FORBIDDEN", { details: { reason: "not_partner" } });
    if (q.placeId) {
      places = places.filter((p) => p.placeId === q.placeId!.toLowerCase());
      if (places.length === 0) throw new ApiError("FORBIDDEN", { details: { reason: "not_partner" } });
    }
    const items: PartnerBookingDto[] = [];
    for (const [regionId, list] of groupBy(places, (p) => p.regionId))
      await withTenant(this.db, regionContext(regionId), async () => {
        const rows = await this.repo.listByPlaces(
          list.map((p) => p.placeId),
          {
            status: q.status,
            from: q.from ? new Date(q.from) : undefined,
            to: q.to ? new Date(q.to) : undefined,
          },
        );
        items.push(...(await this.toPartnerDtos(rows, grants)));
      });
    items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    return { items };
  }

  /**
   * Ручная запись партнёра (P04; states-and-rules §3.4 «— → confirmed»): сразу confirmed, тот же механизм занятости
   * BR-08 (конкурирует с онлайн-бронью на равных; занятый интервал — 409). Данные клиента вводит партнёр.
   */
  async createManual(
    userId: string,
    input: CreateManualBookingDto,
    meta: BookingAuditMeta,
  ): Promise<PartnerBookingDto> {
    const grants = await this.activeGrants(userId);
    const { resource, grant } = await this.locateResource(grants, input.resourceId, "booking.manual.create");
    const startsAt = new Date(input.startsAt);
    const endsAt = input.endsAt
      ? new Date(input.endsAt)
      : new Date(startsAt.getTime() + resource.slot_duration_min * MIN);
    const duration = endsAt.getTime() - startsAt.getTime();
    if (duration <= 0 || duration > BOOKING_PARAMS.manualMaxDurationMin * MIN)
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          fields: [{ field: "endsAt", constraint: "interval", messageKey: "errors.validation.interval" }],
        },
      });
    if (input.peopleCount > resource.capacity_people)
      throw unprocessable("errors.booking.capacityExceeded", "capacity_exceeded", {
        capacity: resource.capacity_people,
      });
    const source = input.source ?? "manual";
    const { dto, booking } = await withTenant(this.db, regionContext(resource.region_id), async () => {
      const now = this.now();
      const occ = occupiedRange(startsAt, endsAt, resource);
      const created = await this.repo
        .insertBooking({
          organization_id: resource.organization_id,
          place_id: resource.place_id,
          resource_id: resource.id,
          user_id: null,
          source,
          entry_context_id: null,
          starts_at: startsAt,
          ends_at: endsAt,
          occupied_from: occ.from,
          occupied_until: occ.until,
          people_count: input.peopleCount,
          comment: input.comment?.trim() || null,
          customer_name: input.customerName.trim(),
          contact_phone: input.customerPhone ?? null,
          contact_phone_source: input.customerPhone ? "partner" : null,
          phone_consent_id: null,
          price_quote_minor: resource.price_minor,
          currency: resource.currency,
          status: "confirmed",
          partner_response_due_at: null,
          confirmed_by: userId,
          confirmed_at: now,
          created_by: userId,
        })
        .catch(rethrowSlotTaken);
      await this.repo.insertEvent({
        booking_id: created.id,
        from_status: null,
        to_status: "confirmed",
        actor_type: "staff",
        actor_user_id: userId,
        role_assignment_id: grant.id,
        payload: { source },
      });
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant.id,
        action: BOOKING_AUDIT.manualCreate,
        entityType: BOOKING_ENTITY,
        entityId: created.id,
        newValues: {
          resourceId: resource.id,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          source,
        },
        regionId: resource.region_id,
      });
      return { dto: (await this.toPartnerDtos([created], grants))[0]!, booking: created };
    });
    await this.emit("booking_created", booking, userId, { source });
    return dto;
  }

  // --- партнёр: ресурсы и доступность ---

  async partnerResources(userId: string, placeId: string): Promise<PartnerResourceListDto> {
    const grants = await this.activeGrants(userId);
    const place = (await this.partnerPlaces(grants, "booking.read")).find(
      (p) => p.placeId === placeId.toLowerCase(),
    );
    if (!place) throw new ApiError("FORBIDDEN", { details: { reason: "not_partner" } });
    return withTenant(this.db, regionContext(place.regionId), async () => {
      const region = await this.regionOf(place.regionId);
      const resources = await this.repo.resourcesOfPlaces([place.placeId]);
      return { items: await this.toPartnerResources(resources, region.timezone) };
    });
  }

  async createResource(
    userId: string,
    input: CreateResourceDto,
    meta: BookingAuditMeta,
  ): Promise<PartnerResourceDto> {
    const grants = await this.activeGrants(userId);
    const place = (await this.partnerPlaces(grants, "resource.manage")).find(
      (p) => p.placeId === input.placeId.toLowerCase(),
    );
    if (!place) throw new ApiError("FORBIDDEN", { details: { reason: "role_forbidden" } });
    const grant = findGrant(grants, "resource.manage", placeChain(place), this.now())!;
    return withTenant(this.db, regionContext(place.regionId), async () => {
      const region = await this.regionOf(place.regionId);
      const created = await this.repo
        .insertResource({
          ...resourceWrite(input),
          organization_id: place.organizationId,
          place_id: place.placeId,
          name_i18n: toLocalized(input.name),
          created_by: userId,
        })
        .catch(rethrowResourceCheck);
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant.id,
        action: BOOKING_AUDIT.resourceCreate,
        entityType: RESOURCE_ENTITY,
        entityId: created.id,
        newValues: resourceSnapshot(created),
        regionId: created.region_id,
      });
      return (await this.toPartnerResources([created], region.timezone))[0]!;
    });
  }

  async updateResource(
    userId: string,
    id: string,
    input: UpdateResourceDto,
    meta: BookingAuditMeta,
  ): Promise<PartnerResourceDto> {
    const grants = await this.activeGrants(userId);
    const { resource, grant } = await this.locateResource(grants, id, "resource.manage");
    return withTenant(this.db, regionContext(resource.region_id), async () => {
      const region = await this.regionOf(resource.region_id);
      const patch: ResourceWrite = { ...resourceWrite(input) };
      if (input.name) patch.name_i18n = toLocalized(input.name);
      if (input.status) patch.status = input.status;
      const updated = await this.repo.updateResource(resource.id, patch).catch(rethrowResourceCheck);
      if (!updated) throw notFound();
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant.id,
        action: BOOKING_AUDIT.resourceUpdate,
        entityType: RESOURCE_ENTITY,
        entityId: resource.id,
        oldValues: resourceSnapshot(resource),
        newValues: resourceSnapshot(updated),
        regionId: resource.region_id,
      });
      return (await this.toPartnerResources([updated], region.timezone))[0]!;
    });
  }

  async putAvailability(
    userId: string,
    id: string,
    input: PutAvailabilityDto,
    meta: BookingAuditMeta,
  ): Promise<PartnerResourceDto> {
    const grants = await this.activeGrants(userId);
    const { resource, grant } = await this.locateResource(grants, id, "availability.edit");
    const rules = input.rules.map(toRuleInput);
    const problems = [
      ...rules.flatMap((r, i) => (ruleShapeOk(r) ? [] : [`rules[${i}]: invalid`])),
      ...rulesProblems(rules),
    ];
    if (problems.length > 0)
      throw new ApiError("UNPROCESSABLE", {
        messageKey: "errors.resource.rulesInvalid",
        details: { reason: "rules_invalid", problems },
      });
    return withTenant(this.db, regionContext(resource.region_id), async () => {
      const region = await this.regionOf(resource.region_id);
      const locked = await this.repo.findResource(resource.id, true);
      if (!locked) throw notFound();
      await this.repo.replaceRules(resource.id, rules);
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant.id,
        action: BOOKING_AUDIT.availabilityUpdate,
        entityType: RESOURCE_ENTITY,
        entityId: resource.id,
        newValues: { rules: rules.length },
        regionId: resource.region_id,
      });
      return (await this.toPartnerResources([locked], region.timezone))[0]!;
    });
  }

  /**
   * Ручной статус «Доступно зараз» (BR-04, D-78 — принята рекомендация А: короткий TTL, ставят ORG_MANAGER и
   * ORG_STAFF с правом на место, с журналом — AuditLog).
   */
  async putManualAvailability(
    userId: string,
    id: string,
    input: PutManualAvailabilityDto,
    meta: BookingAuditMeta,
  ): Promise<PartnerResourceDto> {
    const grants = await this.activeGrants(userId);
    const { resource, grant } = await this.locateResource(grants, id, "availability.status.manual");
    return withTenant(this.db, regionContext(resource.region_id), async () => {
      const region = await this.regionOf(resource.region_id);
      const now = this.now();
      const ttl = input.ttlMinutes ?? BOOKING_PARAMS.manualTtlDefaultMin;
      const value =
        input.status === "unknown"
          ? { status: input.status, expiresAt: null, setBy: null, setAt: null }
          : {
              status: input.status,
              expiresAt: new Date(now.getTime() + ttl * MIN),
              setBy: userId,
              setAt: now,
            };
      const updated = await this.repo.setManualAvailability(resource.id, value);
      if (!updated) throw notFound();
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant.id,
        action: BOOKING_AUDIT.manualStatus,
        entityType: RESOURCE_ENTITY,
        entityId: resource.id,
        oldValues: {
          status: resource.manual_availability,
          expiresAt: resource.manual_availability_expires_at?.toISOString() ?? null,
        },
        newValues: { status: value.status, expiresAt: value.expiresAt?.toISOString() ?? null },
        regionId: resource.region_id,
      });
      return (await this.toPartnerResources([updated], region.timezone))[0]!;
    });
  }

  // --- внутреннее ---

  /** Поля перехода (guards states-and-rules §3.4) — без записи. */
  private transitionPatch(
    row: Booking,
    to: BookingStatus,
    input: { reason: string | null; alternativeStartsAt?: string },
    ctx: { resource: Resource; now: Date; userId: string },
  ): BookingPatch {
    const { resource, now } = ctx;
    const closed = { closed_at: now, status_reason: input.reason };
    switch (to) {
      case "confirmed": {
        if (row.status === "alternative_proposed") {
          // D-66: принять можно до срока ответа; время брони = предложенный слот (он уже удержан этой бронью).
          if (!row.customer_response_due_at || row.customer_response_due_at <= now)
            throw transitionError(row.status, to);
          return {
            status: "confirmed",
            starts_at: row.alternative_starts_at!,
            ends_at: row.alternative_ends_at!,
            alternative_starts_at: null,
            alternative_ends_at: null,
            customer_response_due_at: null,
            confirmed_at: now,
          };
        }
        return { status: "confirmed", confirmed_by: ctx.userId, confirmed_at: now };
      }
      case "alternative_proposed": {
        if (!input.alternativeStartsAt)
          throw new ApiError("VALIDATION_FAILED", {
            details: {
              fields: [
                {
                  field: "alternativeStartsAt",
                  constraint: "isDefined",
                  messageKey: "errors.validation.isDefined",
                },
              ],
            },
          });
        const startsAt = new Date(input.alternativeStartsAt);
        const endsAt = new Date(startsAt.getTime() + (row.ends_at.getTime() - row.starts_at.getTime()));
        const respondBy = startsAt > now ? customerResponseDue(now, startsAt) : null;
        if (!respondBy) throw unprocessable("errors.booking.alternativeTooLate", "alternative_too_late");
        // Исходный слот освобождается, занятость — из предложенного интервала (states-and-rules §3.3).
        const occ = occupiedRange(startsAt, endsAt, resource);
        return {
          status: "alternative_proposed",
          alternative_starts_at: startsAt,
          alternative_ends_at: endsAt,
          customer_response_due_at: respondBy,
          occupied_from: occ.from,
          occupied_until: occ.until,
          partner_response_due_at: null,
          status_reason: input.reason,
        };
      }
      case "cancelled_by_partner":
        if (!input.reason)
          throw new ApiError("VALIDATION_FAILED", {
            messageKey: "errors.booking.reasonRequired",
            details: {
              fields: [
                { field: "reason", constraint: "isDefined", messageKey: "errors.validation.isDefined" },
              ],
            },
          });
        return { status: to, ...closed, ...clearAlternative(row) };
      case "cancelled_by_user":
        return { status: to, ...closed, ...clearAlternative(row) };
      case "completed": {
        if (now < row.starts_at) throw unprocessable("errors.booking.notStarted", "not_started");
        if (
          row.status === "no_show" &&
          (!row.closed_at ||
            now.getTime() - row.closed_at.getTime() > BOOKING_PARAMS.noShowCorrectionHours * HOUR)
        )
          throw new ApiError("CONFLICT", {
            messageKey: "errors.booking.correctionWindow",
            details: { reason: "correction_window_passed", currentStatus: row.status },
          });
        // D-45 А: комиссии за бронь нет — проводок ledger при completed не создаётся.
        return { status: to, completed_at: now, closed_at: now, status_reason: input.reason };
      }
      case "no_show":
        if (now.getTime() < row.starts_at.getTime() + BOOKING_PARAMS.noShowGraceMin * MIN)
          throw unprocessable("errors.booking.notStarted", "not_started");
        return { status: to, ...closed };
      default:
        throw transitionError(row.status, to);
    }
  }

  private async notifyStatus(b: Booking, actor: "user" | "partner", timeZone: string): Promise<string[]> {
    const [places, resources] = await Promise.all([
      this.repo.placeNames([b.place_id]),
      this.repo.resourceNames([b.resource_id]),
    ]);
    const where = `${places.get(b.place_id)?.uk ?? ""} — ${resources.get(b.resource_id)?.uk ?? ""}`;
    const when =
      b.status === "alternative_proposed"
        ? `Пропонуємо: ${formatLocal(b.alternative_starts_at!, timeZone)}`
        : formatLocal(b.starts_at, timeZone);
    const body = `Бронювання №${short(b.id)} (${where}, ${when}): ${STATUS_TEXT[b.status]}${
      b.status_reason && b.status === "cancelled_by_partner" ? `. Причина: ${b.status_reason}` : ""
    }`;
    const recipients =
      actor === "partner"
        ? b.user_id
          ? [b.user_id]
          : []
        : await this.repo.partnerUsers(b.organization_id, b.place_id);
    return this.notifications.enqueue(
      recipients.map((u) => draft(u, BOOKING_NOTIFICATIONS.status, b.id, body)),
    );
  }

  /** Активный ресурс опубликованного места; иначе 404. */
  private async bookableResource(resourceId: string): Promise<Resource> {
    const resource = await this.repo.findResource(resourceId);
    if (resource?.status !== "active") throw notFound();
    const place = await this.repo.findPlace(resource.place_id);
    if (place?.status !== "published") throw notFound();
    return resource;
  }

  /** «Доступно зараз» ресурсов: свободные слоты сегодня и завтра (горизонт «зараз» может перейти полночь). */
  private async availabilityOf(
    resources: readonly Resource[],
    timeZone: string,
  ): Promise<Map<string, AvailabilityNow>> {
    const out = new Map<string, AvailabilityNow>();
    if (resources.length === 0) return out;
    const now = this.now();
    const ids = resources.map((r) => r.id);
    const rules = await this.repo.rulesOf(ids);
    const busy = await this.repo.busyRanges(
      ids,
      new Date(now.getTime() - 24 * HOUR),
      new Date(now.getTime() + 48 * HOUR),
    );
    const today = localDate(now, timeZone);
    for (const r of resources) {
      const slots = generateSlots(r, rules.get(r.id) ?? [], today, 2, timeZone, now);
      const free = slots.filter((s) => isFree(s, busy.get(r.id) ?? []));
      out.set(
        r.id,
        availabilityNow(
          { status: r.manual_availability, expiresAt: r.manual_availability_expires_at },
          free,
          now,
        ),
      );
    }
    return out;
  }

  private async toPartnerResources(
    resources: readonly Resource[],
    timeZone: string,
  ): Promise<PartnerResourceDto[]> {
    const [availability, rules] = await Promise.all([
      this.availabilityOf(resources, timeZone),
      this.repo.rulesOf(resources.map((r) => r.id)),
    ]);
    return resources.map((r) => ({
      ...toResourceDto(r, availability.get(r.id)!),
      organizationId: r.organization_id,
      status: r.status,
      bufferBeforeMin: r.buffer_before_min,
      bufferAfterMin: r.buffer_after_min,
      leadTimeMin: r.lead_time_min,
      horizonDays: r.horizon_days,
      confirmSlaMin: r.confirm_sla_min,
      manualAvailability: r.manual_availability,
      rules: (rules.get(r.id) ?? []).map((x) => ({
        dayOfWeek: x.dayOfWeek,
        date: x.date,
        closed: x.closed,
        opensAt: x.opensMin === null ? null : hhmm(x.opensMin),
        closesAt: x.closesMin === null ? null : hhmm(x.closesMin),
      })),
      version: r.version,
      updatedAt: r.updated_at.toISOString(),
    }));
  }

  private async toUserDtos(rows: readonly Booking[]): Promise<BookingDto[]> {
    const ctx = await this.dtoContext(rows);
    return rows.map((b) =>
      toBookingDto(b, ctx, userTransitions(b.status).filter(isTarget) as BookingTargetStatus[]),
    );
  }

  /**
   * Брони для партнёра: доступные переходы — по его правам на место; телефон — только при действующем согласии на
   * передачу этому партнёру (D-42, BR-29) и праве booking.admin.read (кассиру — нет, C-20); у ручной записи — введённый
   * партнёром. До pending_partner (статус new) телефон партнёру не показывается.
   */
  private async toPartnerDtos(
    rows: readonly Booking[],
    grants: readonly Grant[],
  ): Promise<PartnerBookingDto[]> {
    const ctx = await this.dtoContext(rows);
    const consents = await this.repo.activeConsents(
      rows.flatMap((b) => (b.phone_consent_id ? [b.phone_consent_id] : [])),
    );
    const users = await this.repo.users(rows.flatMap((b) => (b.user_id ? [b.user_id] : [])));
    const now = this.now();
    return rows.map((b) => {
      const chain = bookingChain(b);
      const transitions = partnerTransitions(b.status)
        .filter((to) => findGrant(grants, partnerPermission(b.status, to), chain, now) !== undefined)
        .filter(isTarget) as BookingTargetStatus[];
      const seesPhone = findGrant(grants, "booking.admin.read", chain, now) !== undefined;
      const phone =
        b.source === "platform"
          ? seesPhone && b.status !== "new" && b.phone_consent_id && consents.has(b.phone_consent_id)
            ? b.contact_phone
            : null
          : seesPhone
            ? b.contact_phone
            : null;
      return {
        ...toBookingDto(b, ctx, transitions),
        organizationId: b.organization_id,
        source: b.source,
        customerName: b.customer_name ?? (b.user_id ? (users.get(b.user_id)?.display_name ?? null) : null),
        contactPhone: phone,
      };
    });
  }

  private async dtoContext(rows: readonly Booking[]): Promise<DtoContext> {
    const [places, resources, events] = await Promise.all([
      this.repo.placeNames(rows.map((r) => r.place_id)),
      this.repo.resourceNames(rows.map((r) => r.resource_id)),
      this.repo.events(rows.map((r) => r.id)),
    ]);
    return { places, resources, events };
  }

  private async activeGrants(userId: string): Promise<Grant[]> {
    const now = this.now();
    return (await this.rbac.grantsOf(userId)).filter((g) => isGrantActive(g, now));
  }

  /**
   * Места партнёра с правом: назначения PLACE (место партнёра) и ORGANIZATION — все места организации. Только места
   * организаций (у ресурса и брони обязательна организация).
   */
  private async partnerPlaces(grants: readonly Grant[], permission: PermissionCode): Promise<PartnerPlace[]> {
    const usable = grants.filter(
      (g) =>
        (g.scopeType === "ORGANIZATION" || g.scopeType === "PLACE") &&
        g.scopeId &&
        g.regionId &&
        roleHasPermission(g.role, permission),
    );
    const out = new Map<string, PartnerPlace>();
    for (const [regionId, list] of groupBy(usable, (g) => g.regionId!.toLowerCase()))
      await withTenant(this.db, regionContext(regionId), async () => {
        const orgIds = list
          .filter((g) => g.scopeType === "ORGANIZATION")
          .map((g) => g.scopeId!.toLowerCase());
        for (const p of await this.repo.placesOfOrganizations(orgIds))
          out.set(p.id, { placeId: p.id, organizationId: p.organization_id, regionId });
        for (const g of list.filter((x) => x.scopeType === "PLACE")) {
          const placeId = g.scopeId!.toLowerCase();
          if (out.has(placeId)) continue;
          const place = await this.repo.findPlace(placeId);
          if (place?.organization_id)
            out.set(placeId, { placeId, organizationId: place.organization_id, regionId });
        }
      });
    return [...out.values()];
  }

  /**
   * Ресурс по id в регионах назначений пользователя и право на его место. Не найден ни в одном — 404; найден, но без
   * права — 403 (нет даже booking.read — 404: не раскрываем чужие ресурсы).
   */
  private async locateResource(
    grants: readonly Grant[],
    resourceId: string,
    permission: PermissionCode,
  ): Promise<{ resource: Resource; grant: Grant }> {
    const regions = [...new Set(grants.flatMap((g) => (g.regionId ? [g.regionId.toLowerCase()] : [])))];
    const now = this.now();
    for (const regionId of regions) {
      const resource = await withTenant(this.db, regionContext(regionId), () =>
        this.repo.findResource(resourceId),
      );
      if (!resource) continue;
      const chain = placeChain({
        placeId: resource.place_id,
        organizationId: resource.organization_id,
        regionId: resource.region_id,
      });
      const grant = findGrant(grants, permission, chain, now);
      if (grant) return { resource, grant };
      if (findGrant(grants, "booking.read", chain, now))
        throw new ApiError("FORBIDDEN", { details: { reason: "role_forbidden" } });
      throw notFound();
    }
    throw notFound();
  }

  private async regionOf(regionId: string): Promise<Region> {
    const region = await this.regions.findById(regionId);
    if (!region) throw notFound();
    return region;
  }

  /** Активный регион или 404; fn — в транзакции с контекстом региона. */
  private async inRegion<T>(regionId: string, fn: (region: Region) => Promise<T>): Promise<T> {
    const region = await this.regions.findById(regionId.toLowerCase());
    if (region?.status !== "active") throw notFound();
    const tenant = currentTenant();
    if (tenant?.kind === "region" && tenant.regionId === region.id) return fn(region);
    return withTenant(this.db, regionContext(region.id), () => fn(region));
  }

  private async emitTransition(
    b: Booking,
    from: BookingStatus,
    actor: "user" | "partner",
    userId: string,
  ): Promise<void> {
    switch (b.status) {
      case "confirmed":
        return this.emit("booking_confirmed", b, userId);
      case "completed":
        return this.emit("booking_completed", b, userId);
      case "no_show":
        return this.emit("booking_no_show", b, userId);
      case "alternative_proposed":
        return this.emit("booking_alternative_proposed", b, userId);
      case "cancelled_by_user":
      case "cancelled_by_partner":
        return this.emit("booking_cancelled", b, userId, {
          cancelledBy: actor === "user" ? "guest" : "partner",
        });
      default:
        this.logger.debug?.(`Переход ${from} → ${b.status} без события аналитики`);
    }
  }

  /**
   * Событие booking_* после коммита (ошибка аналитики не ломает операцию). Псевдоним — клиента брони (воронка
   * туриста), у ручной записи — автора-партнёра.
   */
  private async emit(
    event:
      | "booking_created"
      | "booking_confirmed"
      | "booking_completed"
      | "booking_no_show"
      | "booking_alternative_proposed"
      | "booking_cancelled",
    b: Booking,
    actorUserId: string,
    extra: JsonObject = {},
  ): Promise<void> {
    if (!this.analytics) return;
    try {
      const subject = b.user_id ?? actorUserId;
      const user = await withTenant(this.db, regionContext(b.region_id), async () =>
        (await this.repo.users([subject])).get(subject),
      );
      if (!user) return;
      await this.analytics.emit({
        eventId: uuidv7(),
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        occurredAt: this.now().toISOString(),
        pseudonymousUserId: user.analytics_id,
        regionId: b.region_id,
        source: b.source === "platform" ? "direct" : "system",
        entryContextId: b.entry_context_id,
        placeId: b.place_id,
        event,
        props: { bookingId: b.id, placeId: b.place_id, ...extra },
      } as AnalyticsEvent);
    } catch (err) {
      this.logger.warn(`Событие ${event} не записано: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// --- преобразования ---

type DtoContext = {
  places: Map<string, LocalizedText>;
  resources: Map<string, LocalizedText>;
  events: Map<string, BookingEvent[]>;
};

const TARGETS: ReadonlySet<string> = new Set([
  "confirmed",
  "alternative_proposed",
  "cancelled_by_user",
  "cancelled_by_partner",
  "completed",
  "no_show",
]);
const isTarget = (s: BookingStatus) => TARGETS.has(s);

function toBookingDto(b: Booking, ctx: DtoContext, transitions: BookingTargetStatus[]): BookingDto {
  return {
    id: b.id,
    regionId: b.region_id,
    placeId: b.place_id,
    placeName: ctx.places.get(b.place_id) ?? { uk: "" },
    resourceId: b.resource_id,
    resourceName: ctx.resources.get(b.resource_id) ?? { uk: "" },
    status: b.status,
    statusReason: b.status_reason,
    startsAt: b.starts_at.toISOString(),
    endsAt: b.ends_at.toISOString(),
    peopleCount: b.people_count,
    comment: b.comment,
    alternative:
      b.status === "alternative_proposed" && b.alternative_starts_at && b.alternative_ends_at
        ? {
            startsAt: b.alternative_starts_at.toISOString(),
            endsAt: b.alternative_ends_at.toISOString(),
            respondBy: b.customer_response_due_at!.toISOString(),
          }
        : null,
    partnerResponseDueAt: b.partner_response_due_at?.toISOString() ?? null,
    allowedTransitions: transitions,
    history: (ctx.events.get(b.id) ?? []).map((e) => ({
      fromStatus: e.from_status,
      toStatus: e.to_status,
      actor: e.actor_type,
      reason: e.reason,
      at: e.created_at.toISOString(),
    })),
    createdAt: b.created_at.toISOString(),
    updatedAt: b.updated_at.toISOString(),
  };
}

function toAvailabilityDto(a: AvailabilityNow): AvailabilityNowDto {
  return {
    availableNow: a.availableNow,
    source: a.source,
    manualExpiresAt: a.manualExpiresAt?.toISOString() ?? null,
  };
}

function toResourceDto(r: Resource, availability: AvailabilityNow): ResourceDto {
  return {
    id: r.id,
    regionId: r.region_id,
    placeId: r.place_id,
    name: r.name_i18n,
    description: r.description_i18n,
    capacityPeople: r.capacity_people,
    slotDurationMin: r.slot_duration_min,
    bookingMode: r.booking_mode,
    priceMinor: r.price_minor === null ? null : Number(r.price_minor),
    currency: r.currency,
    availability: toAvailabilityDto(availability),
  };
}

function resourceWrite(input: UpdateResourceDto | CreateResourceDto): ResourceWrite {
  const w: ResourceWrite = {};
  if (input.description !== undefined)
    w.description_i18n = input.description === null ? null : toLocalized(input.description);
  if (input.capacityPeople !== undefined) w.capacity_people = input.capacityPeople;
  if (input.slotDurationMin !== undefined) w.slot_duration_min = input.slotDurationMin;
  if (input.bufferBeforeMin !== undefined) w.buffer_before_min = input.bufferBeforeMin;
  if (input.bufferAfterMin !== undefined) w.buffer_after_min = input.bufferAfterMin;
  if (input.leadTimeMin !== undefined) w.lead_time_min = input.leadTimeMin;
  if (input.horizonDays !== undefined) w.horizon_days = input.horizonDays;
  if (input.confirmSlaMin !== undefined) w.confirm_sla_min = input.confirmSlaMin;
  if (input.bookingMode !== undefined) w.booking_mode = input.bookingMode;
  if (input.priceMinor !== undefined) w.price_minor = input.priceMinor;
  if (input.currency !== undefined) w.currency = input.currency;
  return w;
}

function resourceSnapshot(r: Resource): JsonObject {
  return {
    status: r.status,
    capacityPeople: r.capacity_people,
    slotDurationMin: r.slot_duration_min,
    bufferBeforeMin: r.buffer_before_min,
    bufferAfterMin: r.buffer_after_min,
    bookingMode: r.booking_mode,
  };
}

const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function toRuleInput(r: {
  dayOfWeek?: number | null;
  date?: string | null;
  closed?: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
}): RuleInput {
  const closed = r.closed ?? false;
  return {
    dayOfWeek: r.dayOfWeek ?? null,
    date: r.date ?? null,
    closed,
    opensMin: closed || !r.opensAt ? null : toMinutes(r.opensAt),
    closesMin: closed || !r.closesAt ? null : toMinutes(r.closesAt),
  };
}

/** Форма правила — как CHECK availability_rules (иначе 23514 → 500). */
function ruleShapeOk(r: RuleInput): boolean {
  if ((r.dayOfWeek === null) === (r.date === null)) return false;
  if (r.closed) return r.date !== null;
  return r.opensMin !== null && r.closesMin !== null && r.closesMin > r.opensMin;
}

function clearAlternative(row: Booking): Partial<BookingPatch> {
  return row.status === "alternative_proposed"
    ? { alternative_starts_at: null, alternative_ends_at: null, customer_response_due_at: null }
    : {};
}

/** Цепочка области места партнёра: PLACE → ORGANIZATION → REGION → PLATFORM (без запросов к БД). */
function placeChain(p: PartnerPlace): ScopeChain {
  return [
    scope("PLACE", p.placeId),
    scope("ORGANIZATION", p.organizationId),
    regionScope(p.regionId),
    PLATFORM_SCOPE,
  ];
}

function bookingChain(b: Booking): ScopeChain {
  return placeChain({ placeId: b.place_id, organizationId: b.organization_id, regionId: b.region_id });
}

function draft(userId: string, template: string, bookingId: string, body: string): NotificationDraft {
  return { recipientUserId: userId, template, entityType: BOOKING_ENTITY, entityId: bookingId, body };
}

function short(id: string): string {
  return id.slice(-6);
}

function formatLocal(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

function unprocessable(messageKey: string, reason: string, extra: JsonObject = {}): ApiError {
  return new ApiError("UNPROCESSABLE", { messageKey, details: { reason, ...extra } });
}

function transitionError(from: BookingStatus, to: BookingStatus): ApiError {
  return new ApiError("CONFLICT", {
    messageKey: "errors.booking.invalidTransition",
    details: { reason: "invalid_transition", from, to, currentStatus: from },
  });
}

/** Нарушение bookings_no_overlap (23P01): интервал занят другой бронью (BR-08) — 409. */
function rethrowSlotTaken(e: unknown): never {
  const { code, constraint } = (e ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === "23P01" && constraint === "bookings_no_overlap")
    throw new ApiError("CONFLICT", {
      messageKey: "errors.booking.slotTaken",
      details: { reason: "slot_taken" },
    });
  throw e;
}

/** CHECK ресурса (цена без валюты и т. п.) — 422. */
function rethrowResourceCheck(e: unknown): never {
  const { code, constraint } = (e ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === "23514")
    throw new ApiError("UNPROCESSABLE", {
      details: { reason: "invalid_resource", constraint: typeof constraint === "string" ? constraint : null },
    });
  throw e;
}
