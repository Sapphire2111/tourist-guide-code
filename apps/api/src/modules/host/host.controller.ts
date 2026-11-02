import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { RequireAuth } from "../auth/index.js";
import { RequireFeature, type FeatureRegionResolver } from "../feature-flags/index.js";
import { Idempotent } from "../idempotency/index.js";
import { RateLimit } from "../rate-limit/index.js";
import { RequirePermission, scopeFromTenant, type RbacRequest } from "../rbac/index.js";
import {
  AdminHostModuleDto,
  HostModuleDto,
  PlaceStaffListDto,
  PlaceStaffMemberDto,
  ServiceRequestDto,
  ServiceRequestListDto,
  StaffPlaceListDto,
  StaffServiceRequestDto,
  StaffServiceRequestListDto,
} from "./host.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AssignPlaceStaffDto,
  CancelServiceRequestDto,
  CreateServiceRequestDto,
  HostModuleQueryDto,
  MyServiceRequestsQueryDto,
  PutHostModuleDto,
  StaffServiceRequestsQueryDto,
  UpdateServiceRequestStatusDto,
} from "./host.dto.js";
import { HostService } from "./host.service.js";

// Блок 5 (ADR-0020): «Про заклад» и заявки гостя (регион — из запроса, как каталог гида), экран персонала (места —
// из назначений PLACE на сервере), настройки отеля и персонал в админке (tenant-контекст, @RequirePermission).
// Модуль — за флагом module.host_requests (требует release.r1, ADR-0011): выключен — 404.

/** Создание заявок: гость за час — не больше (S-03: защита от спама персоналу). */
export const SERVICE_REQUEST_RATE_LIMIT = { limit: 20, windowSec: 3600 } as const;

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

/** Регион флага для туриста: query/body regionId (как в гиде; сам регион проверяет сервис). */
const touristRegion: FeatureRegionResolver = ({ request }) => {
  const q = request.query?.regionId;
  if (typeof q === "string") return q;
  const b = request.body as { regionId?: unknown } | undefined;
  return typeof b?.regionId === "string" ? b.regionId : undefined;
};

type AuthedRequest = RbacRequest & AuditableRequest;

function userOf(req: RbacRequest): string {
  const userId = req.principal?.userId;
  if (!userId) throw new ApiError("UNAUTHENTICATED");
  return userId;
}

@ApiTags("host")
@Controller("host")
@WithoutTenantContext()
@RequireFeature("module.host_requests", { region: touristRegion })
export class HostModuleController {
  constructor(@Inject(HostService) private readonly host: HostService) {}

  @Get(":placeId/module")
  @ApiOperation({
    operationId: "getHostModule",
    summary: "«Про заклад» (C03): правила, Wi-Fi, контакты, часы приёма, услуги-заявки",
    description:
      "Без аутентификации. 404 — места нет в регионе, оно не опубликовано или модуль не настроен/выключен. " +
      "С entryContextId входа по QR этого места — пароль Wi-Fi и номер комнаты QR номера (D-49).",
  })
  @ApiParam({ name: "placeId", type: String, format: "uuid" })
  @ApiOkResponse({ type: HostModuleDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  get(@Param("placeId", uuid) placeId: string, @Query() q: HostModuleQueryDto): Promise<HostModuleDto> {
    return this.host.guestModule(q.regionId, placeId, q.entryContextId);
  }
}

@ApiTags("host")
@Controller("service-requests")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.host_requests", { region: touristRegion })
export class ServiceRequestsController {
  constructor(@Inject(HostService) private readonly host: HostService) {}

  @Post()
  @Idempotent()
  @RateLimit(SERVICE_REQUEST_RATE_LIMIT)
  @ApiOperation({
    operationId: "createServiceRequest",
    summary: "Заявка гостя отеля (S-03): уборка, полотенца… → new",
    description:
      "Номер комнаты: из QR номера по entryContextId (source qr), иначе roomLabel гостя (source guest, «введено " +
      "гостем»). Вне часов приёма — принимается с outsideHours и processFrom («буде оброблено з …», D-55). " +
      "404 — место/модуль/услуга недоступны; 409 errors.serviceRequests.duplicate — открытая заявка той же услуги " +
      `от гостя или с той же комнаты (details.existingId). Rate limit ${SERVICE_REQUEST_RATE_LIMIT.limit}/час.`,
  })
  @ApiCreatedResponse({ type: ServiceRequestDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMITED",
    "IDEMPOTENCY_KEY_REQUIRED",
    "IDEMPOTENCY_IN_PROGRESS",
    "IDEMPOTENCY_KEY_REUSED",
  )
  create(@Body() body: CreateServiceRequestDto, @Req() req: RbacRequest): Promise<ServiceRequestDto> {
    return this.host.createRequest(userOf(req), body);
  }
}

@ApiTags("host")
@Controller("me/service-requests")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.host_requests", { region: touristRegion })
export class MyServiceRequestsController {
  constructor(@Inject(HostService) private readonly host: HostService) {}

  @Get()
  @ApiOperation({
    operationId: "listMyServiceRequests",
    summary: "«Мої заявки» (C22): заявки гостя в регионе со статусами и историей",
  })
  @ApiOkResponse({ type: ServiceRequestListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  list(@Query() q: MyServiceRequestsQueryDto, @Req() req: RbacRequest): Promise<ServiceRequestListDto> {
    return this.host.myRequests(q.regionId, userOf(req));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({
    operationId: "cancelMyServiceRequest",
    summary: "Отменить свою заявку (new, accepted → cancelled_by_guest)",
    description:
      "404 — заявки нет или она чужая; 409 errors.serviceRequests.invalidTransition — уже в работе/закрыта.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: ServiceRequestDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "CONFLICT", "RATE_LIMITED")
  cancel(
    @Param("id", uuid) id: string,
    @Body() body: CancelServiceRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<ServiceRequestDto> {
    return this.host.cancel(body.regionId, userOf(req), id, auditFromRequest(req));
  }
}

/**
 * Экран персонала (P10, D-50 — ролевой режим того же Mini App): места — из назначений ORG_STAFF/ORG_OWNER на место
 * (RBAC на сервере), транзакции — по региону каждого места.
 */
@ApiTags("staff")
@Controller("staff")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.host_requests")
export class StaffServiceRequestsController {
  constructor(@Inject(HostService) private readonly host: HostService) {}

  @Get("places")
  @ApiOperation({
    operationId: "listStaffPlaces",
    summary: "Места, где пользователь — персонал (режим персонала, D-50), с числом открытых заявок",
  })
  @ApiOkResponse({ type: StaffPlaceListDto })
  @ApiErrors("UNAUTHENTICATED", "RATE_LIMITED")
  places(@Req() req: RbacRequest): Promise<StaffPlaceListDto> {
    return this.host.staffPlaces(userOf(req));
  }

  @Get("service-requests")
  @ApiOperation({
    operationId: "listStaffServiceRequests",
    summary: "Заявки своего отеля (P10), фильтр по статусу и месту; overdue — просрочен SLA",
    description: "403 not_staff — у пользователя нет назначения персонала (или не на это место).",
  })
  @ApiOkResponse({ type: StaffServiceRequestListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED")
  list(
    @Query() q: StaffServiceRequestsQueryDto,
    @Req() req: RbacRequest,
  ): Promise<StaffServiceRequestListDto> {
    return this.host.staffList(userOf(req), { status: q.status, placeId: q.placeId });
  }

  @Patch("service-requests/:id/status")
  @ApiOperation({
    operationId: "updateStaffServiceRequestStatus",
    summary:
      "Смена статуса: new → accepted → in_progress → done; new|accepted → rejected (причина обязательна)",
    description:
      "Переход — в историю заявки и AuditLog; гостю — уведомление ботом при согласии. 404 — заявки нет или она " +
      "другого отеля; 409 errors.serviceRequests.invalidTransition — переход недопустим или статус уже изменил " +
      "другой сотрудник (details.from — текущий).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: StaffServiceRequestDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "RATE_LIMITED")
  update(
    @Param("id", uuid) id: string,
    @Body() body: UpdateServiceRequestStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<StaffServiceRequestDto> {
    return this.host.staffUpdate(userOf(req), id, body, auditFromRequest(req));
  }
}

/** Настройки «Про заклад» места в админке региона (AD, блок 5). */
@ApiTags("admin")
@Controller("admin/places/:id/host-module")
@RequirePermission("host_module.edit", scopeFromTenant)
export class AdminHostModuleController {
  constructor(@Inject(HostService) private readonly host: HostService) {}

  @Get()
  @ApiOperation({
    operationId: "getAdminHostModule",
    summary: "Настройки «Про заклад» места (configured=false — ещё не настраивались)",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: AdminHostModuleDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  get(@Param("id", uuid) id: string): Promise<AdminHostModuleDto> {
    return this.host.adminGetModule(id);
  }

  @Put()
  @ApiOperation({
    operationId: "putAdminHostModule",
    summary: "Заменить настройки «Про заклад»: разделы, услуги с SLA, часы приёма, Wi-Fi, телефон рецепции",
    description: "Коды услуг уникальны в модуле. Изменение — в AuditLog (без пароля Wi-Fi).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: AdminHostModuleDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  put(
    @Param("id", uuid) id: string,
    @Body() body: PutHostModuleDto,
    @Req() req: AuthedRequest,
  ): Promise<AdminHostModuleDto> {
    return this.host.adminPutModule(id, body, auditFromRequest(req));
  }
}

/** Персонал места: назначение и снятие ORG_STAFF/ORG_OWNER админом региона (до кабинета партнёра блока 6). */
@ApiTags("admin")
@Controller("admin/places/:id/staff")
@RequirePermission("staff.role.assign", scopeFromTenant)
export class AdminPlaceStaffController {
  constructor(@Inject(HostService) private readonly host: HostService) {}

  @Get()
  @ApiOperation({ operationId: "listAdminPlaceStaff", summary: "Персонал места (действующие назначения)" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PlaceStaffListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  list(@Param("id", uuid) id: string): Promise<PlaceStaffListDto> {
    return this.host.adminStaff(id);
  }

  @Post()
  @ApiOperation({
    operationId: "assignAdminPlaceStaff",
    summary: "Назначить сотрудника по Telegram id или username (пользователь уже входил в Mini App)",
    description:
      "404 errors.staff.userNotFound — такого пользователя нет; 409 errors.staff.alreadyAssigned. Назначение — " +
      "AuditLog (role.assign).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiCreatedResponse({ type: PlaceStaffMemberDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNPROCESSABLE")
  assign(
    @Param("id", uuid) id: string,
    @Body() body: AssignPlaceStaffDto,
    @Req() req: AuthedRequest,
  ): Promise<PlaceStaffMemberDto> {
    return this.host.adminAssignStaff(id, body, auditFromRequest(req));
  }

  @Delete(":assignmentId")
  @HttpCode(204)
  @ApiOperation({
    operationId: "revokeAdminPlaceStaff",
    summary: "Снять сотрудника (отзыв назначения, AuditLog)",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "assignmentId", type: String, format: "uuid" })
  @ApiNoContentResponse({ description: "Снят" })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async revoke(
    @Param("id", uuid) id: string,
    @Param("assignmentId", uuid) assignmentId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.host.adminRevokeStaff(id, assignmentId, auditFromRequest(req));
  }
}
