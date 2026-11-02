import { Body, Controller, Get, Inject, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiErrors } from "../../common/http/index.js";
import type { AuditableRequest } from "../audit/index.js";
import { platformScope, RequirePermission, scopeFromParam, scopeFromTenant } from "../rbac/index.js";
import { auditMeta, call, uuid } from "./catalog-http.js";
import { RegionDto, RegionListDto, toRegionDto } from "./catalog.dto.js";
// Классы DTO нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateRegionDto, RegionStatusDto, UpdateRegionDto } from "./catalog.dto.js";
import { RegionsAdminService } from "./regions-admin.service.js";

/**
 * Регионы в админке (блок 3). Регион-админ видит и правит только свой регион (настройки: название, таймзона, язык);
 * создание и статус региона — только PLATFORM (SUPERADMIN). Чужой регион — 403 (нет права на его область).
 */
@ApiTags("admin")
@Controller("admin/regions")
export class RegionsAdminController {
  constructor(@Inject(RegionsAdminService) private readonly regions: RegionsAdminService) {}

  @Get()
  @RequirePermission("catalog.read.admin", scopeFromTenant)
  @ApiOperation({
    operationId: "listAdminRegions",
    summary: "Регионы: свой (регион-админ) или все (PLATFORM)",
  })
  @ApiOkResponse({ type: RegionListDto })
  @ApiErrors("UNAUTHENTICATED", "FORBIDDEN")
  async list(): Promise<RegionListDto> {
    return { items: (await call(() => this.regions.list())).map(toRegionDto) };
  }

  @Get(":id")
  @RequirePermission("catalog.read.admin", scopeFromParam("REGION"))
  @ApiOperation({ operationId: "getAdminRegion", summary: "Регион" })
  @ApiOkResponse({ type: RegionDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async get(@Param("id", uuid) id: string): Promise<RegionDto> {
    return toRegionDto(await call(() => this.regions.get(id)));
  }

  @Patch(":id")
  @RequirePermission("region.settings.edit", scopeFromParam("REGION"))
  @ApiOperation({ operationId: "updateAdminRegion", summary: "Настройки региона: название, таймзона, язык" })
  @ApiOkResponse({ type: RegionDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "UNPROCESSABLE")
  async update(
    @Param("id", uuid) id: string,
    @Body() body: UpdateRegionDto,
    @Req() req: AuditableRequest,
  ): Promise<RegionDto> {
    const input = {
      name: body.name && { ...body.name },
      timezone: body.timezone,
      defaultLanguage: body.defaultLanguage,
    };
    return toRegionDto(await call(() => this.regions.update(auditMeta(req), id, input)));
  }

  @Put(":id/status")
  @RequirePermission("region.manage", platformScope)
  @ApiOperation({ operationId: "setAdminRegionStatus", summary: "Статус региона (draft/active/suspended)" })
  @ApiOkResponse({ type: RegionDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async setStatus(
    @Param("id", uuid) id: string,
    @Body() body: RegionStatusDto,
    @Req() req: AuditableRequest,
  ): Promise<RegionDto> {
    return toRegionDto(
      await call(() => this.regions.setStatus(auditMeta(req), id, body.status, body.reason ?? null)),
    );
  }

  @Post()
  @RequirePermission("region.create", platformScope)
  @ApiOperation({ operationId: "createAdminRegion", summary: "Новый регион (draft) — только SUPERADMIN" })
  @ApiCreatedResponse({ type: RegionDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "CONFLICT", "UNPROCESSABLE")
  async create(@Body() body: CreateRegionDto, @Req() req: AuditableRequest): Promise<RegionDto> {
    const input = {
      code: body.code,
      name: { ...body.name },
      timezone: body.timezone,
      defaultLanguage: body.defaultLanguage,
    };
    return toRegionDto(await call(() => this.regions.create(auditMeta(req), input)));
  }
}
