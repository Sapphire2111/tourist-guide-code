import { Inject, Injectable } from "@nestjs/common";
import { ApiError, toLocalized } from "../../common/http/index.js";
import {
  currentDb,
  currentTenant,
  InjectDb,
  regionContext,
  withTenant,
  type Db,
  type HostModule,
  type HostSectionRecord,
  type HostServiceRecord,
  type JsonObject,
  type LocalizedText,
  type Region,
  type RoomSource,
  type ServiceRequest,
  type ServiceRequestEvent,
  type ServiceRequestStatus,
} from "../../db/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import { localMoment } from "../guide/index.js";
import {
  isGrantActive,
  RbacService,
  roleHasPermission,
  scope,
  type Grant,
  type PermissionCode,
} from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import { RoleAssignmentError, RoleAssignmentService } from "../role-assignments/index.js";
import type {
  AdminHostModuleDto,
  AssignPlaceStaffDto,
  CreateServiceRequestDto,
  HostModuleDto,
  HostSectionKind,
  PlaceStaffListDto,
  PlaceStaffMemberDto,
  PlaceStaffRole,
  PutHostModuleDto,
  ServiceRequestDto,
  ServiceRequestListDto,
  StaffPlaceListDto,
  StaffServiceRequestDto,
  StaffServiceRequestListDto,
  StaffTargetStatus,
} from "./host.dto.js";
import { PLACE_STAFF_ROLES } from "./host.dto.js";
import { HostRepository } from "./host.repository.js";
import { NOTIFICATION_TEMPLATES, NotificationsService, type NotificationDraft } from "./notifications.js";
import {
  canGuestCancel,
  canStaffMove,
  isOverdue,
  nextOpening,
  slaDueAt,
  staffTransitions,
} from "./service-request-rules.js";

export const SERVICE_REQUEST_ENTITY = "service_request";
export const HOST_AUDIT = {
  status: "service_request.status",
  moduleUpdate: "host_module.update",
} as const;

type AuditMeta = Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">;

/** Место сотрудника: из назначения PLACE с правом (организаций пока нет — ADR-0020). */
type StaffPlace = { placeId: string; regionId: string; role: string; grantId: string };

const STATUS_TEXT: Readonly<Record<ServiceRequestStatus, string>> = {
  new: "нова",
  accepted: "прийнята",
  in_progress: "у роботі",
  done: "виконана",
  rejected: "відхилена",
  cancelled_by_guest: "скасована гостем",
};

const hhmm = (t: string | null) => (t === null ? null : t.slice(0, 5));

/**
 * Заявки гостиницы и «Про заклад» (блок 5; S-03, C03, C22, P10; D-49, D-55; ADR-0020). Гость — регион из запроса
 * (как каталог гида): чтение и запись в withTenant(региона). Персонал — места из своих назначений PLACE (RBAC, не из
 * запроса): чужая заявка — 404. Админ — в tenant-контексте запроса (@RequirePermission).
 */
@Injectable()
export class HostService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(HostRepository) private readonly repo: HostRepository,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(RoleAssignmentService) private readonly roles: RoleAssignmentService,
  ) {}

  /** Часы сервиса (подменяется в тестах). */
  now: () => Date = () => new Date();

  // --- гость: «Про заклад» ---

  async guestModule(
    regionId: string,
    placeId: string,
    entryContextId?: string,
    userId?: string,
  ): Promise<HostModuleDto> {
    return this.inRegion(regionId, async (region) => {
      const { place, module } = await this.publishedModule(placeId);
      const entry = await this.entryOf(entryContextId, placeId, userId);
      const fromThisPlace = entry !== undefined;
      const now = this.now();
      const hours = hoursOf(module);
      const opening = nextOpening(hours, now, region.timezone);
      return {
        placeId,
        regionId: region.id,
        placeName: place.name_i18n,
        wifi: module.wifi_ssid
          ? { ssid: module.wifi_ssid, password: fromThisPlace ? module.wifi_password : null }
          : null,
        receptionPhone: module.reception_phone,
        hours: hours ? { ...hours, timezone: region.timezone } : null,
        acceptingNow: opening === null,
        nextOpensAt: opening?.toISOString() ?? null,
        sections: [...module.sections].sort(bySort).map((s) => ({ ...s, kind: s.kind as HostSectionKind })),
        services: enabledServices(module).map((s) => ({
          code: s.code,
          title: s.title,
          description: s.description,
          slaMinutes: s.slaMinutes,
          sortOrder: s.sortOrder,
        })),
        room: entry?.room_label ? { label: entry.room_label, source: "qr" } : null,
      };
    });
  }

  // --- гость: заявки ---

  async createRequest(userId: string, input: CreateServiceRequestDto): Promise<ServiceRequestDto> {
    const { dto, regionId, notify } = await this.inRegion(input.regionId, async (region) => {
      const { place, module } = await this.publishedModule(input.placeId);
      const service = enabledServices(module).find((s) => s.code === input.serviceCode);
      if (!service)
        throw new ApiError("NOT_FOUND", {
          messageKey: "errors.serviceRequests.serviceUnavailable",
          details: { reason: "service_unavailable" },
        });
      // D-49: комната QR номера — из контекста входа (гость не меняет); на общем QR — введённая гостем.
      const entry = await this.entryOf(input.entryContextId, input.placeId, userId);
      let room: { label: string; source: RoomSource } | null = null;
      if (entry?.room_label) room = { label: entry.room_label, source: "qr" };
      else if (input.roomLabel?.trim()) room = { label: input.roomLabel.trim(), source: "guest" };
      const duplicate = await this.repo.findActiveDuplicate(input.placeId, service.code, userId);
      if (duplicate) throw duplicateError(duplicate.id);
      const now = this.now();
      const opening = nextOpening(hoursOf(module), now, region.timezone);
      const row = await this.repo
        .insertRequest({
          place_id: input.placeId,
          user_id: userId,
          entry_context_id: entry ? input.entryContextId! : null,
          service_code: service.code,
          service_title_i18n: service.title,
          room_label: room?.label ?? null,
          room_source: room?.source ?? null,
          comment: input.comment?.trim() || null,
          outside_hours: opening !== null,
          process_from: opening,
          sla_minutes: service.slaMinutes,
          sla_due_at: slaDueAt(opening ?? now, service.slaMinutes),
        })
        .catch((e: unknown) => {
          // Гонка двух одинаковых POST: уникальный индекс открытой заявки.
          if (isUniqueViolation(e, "service_requests_active_key")) throw duplicateError(null);
          throw e;
        });
      await this.repo.insertEvent({
        service_request_id: row.id,
        from_status: null,
        to_status: "new",
        actor_type: "guest",
        actor_user_id: userId,
      });
      const staff = await this.repo.staffOf(input.placeId, PLACE_STAFF_ROLES);
      const body = createdText(place.name_i18n, row, opening, region.timezone);
      const notify = await this.notifications.enqueue(
        staff.map((s) => this.draft(s.user_id, NOTIFICATION_TEMPLATES.requestCreated, row.id, body)),
      );
      const [dto] = await this.toDtos([row]);
      return { dto: dto!, regionId: region.id, notify };
    });
    this.notifications.dispatchInBackground(regionId, notify);
    return dto;
  }

  async myRequests(regionId: string, userId: string): Promise<ServiceRequestListDto> {
    return this.inRegion(regionId, async () => ({
      items: await this.toDtos(await this.repo.listByUser(userId)),
    }));
  }

  /** Отмена гостем (new, accepted); чужая заявка — 404, иначе — 409. */
  async cancel(regionId: string, userId: string, id: string, meta: AuditMeta): Promise<ServiceRequestDto> {
    const { dto, notify, region } = await this.inRegion(regionId, async (r) => {
      const row = await this.repo.findRequest(id, true);
      if (!row || row.user_id !== userId) throw new ApiError("NOT_FOUND");
      if (!canGuestCancel(row.status)) throw transitionError(row.status, "cancelled_by_guest");
      const updated = await this.transition(row, "cancelled_by_guest", {
        actorType: "guest",
        userId,
        reason: null,
        meta,
        patch: { closed_at: this.now() },
      });
      const staff = await this.repo.staffOf(row.place_id, PLACE_STAFF_ROLES);
      const names = await this.repo.placeNames([row.place_id]);
      const body = `Заявку №${short(row.id)} (${row.service_title_i18n.uk}) скасовано гостем — ${
        names.get(row.place_id)?.uk ?? ""
      }`;
      const notify = await this.notifications.enqueue(
        staff.map((s) => this.draft(s.user_id, NOTIFICATION_TEMPLATES.requestStatus, row.id, body)),
      );
      const [dto] = await this.toDtos([updated]);
      return { dto: dto!, notify, region: r.id };
    });
    this.notifications.dispatchInBackground(region, notify);
    return dto;
  }

  // --- персонал ---

  async staffPlaces(userId: string): Promise<StaffPlaceListDto> {
    const places = await this.staffPlacesOf(userId, "service_request.read");
    const items: StaffPlaceListDto["items"] = [];
    for (const [regionId, list] of groupByRegion(places)) {
      await withTenant(this.db, regionContext(regionId), async () => {
        const ids = list.map((p) => p.placeId);
        const [names, counts] = await Promise.all([this.repo.placeNames(ids), this.repo.openCounts(ids)]);
        for (const p of list) {
          const name = names.get(p.placeId);
          if (!name) continue;
          items.push({
            placeId: p.placeId,
            regionId,
            name,
            role: p.role as PlaceStaffRole,
            openRequests: counts.get(p.placeId) ?? 0,
          });
        }
      });
    }
    return { items };
  }

  async staffList(
    userId: string,
    filter: { status?: ServiceRequestStatus; placeId?: string },
  ): Promise<StaffServiceRequestListDto> {
    let places = await this.staffPlacesOf(userId, "service_request.read");
    if (places.length === 0) throw new ApiError("FORBIDDEN", { details: { reason: "not_staff" } });
    if (filter.placeId) {
      places = places.filter((p) => p.placeId === filter.placeId!.toLowerCase());
      if (places.length === 0) throw new ApiError("FORBIDDEN", { details: { reason: "not_staff" } });
    }
    const items: StaffServiceRequestDto[] = [];
    for (const [regionId, list] of groupByRegion(places))
      await withTenant(this.db, regionContext(regionId), async () => {
        const rows = await this.repo.listByPlaces(
          list.map((p) => p.placeId),
          filter.status,
        );
        items.push(...(await this.toStaffDtos(rows)));
      });
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items };
  }

  /**
   * Смена статуса персоналом. Заявка не своего места (или нет) — 404 (не раскрываем существование); недопустимый
   * переход и гонка двух сотрудников — 409 с текущим статусом. Переход — история и AuditLog; гостю — уведомление
   * при согласии на сервисные сообщения.
   */
  async staffUpdate(
    userId: string,
    id: string,
    input: { status: StaffTargetStatus; reason?: string },
    meta: AuditMeta,
  ): Promise<StaffServiceRequestDto> {
    const places = await this.staffPlacesOf(userId, "service_request.process");
    if (places.length === 0) throw new ApiError("FORBIDDEN", { details: { reason: "not_staff" } });
    // Регион заявки неизвестен до чтения: ищем в регионах своих мест (RLS — только эти регионы).
    for (const [regionId, list] of groupByRegion(places)) {
      const result = await withTenant(this.db, regionContext(regionId), async () => {
        const row = await this.repo.findRequest(id, true);
        if (!row) return undefined;
        const mine = list.find((p) => p.placeId === row.place_id);
        if (!mine) throw new ApiError("NOT_FOUND");
        if (!canStaffMove(row.status, input.status)) throw transitionError(row.status, input.status);
        const reason = input.reason?.trim() || null;
        if (input.status === "rejected" && !reason)
          throw new ApiError("VALIDATION_FAILED", {
            details: {
              fields: [
                { field: "reason", constraint: "isDefined", messageKey: "errors.validation.isDefined" },
              ],
            },
          });
        const now = this.now();
        const updated = await this.transition(row, input.status, {
          actorType: "staff",
          userId,
          reason,
          meta: { ...meta, roleAssignmentId: mine.grantId },
          patch: {
            ...(input.status === "accepted" ? { accepted_at: now, assigned_to: userId } : {}),
            ...(input.status === "in_progress" ? { started_at: now } : {}),
            ...(input.status === "done" || input.status === "rejected" ? { closed_at: now } : {}),
            ...(input.status === "rejected" ? { status_reason: reason } : {}),
          },
        });
        const names = await this.repo.placeNames([row.place_id]);
        const notify =
          updated.user_id === null
            ? []
            : await this.notifications.enqueue([
                this.draft(
                  updated.user_id,
                  NOTIFICATION_TEMPLATES.requestStatus,
                  row.id,
                  `${names.get(row.place_id)?.uk ?? "Готель"}: заявка «${row.service_title_i18n.uk}» — ${
                    STATUS_TEXT[input.status]
                  }${reason ? `. Причина: ${reason}` : ""}`,
                ),
              ]);
        const [dto] = await this.toStaffDtos([updated]);
        return { dto: dto!, notify };
      });
      if (result) {
        this.notifications.dispatchInBackground(regionId, result.notify);
        return result.dto;
      }
    }
    throw new ApiError("NOT_FOUND");
  }

  // --- админка (tenant-контекст запроса) ---

  async adminGetModule(placeId: string): Promise<AdminHostModuleDto> {
    const place = await this.repo.findPlace(placeId);
    if (!place) throw new ApiError("NOT_FOUND");
    return toAdminModule(place.id, place.region_id, await this.repo.findModule(placeId));
  }

  async adminPutModule(
    placeId: string,
    input: PutHostModuleDto,
    meta: AuditMeta,
  ): Promise<AdminHostModuleDto> {
    requireRegion();
    if (input.hours && input.hours.from === input.hours.to)
      throw new ApiError("UNPROCESSABLE", {
        messageKey: "errors.hostModule.hoursEmpty",
        details: { reason: "hours_empty" },
      });
    const place = await this.repo.findPlace(placeId);
    if (!place) throw new ApiError("NOT_FOUND");
    const codes = input.services.map((s) => s.code);
    if (new Set(codes).size !== codes.length)
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          fields: [{ field: "services", constraint: "uniqueCode", messageKey: "errors.validation.unique" }],
        },
      });
    const before = await this.repo.findModule(placeId);
    const sections: HostSectionRecord[] = input.sections.map((s, i) => ({
      kind: s.kind,
      title: toLocalized(s.title),
      content: toLocalized(s.content),
      sortOrder: s.sortOrder ?? i * 10,
    }));
    const services: HostServiceRecord[] = input.services.map((s, i) => ({
      code: s.code,
      title: toLocalized(s.title),
      description: s.description ? toLocalized(s.description) : null,
      slaMinutes: s.slaMinutes,
      enabled: s.enabled ?? true,
      sortOrder: s.sortOrder ?? i * 10,
    }));
    const after = await this.repo.upsertModule(placeId, {
      enabled: input.enabled ?? true,
      wifi_ssid: input.wifiSsid ?? null,
      wifi_password: input.wifiPassword ?? null,
      reception_phone: input.receptionPhone ?? null,
      hours_from: input.hours?.from ?? null,
      hours_to: input.hours?.to ?? null,
      sections,
      services,
      updated_by: meta.actor.type === "user" ? meta.actor.userId : null,
    });
    await this.audit.record(currentDb(this.db), {
      ...meta,
      action: HOST_AUDIT.moduleUpdate,
      entityType: "host_module",
      entityId: after.id,
      oldValues: before ? moduleSnapshot(before) : null,
      newValues: moduleSnapshot(after),
      regionId: after.region_id,
    });
    return toAdminModule(place.id, place.region_id, after);
  }

  async adminStaff(placeId: string): Promise<PlaceStaffListDto> {
    if (!(await this.repo.findPlace(placeId))) throw new ApiError("NOT_FOUND");
    const rows = await this.repo.staffOf(placeId, PLACE_STAFF_ROLES);
    return { items: rows.map(toStaffMember) };
  }

  /** Назначить сотрудника места по Telegram id или username пользователя, уже входившего в Mini App. */
  async adminAssignStaff(
    placeId: string,
    input: AssignPlaceStaffDto,
    meta: AuditMeta,
  ): Promise<PlaceStaffMemberDto> {
    requireRegion();
    if (!(await this.repo.findPlace(placeId))) throw new ApiError("NOT_FOUND");
    const user = await this.repo.findUserByTelegram(input);
    if (!user)
      throw new ApiError("NOT_FOUND", {
        messageKey: "errors.staff.userNotFound",
        details: { reason: "user_not_found" },
      });
    const role = input.role ?? "ORG_STAFF";
    try {
      await this.roles.assign(currentDb(this.db), {
        userId: user.user_id,
        role,
        scope: scope("PLACE", placeId),
        actor: meta.actor,
        actorAssignmentId: meta.roleAssignmentId ?? null,
        requestId: meta.requestId ?? null,
        reason: "place_staff",
      });
    } catch (e) {
      if (e instanceof RoleAssignmentError) {
        if (e.reason === "already_assigned")
          throw new ApiError("CONFLICT", {
            messageKey: "errors.staff.alreadyAssigned",
            details: { reason: e.reason },
          });
        if (e.reason === "role_not_assignable")
          throw new ApiError("FORBIDDEN", { details: { reason: e.reason } });
        throw new ApiError("UNPROCESSABLE", { details: { reason: e.reason } });
      }
      throw e;
    }
    const member = (await this.repo.staffOf(placeId, [role])).find((m) => m.user_id === user.user_id);
    if (!member) throw new Error("Назначение сотрудника не найдено после записи");
    return toStaffMember(member);
  }

  async adminRevokeStaff(placeId: string, assignmentId: string, meta: AuditMeta): Promise<void> {
    requireRegion();
    const members = await this.repo.staffOf(placeId, PLACE_STAFF_ROLES);
    if (!members.some((m) => m.assignment_id === assignmentId.toLowerCase())) throw new ApiError("NOT_FOUND");
    try {
      await this.roles.revoke(currentDb(this.db), {
        assignmentId,
        actor: meta.actor,
        actorAssignmentId: meta.roleAssignmentId ?? null,
        requestId: meta.requestId ?? null,
        reason: "place_staff",
      });
    } catch (e) {
      if (e instanceof RoleAssignmentError) throw new ApiError("NOT_FOUND");
      throw e;
    }
  }

  // --- внутреннее ---

  /**
   * Контекст входа по QR этого отеля (репозиторий: точка hotel этого места, активна, не старше срока). Контекст,
   * привязанный к пользователю, не используется ни другим пользователем, ни запросом без сессии (чужой пароль
   * Wi-Fi и номер); анонимный контекст (user_id NULL) — используется.
   */
  private async entryOf(entryContextId: string | undefined, placeId: string, userId: string | undefined) {
    if (!entryContextId) return undefined;
    const entry = await this.repo.entryRoom(entryContextId, placeId);
    if (!entry) return undefined;
    if (entry.user_id && entry.user_id !== userId) return undefined;
    return entry;
  }

  /** Опубликованное место с включённым модулем; иначе 404 (C03: раздел недоступен). */
  private async publishedModule(placeId: string) {
    const place = await this.repo.findPlace(placeId);
    if (place?.status !== "published") throw new ApiError("NOT_FOUND");
    const module = await this.repo.findModule(placeId);
    if (!module?.enabled) throw new ApiError("NOT_FOUND");
    return { place, module };
  }

  private async transition(
    row: ServiceRequest,
    to: ServiceRequestStatus,
    t: {
      actorType: "guest" | "staff";
      userId: string;
      reason: string | null;
      meta: AuditMeta;
      patch: Partial<Omit<Parameters<HostRepository["updateStatus"]>[2], "status">>;
    },
  ): Promise<ServiceRequest> {
    const updated = await this.repo.updateStatus(row.id, row.status, { status: to, ...t.patch });
    // Статус уже другой (гонка двух сотрудников): 409 с текущим статусом заявки.
    if (!updated) throw transitionError((await this.repo.findRequest(row.id))?.status ?? row.status, to);
    await this.repo.insertEvent({
      service_request_id: row.id,
      from_status: row.status,
      to_status: to,
      actor_type: t.actorType,
      actor_user_id: t.userId,
      reason: t.reason,
    });
    // AuditLog только дописывается и не обезличивается по сроку заявки (D-49): в него не идут свободный текст
    // (причина — только в истории заявки) и действия гостя (автор-гость — ПДн; история есть в service_request_events).
    if (t.actorType === "staff")
      await this.audit.record(currentDb(this.db), {
        ...t.meta,
        action: HOST_AUDIT.status,
        entityType: SERVICE_REQUEST_ENTITY,
        entityId: row.id,
        oldValues: { status: row.status },
        newValues: { status: to, by: t.actorType },
        reason: null,
        regionId: row.region_id,
      });
    return updated;
  }

  /** Места сотрудника с правом: назначения PLACE (действующие, роль с правом). */
  private async staffPlacesOf(userId: string, permission: PermissionCode): Promise<StaffPlace[]> {
    const grants: Grant[] = await this.rbac.grantsOf(userId);
    const now = new Date();
    const out = new Map<string, StaffPlace>();
    for (const g of grants)
      if (
        g.scopeType === "PLACE" &&
        g.scopeId &&
        g.regionId &&
        isGrantActive(g, now) &&
        roleHasPermission(g.role, permission) &&
        !out.has(g.scopeId.toLowerCase())
      )
        out.set(g.scopeId.toLowerCase(), {
          placeId: g.scopeId.toLowerCase(),
          regionId: g.regionId.toLowerCase(),
          role: g.role,
          grantId: g.id,
        });
    return [...out.values()];
  }

  private draft(userId: string, template: string, requestId: string, body: string): NotificationDraft {
    return {
      recipientUserId: userId,
      template,
      entityType: SERVICE_REQUEST_ENTITY,
      entityId: requestId,
      body,
    };
  }

  private async toDtos(rows: readonly ServiceRequest[]): Promise<ServiceRequestDto[]> {
    const now = this.now();
    const [names, events] = await Promise.all([
      this.repo.placeNames(rows.map((r) => r.place_id)),
      this.repo.events(rows.map((r) => r.id)),
    ]);
    return rows.map((r) => toRequestDto(r, names.get(r.place_id), events.get(r.id) ?? [], now));
  }

  private async toStaffDtos(rows: readonly ServiceRequest[]): Promise<StaffServiceRequestDto[]> {
    const [dtos, guests] = await Promise.all([
      this.toDtos(rows),
      this.repo.guestNames(rows.flatMap((r) => (r.user_id ? [r.user_id] : []))),
    ]);
    return dtos.map((d, i) => {
      const row = rows[i]!;
      return {
        ...d,
        guestName: row.user_id ? (guests.get(row.user_id) ?? null) : null,
        allowedTransitions: staffTransitions(row.status) as StaffTargetStatus[],
      };
    });
  }

  /** Активный регион или 404; fn — в транзакции с контекстом региона (уже открытая транзакция — в ней же). */
  private async inRegion<T>(regionId: string, fn: (region: Region) => Promise<T>): Promise<T> {
    const region = await this.regions.findById(regionId.toLowerCase());
    if (region?.status !== "active") throw new ApiError("NOT_FOUND");
    const tenant = currentTenant();
    if (tenant?.kind === "region" && tenant.regionId === region.id) return fn(region);
    return withTenant(this.db, regionContext(region.id), () => fn(region));
  }
}

// --- преобразования ---

/** Изменения админки — только в контексте региона (SUPERADMIN без выбранного региона — 403, как в каталоге). */
function requireRegion(): string {
  const tenant = currentTenant();
  if (tenant?.kind !== "region")
    throw new ApiError("FORBIDDEN", { details: { reason: "region_context_required" } });
  return tenant.regionId;
}

function bySort<T extends { sortOrder: number }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder;
}

function enabledServices(m: HostModule): HostServiceRecord[] {
  return m.services.filter((s) => s.enabled).sort(bySort);
}

function hoursOf(m: HostModule): { from: string; to: string } | null {
  return m.hours_from && m.hours_to ? { from: hhmm(m.hours_from)!, to: hhmm(m.hours_to)! } : null;
}

function short(id: string): string {
  return id.slice(-6);
}

function createdText(
  place: LocalizedText,
  r: ServiceRequest,
  opening: Date | null,
  timeZone: string,
): string {
  const parts = [`Нова заявка №${short(r.id)} — ${place.uk}`, `Послуга: ${r.service_title_i18n.uk}`];
  if (r.room_label)
    parts.push(`Кімната: ${r.room_label}${r.room_source === "guest" ? " (введено гостем)" : ""}`);
  if (r.comment) parts.push(`Коментар: ${r.comment}`);
  if (opening) {
    const at = localMoment(opening, timeZone);
    const time = `${String(Math.floor(at.minutes / 60)).padStart(2, "0")}:${String(at.minutes % 60).padStart(2, "0")}`;
    parts.push(`Поза годинами прийому — буде оброблено з ${time}`);
  }
  return parts.join("\n");
}

function toRequestDto(
  r: ServiceRequest,
  placeName: LocalizedText | undefined,
  events: readonly ServiceRequestEvent[],
  now: Date,
): ServiceRequestDto {
  return {
    id: r.id,
    regionId: r.region_id,
    placeId: r.place_id,
    placeName: placeName ?? { uk: "" },
    serviceCode: r.service_code,
    serviceTitle: r.service_title_i18n,
    room: r.room_label && r.room_source ? { label: r.room_label, source: r.room_source } : null,
    comment: r.comment,
    status: r.status,
    statusReason: r.status_reason,
    outsideHours: r.outside_hours,
    processFrom: r.process_from?.toISOString() ?? null,
    slaDueAt: r.sla_due_at?.toISOString() ?? null,
    overdue: isOverdue(r.status, r.sla_due_at, now),
    cancellable: canGuestCancel(r.status),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    history: events.map((e) => ({
      fromStatus: e.from_status,
      toStatus: e.to_status,
      actor: e.actor_type,
      reason: e.reason,
      at: e.created_at.toISOString(),
    })),
  };
}

function toAdminModule(placeId: string, regionId: string, m: HostModule | undefined): AdminHostModuleDto {
  if (!m)
    return {
      placeId,
      regionId,
      configured: false,
      enabled: true,
      wifiSsid: null,
      wifiPassword: null,
      receptionPhone: null,
      hours: null,
      sections: [],
      services: [],
      updatedAt: null,
    };
  return {
    placeId,
    regionId,
    configured: true,
    enabled: m.enabled,
    wifiSsid: m.wifi_ssid,
    wifiPassword: m.wifi_password,
    receptionPhone: m.reception_phone,
    hours: hoursOf(m),
    sections: [...m.sections].sort(bySort).map((s) => ({ ...s, kind: s.kind as HostSectionKind })),
    services: [...m.services].sort(bySort),
    updatedAt: m.updated_at.toISOString(),
  };
}

/** Снимок для аудита: без пароля Wi-Fi (только признак). */
function moduleSnapshot(m: HostModule): JsonObject {
  return {
    enabled: m.enabled,
    wifiSsid: m.wifi_ssid,
    wifiPasswordSet: m.wifi_password !== null,
    receptionPhone: m.reception_phone,
    hours: hoursOf(m),
    sections: m.sections.map((s) => s.kind),
    services: m.services.map((s) => ({ code: s.code, slaMinutes: s.slaMinutes, enabled: s.enabled })),
  };
}

function toStaffMember(m: {
  assignment_id: string;
  user_id: string;
  role: string;
  granted_at: Date;
  telegram_user_id: string | null;
  username: string | null;
  first_name: string | null;
  service_consent: boolean;
}): PlaceStaffMemberDto {
  return {
    assignmentId: m.assignment_id,
    userId: m.user_id,
    role: m.role as PlaceStaffRole,
    telegramUserId: m.telegram_user_id === null ? null : String(m.telegram_user_id),
    username: m.username,
    firstName: m.first_name,
    notificationsEnabled: m.service_consent,
    grantedAt: m.granted_at.toISOString(),
  };
}

function groupByRegion(places: readonly StaffPlace[]): Map<string, StaffPlace[]> {
  const out = new Map<string, StaffPlace[]>();
  for (const p of places) out.set(p.regionId, [...(out.get(p.regionId) ?? []), p]);
  return out;
}

function transitionError(from: ServiceRequestStatus, to: ServiceRequestStatus): ApiError {
  return new ApiError("CONFLICT", {
    messageKey: "errors.serviceRequests.invalidTransition",
    // from — текущий статус заявки (клиент обновляет карточку без перезапроса).
    details: { reason: "invalid_transition", from, to, currentStatus: from },
  });
}

function duplicateError(existingId: string | null): ApiError {
  return new ApiError("CONFLICT", {
    messageKey: "errors.serviceRequests.duplicate",
    details: { reason: "duplicate_request", ...(existingId ? { existingId } : {}) },
  });
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  const { code, constraint: c } = (e ?? {}) as { code?: unknown; constraint?: unknown };
  return code === "23505" && c === constraint;
}
