import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { ApiError, ApiErrors, toLocalized } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { currentTenant } from "../../db/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { RequirePermission, scopeFromTenant, type RbacRequest } from "../rbac/index.js";
import {
  AdminEmergencyContactDto,
  AdminEmergencyContactListDto,
  EmergencyContactListDto,
  toAdminEmergencyContactDto,
  toEmergencyContactDto,
} from "./emergency-contacts.dto.js";
// Классы DTO нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CreateEmergencyContactDto,
  EmergencyContactsQueryDto,
  UpdateEmergencyContactDto,
} from "./emergency-contacts.dto.js";
import { EmergencyContactsService } from "./emergency-contacts.service.js";

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

type AdminRequest = RbacRequest & AuditableRequest;

/**
 * Экстренные контакты региона в админке (блок 3; ADR-0018): право emergency_contact.manage на tenant-контекст
 * запроса. Чужой контакт — 404 (TenantGuardPlugin и RLS его не видят).
 */
@ApiTags("admin")
@Controller("admin/emergency-contacts")
@RequirePermission("emergency_contact.manage", scopeFromTenant)
export class AdminEmergencyContactsController {
  constructor(@Inject(EmergencyContactsService) private readonly service: EmergencyContactsService) {}

  @Get()
  @ApiOperation({ operationId: "listAdminEmergencyContacts", summary: "Экстренные контакты региона" })
  @ApiOkResponse({ type: AdminEmergencyContactListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN")
  async list(@Query() q: EmergencyContactsQueryDto): Promise<AdminEmergencyContactListDto> {
    const rows = await this.service.list({ kind: q.kind, active: q.active });
    return { items: rows.map(toAdminEmergencyContactDto) };
  }

  @Post()
  @ApiOperation({
    operationId: "createEmergencyContact",
    summary: "Новый экстренный контакт в регионе запроса",
    description: "403 region_context_required — SUPERADMIN без выбранного региона.",
  })
  @ApiCreatedResponse({ type: AdminEmergencyContactDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN")
  async create(
    @Body() body: CreateEmergencyContactDto,
    @Req() req: AdminRequest,
  ): Promise<AdminEmergencyContactDto> {
    const row = await this.service.create(
      regionOfRequest(),
      {
        kind: body.kind,
        name: toLocalized(body.name),
        phone: body.phone,
        description: body.description ? toLocalized(body.description) : null,
        sortOrder: body.sortOrder,
        active: body.active,
      },
      auditFromRequest(req),
    );
    return toAdminEmergencyContactDto(row);
  }

  @Get(":id")
  @ApiOperation({ operationId: "getEmergencyContact", summary: "Экстренный контакт по id" })
  @ApiOkResponse({ type: AdminEmergencyContactDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async get(@Param("id", uuid) id: string): Promise<AdminEmergencyContactDto> {
    const row = await this.service.find(id);
    if (!row) throw new ApiError("NOT_FOUND");
    return toAdminEmergencyContactDto(row);
  }

  @Patch(":id")
  @ApiOperation({ operationId: "updateEmergencyContact", summary: "Правка экстренного контакта" })
  @ApiOkResponse({ type: AdminEmergencyContactDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async update(
    @Param("id", uuid) id: string,
    @Body() body: UpdateEmergencyContactDto,
    @Req() req: AdminRequest,
  ): Promise<AdminEmergencyContactDto> {
    const row = await this.service.update(
      id,
      {
        kind: body.kind,
        name: body.name && toLocalized(body.name),
        phone: body.phone,
        description:
          body.description === undefined ? undefined : body.description && toLocalized(body.description),
        sortOrder: body.sortOrder,
        active: body.active,
      },
      auditFromRequest(req),
    );
    if (!row) throw new ApiError("NOT_FOUND");
    return toAdminEmergencyContactDto(row);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ operationId: "deleteEmergencyContact", summary: "Удалить экстренный контакт" })
  @ApiNoContentResponse({ description: "Удалён" })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async remove(@Param("id", uuid) id: string, @Req() req: AdminRequest): Promise<void> {
    if (!(await this.service.remove(id, auditFromRequest(req)))) throw new ApiError("NOT_FOUND");
  }
}

/**
 * Экран «Халепа?» туриста (блок 4): активные контакты региона без сессии. Без tenant-контекста принципала —
 * регион из пути (данные публичные), сервис сам читает в контексте этого региона.
 */
@ApiTags("emergency")
@Controller("regions/:regionId/emergency-contacts")
@WithoutTenantContext()
export class PublicEmergencyContactsController {
  constructor(@Inject(EmergencyContactsService) private readonly service: EmergencyContactsService) {}

  @Get()
  // Номера меняются редко; короткий кеш снимает нагрузку при частом открытии экрана.
  @Header("Cache-Control", "public, max-age=300")
  @ApiOperation({
    operationId: "listEmergencyContacts",
    summary: "Экстренные контакты региона для туриста («Халепа?»), только активные, по порядку",
    description: "Без аутентификации. 404 — региона нет или он не активен.",
  })
  @ApiParam({ name: "regionId", type: String, format: "uuid" })
  @ApiOkResponse({ type: EmergencyContactListDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  async list(@Param("regionId", uuid) regionId: string): Promise<EmergencyContactListDto> {
    const rows = await this.service.publicList(regionId);
    if (!rows) throw new ApiError("NOT_FOUND");
    return { items: rows.map(toEmergencyContactDto) };
  }
}

/** Регион запроса: контакт принадлежит региону (PLATFORM без выбранного региона — 403). */
function regionOfRequest(): string {
  const tenant = currentTenant();
  if (tenant?.kind !== "region")
    throw new ApiError("FORBIDDEN", { details: { reason: "region_context_required" } });
  return tenant.regionId;
}
