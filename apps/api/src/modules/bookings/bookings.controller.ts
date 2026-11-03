import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { RequireAuth } from "../auth/index.js";
import { RequireFeature, type FeatureRegionResolver } from "../feature-flags/index.js";
import { Idempotent } from "../idempotency/index.js";
import { RateLimit } from "../rate-limit/index.js";
import type { RbacRequest } from "../rbac/index.js";
import {
  BookingDto,
  BookingListDto,
  PartnerBookingDto,
  PartnerBookingListDto,
  PartnerResourceDto,
  PartnerResourceListDto,
  ResourceListDto,
  SlotListDto,
} from "./bookings.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  BookingRegionQueryDto,
  CreateBookingDto,
  CreateManualBookingDto,
  CreateResourceDto,
  PartnerBookingsQueryDto,
  PartnerResourcesQueryDto,
  PutAvailabilityDto,
  PutManualAvailabilityDto,
  ResourcesQueryDto,
  SlotsQueryDto,
  UpdateBookingStatusDto,
  UpdateResourceDto,
} from "./bookings.dto.js";
import { BookingsService } from "./bookings.service.js";

// Блок 7: бронирования. Турист — регион из запроса (regionId, как каталог гида); партнёр — права из назначений ORG_*
// на место/организацию (RBAC на сервере). Модуль — за флагом module.bookings (по умолчанию выключен): выключен — 404.

/** Онлайн-брони: пользователь за час — не больше (защита партнёра от спама, BR-14). */
export const BOOKING_RATE_LIMIT = { limit: 10, windowSec: 3600 } as const;
/** Ручные записи партнёра за час. */
export const MANUAL_BOOKING_RATE_LIMIT = { limit: 120, windowSec: 3600 } as const;

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

/** Регион флага: query/body regionId (турист); у партнёра его нет — значение окружения. */
const requestRegion: FeatureRegionResolver = ({ request }) => {
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

const IDEMPOTENCY_ERRORS = [
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_KEY_REUSED",
] as const;

@ApiTags("bookings")
@Controller("resources")
@WithoutTenantContext()
@RequireFeature("module.bookings", { region: requestRegion })
export class ResourcesController {
  constructor(@Inject(BookingsService) private readonly bookings: BookingsService) {}

  @Get()
  @ApiOperation({
    operationId: "listResources",
    summary: "Ресурсы бронирования заведения (C07) с «Доступно зараз»",
    description:
      "Без аутентификации. Только активные ресурсы опубликованного места. availability.availableNow — только при " +
      "реальном свободном слоте в ближайшие 2 ч или ручном статусе партнёра с неистёкшим TTL (BR-04); иначе — " +
      "«Уточнити доступність». 404 — места нет в регионе или оно не опубликовано.",
  })
  @ApiOkResponse({ type: ResourceListDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  list(@Query() q: ResourcesQueryDto): Promise<ResourceListDto> {
    return this.bookings.listResources(q.regionId, q.placeId);
  }

  @Get(":id/slots")
  @ApiOperation({
    operationId: "listResourceSlots",
    summary: "Слоты ресурса (C07): сетка из правил доступности в таймзоне региона, свободен/занят",
    description:
      "Без аутентификации. Слоты не раньше lead time и не дальше горизонта ресурса; занятость — брони и ручные " +
      "записи с buffer до/после (BR-08). 404 — ресурс не активен или место не опубликовано.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: SlotListDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  slots(@Param("id", uuid) id: string, @Query() q: SlotsQueryDto): Promise<SlotListDto> {
    return this.bookings.slots(q.regionId, id, q);
  }
}

@ApiTags("bookings")
@Controller("bookings")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.bookings", { region: requestRegion })
export class BookingsController {
  constructor(@Inject(BookingsService) private readonly bookings: BookingsService) {}

  @Post()
  @Idempotent()
  @RateLimit(BOOKING_RATE_LIMIT)
  @ApiOperation({
    operationId: "createBooking",
    summary: "Онлайн-бронь (C08): new → pending_partner (или confirmed при автоподтверждении)",
    description:
      "Телефон и согласие на его передачу этому заведению обязательны (ТЗ §14.1, D-42): phoneShareConsent=false — " +
      "422 errors.booking.phoneConsentRequired. Слот — из GET /resources/{id}/slots: иначе 422 " +
      "errors.booking.slotUnavailable; слот уже занят (в т. ч. параллельной бронью или ручной записью) — 409 " +
      "errors.booking.slotTaken. 422 errors.booking.noShowLimit — порог no_show (D-44), только «зателефонувати»; " +
      "422 errors.booking.tooManyPending, errors.booking.capacityExceeded. Повтор с тем же Idempotency-Key — тот " +
      "же ответ.",
  })
  @ApiCreatedResponse({ type: BookingDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "CONFLICT",
    "UNPROCESSABLE",
    "RATE_LIMITED",
    ...IDEMPOTENCY_ERRORS,
  )
  create(@Body() body: CreateBookingDto, @Req() req: RbacRequest): Promise<BookingDto> {
    return this.bookings.create(userOf(req), body);
  }

  @Get()
  @ApiOperation({
    operationId: "listMyBookings",
    summary: "«Мої бронювання»: брони пользователя в регионе со статусами, альтернативой и историей",
  })
  @ApiOkResponse({ type: BookingListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  mine(@Query() q: BookingRegionQueryDto, @Req() req: RbacRequest): Promise<BookingListDto> {
    return this.bookings.myBookings(q.regionId, userOf(req));
  }

  @Patch(":id/status")
  @ApiOperation({
    operationId: "updateBookingStatus",
    summary: "Смена статуса брони: турист — отмена и ответ на альтернативу; партнёр — P05",
    description:
      "Турист-владелец: cancelled_by_user (confirmed — не позже чем за 2 ч до начала, иначе 422 cancelTooLate); confirmed — принять альтернативу до срока ответа (D-66). Партнёр (право " +
      "на место брони): confirmed, alternative_proposed (alternativeStartsAt; исходный слот освобождается), " +
      "cancelled_by_partner (reason обязателен), completed (после начала; проводок ledger нет — D-45), no_show " +
      "(после начала + grace; счётчик no_show клиента — D-44), no_show → completed — исправление менеджером в окне " +
      "48 ч. completed → no_show запрещён (C-27). Ответ партнёру — PartnerBookingDto. 404 — брони нет или она чужая; " +
      "403 — нет права на переход; 409 errors.booking.invalidTransition (details.currentStatus) или " +
      "errors.booking.slotTaken (предложенный интервал занят).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerBookingDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "UNPROCESSABLE",
    "RATE_LIMITED",
  )
  updateStatus(
    @Param("id", uuid) id: string,
    @Body() body: UpdateBookingStatusDto,
    @Req() req: AuthedRequest,
  ): Promise<BookingDto | PartnerBookingDto> {
    return this.bookings.updateStatus(userOf(req), id, body, auditFromRequest(req));
  }
}

@ApiTags("partner-bookings")
@Controller("partner")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.bookings", { region: requestRegion })
export class PartnerBookingsController {
  constructor(@Inject(BookingsService) private readonly bookings: BookingsService) {}

  @Get("bookings")
  @ApiOperation({
    operationId: "listPartnerBookings",
    summary: "Брони заведений партнёра (P04, P05): только места своих организаций",
    description:
      "Права — назначения ORG_OWNER/ORG_MANAGER/ORG_STAFF на организацию или место (booking.read). Телефон клиента " +
      "— только при согласии на передачу этому партнёру и роли менеджера/владельца. 403 not_partner — нет мест " +
      "с правом (или placeId не своё).",
  })
  @ApiOkResponse({ type: PartnerBookingListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED")
  list(@Query() q: PartnerBookingsQueryDto, @Req() req: RbacRequest): Promise<PartnerBookingListDto> {
    return this.bookings.partnerList(userOf(req), q);
  }

  @Post("bookings")
  @Idempotent()
  @RateLimit(MANUAL_BOOKING_RATE_LIMIT)
  @ApiOperation({
    operationId: "createManualBooking",
    summary: "Ручная запись партнёра (P04): сразу confirmed, блокирует интервал для онлайн-брони",
    description:
      "Тот же механизм занятости (BR-08): интервал с buffer занят — 409 errors.booking.slotTaken; ресурс неактивен — " +
      "422 errors.booking.resourceInactive; пустое имя — 422 customerNameRequired. 404 — ресурса " +
      "нет; 403 — нет права booking.manual.create на место ресурса. AuditLog.",
  })
  @ApiCreatedResponse({ type: PartnerBookingDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "UNPROCESSABLE",
    "RATE_LIMITED",
    ...IDEMPOTENCY_ERRORS,
  )
  createManual(@Body() body: CreateManualBookingDto, @Req() req: AuthedRequest): Promise<PartnerBookingDto> {
    return this.bookings.createManual(userOf(req), body, auditFromRequest(req));
  }

  @Get("resources")
  @ApiOperation({
    operationId: "listPartnerResources",
    summary: "Ресурсы заведения партнёра с правилами доступности и ручным статусом",
  })
  @ApiOkResponse({ type: PartnerResourceListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED")
  resources(@Query() q: PartnerResourcesQueryDto, @Req() req: RbacRequest): Promise<PartnerResourceListDto> {
    return this.bookings.partnerResources(userOf(req), q.placeId);
  }

  @Post("resources")
  @ApiOperation({
    operationId: "createPartnerResource",
    summary: "Новый ресурс заведения (D-04 А: почасовые слоты): длительность, buffer, вместимость, SLA",
    description: "Право resource.manage (владелец, менеджер). 403 — нет права на место. AuditLog.",
  })
  @ApiCreatedResponse({ type: PartnerResourceDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "UNPROCESSABLE", "RATE_LIMITED")
  createResource(@Body() body: CreateResourceDto, @Req() req: AuthedRequest): Promise<PartnerResourceDto> {
    return this.bookings.createResource(userOf(req), body, auditFromRequest(req));
  }

  @Patch("resources/:id")
  @ApiOperation({
    operationId: "updatePartnerResource",
    summary: "Правка ресурса (и статус active/inactive/archived)",
    description:
      "version — оптимистичная блокировка: ресурс изменили после чтения — 409 errors.resource.versionConflict " +
      "(details.currentVersion).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerResourceDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "UNPROCESSABLE",
    "RATE_LIMITED",
  )
  updateResource(
    @Param("id", uuid) id: string,
    @Body() body: UpdateResourceDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerResourceDto> {
    return this.bookings.updateResource(userOf(req), id, body, auditFromRequest(req));
  }

  @Put("resources/:id/availability")
  @ApiOperation({
    operationId: "putResourceAvailability",
    summary: "Правила доступности ресурса целиком: недельные окна и правила на дату (выходной/свои часы)",
    description:
      "Местное время региона, окно не переходит через полночь (закрытие до 24:00). 422 errors.resource.rulesInvalid " +
      "(details.problems) — пересечение окон, закрытая дата с окнами, неверная форма. Существующие брони не " +
      "меняются. Право availability.edit.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerResourceDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "UNPROCESSABLE",
    "RATE_LIMITED",
  )
  putAvailability(
    @Param("id", uuid) id: string,
    @Body() body: PutAvailabilityDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerResourceDto> {
    return this.bookings.putAvailability(userOf(req), id, body, auditFromRequest(req));
  }

  @Put("resources/:id/manual-availability")
  @ApiOperation({
    operationId: "putResourceManualAvailability",
    summary: "Ручной статус «Доступно зараз» с TTL (D-78: короткий, по умолчанию 60 мин)",
    description:
      "available_now / busy — до now + ttlMinutes; unknown — снять. Ставят ORG_MANAGER и ORG_STAFF " +
      "(availability.status.manual), запись в AuditLog.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerResourceDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "RATE_LIMITED")
  putManualAvailability(
    @Param("id", uuid) id: string,
    @Body() body: PutManualAvailabilityDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerResourceDto> {
    return this.bookings.putManualAvailability(userOf(req), id, body, auditFromRequest(req));
  }
}
