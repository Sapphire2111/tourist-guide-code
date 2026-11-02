import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { CursorPage, ErrorCode } from "@tg/shared";
import {
  ApiCursorPage,
  ApiError,
  ApiErrors,
  decodeIdCursor,
  idPage,
  toLocalized,
} from "../../common/http/index.js";
import { currentTenant } from "../../db/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { RequirePermission, scopeFromTenant, type RbacRequest } from "../rbac/index.js";
import {
  AdminQrPointDto,
  QrPointPrintDto,
  toAdminQrPointDto,
  type QrVenueInputDto,
} from "./qr-points.dto.js";
// Классы DTO нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateQrPointDto, QrPointsQueryDto, UpdateQrPointDto } from "./qr-points.dto.js";
import { QrPointError, QrPointsService, type QrVenueInput } from "./qr-points.service.js";

const DEFAULT_LIMIT = 20;

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

type AdminRequest = RbacRequest & AuditableRequest;

/**
 * QR-менеджмент (AD04, блок 3; ADR-0018). Область прав — tenant-контекст запроса: регион-админ работает со своим
 * регионом (чужая точка — 404: её не видят ни TenantGuardPlugin, ни RLS), SUPERADMIN без выбранного региона —
 * со всеми (создание — только в выбранном регионе: `PUT /auth/session/region`).
 */
@ApiTags("admin")
@Controller("admin/qr-points")
export class QrPointsController {
  constructor(@Inject(QrPointsService) private readonly service: QrPointsService) {}

  @Get()
  @RequirePermission("qr_point.manage", scopeFromTenant)
  @ApiOperation({ operationId: "listQrPoints", summary: "QR-точки региона, от новых к старым" })
  @ApiCursorPage(AdminQrPointDto)
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN")
  async list(@Query() q: QrPointsQueryDto): Promise<CursorPage<AdminQrPointDto>> {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const rows = await this.service.list(
      { type: q.type, active: q.active, campaign: q.campaign },
      { limit: limit + 1, beforeId: q.cursor === undefined ? undefined : decodeIdCursor(q.cursor) },
    );
    return idPage(rows, limit, toAdminQrPointDto);
  }

  @Post()
  @RequirePermission("qr_point.manage", scopeFromTenant)
  @ApiOperation({
    operationId: "createQrPoint",
    summary: "Новая QR-точка в регионе запроса; код генерирует сервер",
    description:
      "422 venue_hotel_only — «Про заклад» только у type=hotel; campaign_required — у type=campaign нужна " +
      "метка кампании. 403 region_context_required — SUPERADMIN без выбранного региона.",
  })
  @ApiCreatedResponse({ type: AdminQrPointDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "UNPROCESSABLE")
  async create(@Body() body: CreateQrPointDto, @Req() req: AdminRequest): Promise<AdminQrPointDto> {
    const row = await this.service
      .create(
        {
          regionId: regionOfRequest(),
          type: body.type,
          label: body.label,
          campaign: body.campaign ?? null,
          source: body.source ?? null,
          placeId: body.placeId ?? null,
          venue: body.venue ? venueInput(body.venue) : null,
          roomLabel: body.roomLabel ?? null,
        },
        auditFromRequest(req),
      )
      .catch(rethrow);
    return toAdminQrPointDto(row);
  }

  @Get(":id")
  @RequirePermission("qr_point.manage", scopeFromTenant)
  @ApiOperation({ operationId: "getQrPoint", summary: "QR-точка по id" })
  @ApiOkResponse({ type: AdminQrPointDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async get(@Param("id", uuid) id: string): Promise<AdminQrPointDto> {
    return toAdminQrPointDto(found(await this.service.find(id)));
  }

  @Patch(":id")
  @RequirePermission("qr_point.manage", scopeFromTenant)
  @ApiOperation({
    operationId: "updateQrPoint",
    summary: "Правка подписи, кампании, канала, места и «Про заклад» (тип и код не меняются)",
  })
  @ApiOkResponse({ type: AdminQrPointDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "UNPROCESSABLE")
  async update(
    @Param("id", uuid) id: string,
    @Body() body: UpdateQrPointDto,
    @Req() req: AdminRequest,
  ): Promise<AdminQrPointDto> {
    const row = await this.service
      .update(
        id,
        {
          label: body.label,
          campaign: body.campaign,
          source: body.source,
          placeId: body.placeId,
          venue: body.venue === undefined ? undefined : body.venue && venueInput(body.venue),
          roomLabel: body.roomLabel,
        },
        auditFromRequest(req),
      )
      .catch(rethrow);
    return toAdminQrPointDto(found(row));
  }

  @Post(":id/deactivate")
  @HttpCode(200)
  @RequirePermission("qr_point.deactivate", scopeFromTenant)
  @ApiOperation({
    operationId: "deactivateQrPoint",
    summary: "Деактивировать QR: скан даёт нейтральный контекст региона (повтор — без изменений)",
  })
  @ApiOkResponse({ type: AdminQrPointDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async deactivate(@Param("id", uuid) id: string, @Req() req: AdminRequest): Promise<AdminQrPointDto> {
    return toAdminQrPointDto(found(await this.service.setActive(id, false, auditFromRequest(req))));
  }

  @Post(":id/activate")
  @HttpCode(200)
  @RequirePermission("qr_point.manage", scopeFromTenant)
  @ApiOperation({ operationId: "activateQrPoint", summary: "Снова включить QR (повтор — без изменений)" })
  @ApiOkResponse({ type: AdminQrPointDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async activate(@Param("id", uuid) id: string, @Req() req: AdminRequest): Promise<AdminQrPointDto> {
    return toAdminQrPointDto(found(await this.service.setActive(id, true, auditFromRequest(req))));
  }

  @Get(":id/print")
  @RequirePermission("qr_point.manage", scopeFromTenant)
  @ApiOperation({
    operationId: "getQrPointPrint",
    summary: "Данные для печати: deep link https://t.me/<bot>?startapp=<code> и SVG QR-кода",
    description:
      "409 bot_username_not_configured — на сервере не задан TELEGRAM_BOT_USERNAME; 409 qr_point_inactive — " +
      "точка деактивирована (печатать её незачем).",
  })
  @ApiOkResponse({ type: QrPointPrintDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT")
  async print(@Param("id", uuid) id: string): Promise<QrPointPrintDto> {
    const data = found(await this.service.printData(id).catch(rethrow));
    return {
      id: data.point.id,
      code: data.point.code,
      label: data.point.label,
      deepLink: data.deepLink,
      svg: data.svg,
    };
  }
}

function found<T>(v: T | undefined): T {
  if (v === undefined) throw new ApiError("NOT_FOUND");
  return v;
}

/** Регион запроса: точка принадлежит региону (PLATFORM без выбранного региона — 403). */
function regionOfRequest(): string {
  const tenant = currentTenant();
  if (tenant?.kind !== "region")
    throw new ApiError("FORBIDDEN", { details: { reason: "region_context_required" } });
  return tenant.regionId;
}

function venueInput(v: QrVenueInputDto): QrVenueInput {
  return {
    name: toLocalized(v.name),
    description: v.description ? toLocalized(v.description) : null,
    address: v.address ? toLocalized(v.address) : null,
    phone: v.phone ?? null,
    website: v.website ?? null,
    telegram: v.telegram ?? null,
  };
}

const ERRORS = {
  venue_hotel_only: { code: "UNPROCESSABLE" },
  room_hotel_only: { code: "UNPROCESSABLE" },
  campaign_required: { code: "UNPROCESSABLE" },
  code_generation_failed: { code: "INTERNAL" },
  bot_username_not_configured: { code: "CONFLICT", messageKey: "errors.qr.botUsernameMissing" },
  qr_point_inactive: { code: "CONFLICT", messageKey: "errors.qr.inactive" },
} as const satisfies Record<QrPointError["reason"], { code: ErrorCode; messageKey?: string }>;

function rethrow(e: unknown): never {
  if (!(e instanceof QrPointError)) throw e;
  const err: { code: ErrorCode; messageKey?: string } = ERRORS[e.reason];
  throw new ApiError(err.code, { messageKey: err.messageKey, details: { reason: e.reason }, cause: e });
}
