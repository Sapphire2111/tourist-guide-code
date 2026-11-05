import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { auditFromRequest } from "../audit/index.js";
import { RequireAuth } from "../auth/index.js";
import { RequireFeature } from "../feature-flags/index.js";
import type { RbacRequest } from "../rbac/index.js";
import { PLACE_ERRORS, requestRegion, userOf, uuid, type AuthedRequest } from "./partner.controller.js";
import { PartnerPriceListDto, PRICE_LIST_MAX_ITEMS, PRICE_LIST_MAX_SECTIONS } from "./price-list.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CreatePriceItemDto,
  CreatePriceSectionDto,
  MovePriceListEntryDto,
  UpdatePriceItemDto,
  UpdatePriceSectionDto,
} from "./price-list.dto.js";
import { PriceListService } from "./price-list.service.js";

// Прайс заведения (миграция 0030) в кабинете партнёра: сессия Telegram, право price_list.manage (ORG_OWNER,
// ORG_MANAGER; кассиру — 403 role_forbidden), место → организация → регион из БД. Как у акций P07: архив вместо
// удаления, AuditLog. Каждое изменение отвечает прайсом целиком. Модуль — за флагом module.partner_cabinet.

const SECTION = { name: "sectionId", type: String, format: "uuid" } as const;
const ITEM = { name: "itemId", type: String, format: "uuid" } as const;
const PLACE = { name: "id", type: String, format: "uuid" } as const;

@ApiTags("partner")
@Controller("partner/places/:id/price-list")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.partner_cabinet", { region: requestRegion })
export class PriceListController {
  constructor(@Inject(PriceListService) private readonly prices: PriceListService) {}

  @Get()
  @ApiOperation({
    operationId: "getPartnerPriceList",
    summary: "Прайс заведения: разделы по порядку с позициями (без архивных)",
    description: "ORG_OWNER, ORG_MANAGER; кассиру — 403. 404 — место не найдено или не партнёрское.",
  })
  @ApiParam(PLACE)
  @ApiOkResponse({ type: PartnerPriceListDto })
  @ApiErrors(...PLACE_ERRORS)
  get(@Param("id", uuid) id: string, @Req() req: RbacRequest): Promise<PartnerPriceListDto> {
    return this.prices.get(userOf(req), id);
  }

  // --- разделы ---

  @Post("sections")
  @ApiOperation({
    operationId: "createPartnerPriceSection",
    summary: "Новый раздел («Страви», «Чани», «Номери») — в конец",
    description: `Не больше ${PRICE_LIST_MAX_SECTIONS} разделов — 422 errors.priceList.tooManySections. 409 errors.partner.placeNotEditable — место в архиве.`,
  })
  @ApiParam(PLACE)
  @ApiCreatedResponse({ type: PartnerPriceListDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT", "UNPROCESSABLE")
  createSection(
    @Param("id", uuid) id: string,
    @Body() body: CreatePriceSectionDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPriceListDto> {
    return this.prices.createSection(userOf(req), id, body, auditFromRequest(req));
  }

  @Patch("sections/:sectionId")
  @ApiOperation({
    operationId: "updatePartnerPriceSection",
    summary: "Переименовать раздел, скрыть/показать (hidden); version — 409 errors.priceList.versionConflict",
  })
  @ApiParam(PLACE)
  @ApiParam(SECTION)
  @ApiOkResponse({ type: PartnerPriceListDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT")
  updateSection(
    @Param("id", uuid) id: string,
    @Param("sectionId", uuid) sectionId: string,
    @Body() body: UpdatePriceSectionDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPriceListDto> {
    return this.prices.updateSection(userOf(req), id, sectionId, body, auditFromRequest(req));
  }

  @Post("sections/:sectionId/move")
  @HttpCode(200)
  @ApiOperation({
    operationId: "movePartnerPriceSection",
    summary: "▲▼ раздела: обмен местами с соседом; крайний — без изменений",
  })
  @ApiParam(PLACE)
  @ApiParam(SECTION)
  @ApiOkResponse({ type: PartnerPriceListDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT")
  moveSection(
    @Param("id", uuid) id: string,
    @Param("sectionId", uuid) sectionId: string,
    @Body() body: MovePriceListEntryDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPriceListDto> {
    return this.prices.moveSection(userOf(req), id, sectionId, body.direction, auditFromRequest(req));
  }

  @Post("sections/:sectionId/archive")
  @HttpCode(200)
  @ApiOperation({
    operationId: "archivePartnerPriceSection",
    summary: "Раздел в архив (вместо удаления) вместе с его позициями",
  })
  @ApiParam(PLACE)
  @ApiParam(SECTION)
  @ApiOkResponse({ type: PartnerPriceListDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT")
  archiveSection(
    @Param("id", uuid) id: string,
    @Param("sectionId", uuid) sectionId: string,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPriceListDto> {
    return this.prices.archiveSection(userOf(req), id, sectionId, auditFromRequest(req));
  }

  // --- позиции ---

  @Post("items")
  @ApiOperation({
    operationId: "createPartnerPriceItem",
    summary: "Новая позиция в разделе — в конец",
    description: `Не больше ${PRICE_LIST_MAX_ITEMS} позиций на место — 422 errors.priceList.tooManyItems. 404 — раздела нет.`,
  })
  @ApiParam(PLACE)
  @ApiCreatedResponse({ type: PartnerPriceListDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT", "UNPROCESSABLE")
  createItem(
    @Param("id", uuid) id: string,
    @Body() body: CreatePriceItemDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPriceListDto> {
    return this.prices.createItem(userOf(req), id, body, auditFromRequest(req));
  }

  @Patch("items/:itemId")
  @ApiOperation({
    operationId: "updatePartnerPriceItem",
    summary: "Правка позиции, скрыть/показать, перенос в другой раздел; version — 409 при расхождении",
  })
  @ApiParam(PLACE)
  @ApiParam(ITEM)
  @ApiOkResponse({ type: PartnerPriceListDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT")
  updateItem(
    @Param("id", uuid) id: string,
    @Param("itemId", uuid) itemId: string,
    @Body() body: UpdatePriceItemDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPriceListDto> {
    return this.prices.updateItem(userOf(req), id, itemId, body, auditFromRequest(req));
  }

  @Post("items/:itemId/move")
  @HttpCode(200)
  @ApiOperation({
    operationId: "movePartnerPriceItem",
    summary: "▲▼ позиции внутри раздела; крайняя — без изменений",
  })
  @ApiParam(PLACE)
  @ApiParam(ITEM)
  @ApiOkResponse({ type: PartnerPriceListDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT")
  moveItem(
    @Param("id", uuid) id: string,
    @Param("itemId", uuid) itemId: string,
    @Body() body: MovePriceListEntryDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPriceListDto> {
    return this.prices.moveItem(userOf(req), id, itemId, body.direction, auditFromRequest(req));
  }

  @Post("items/:itemId/archive")
  @HttpCode(200)
  @ApiOperation({ operationId: "archivePartnerPriceItem", summary: "Позиция в архив (вместо удаления)" })
  @ApiParam(PLACE)
  @ApiParam(ITEM)
  @ApiOkResponse({ type: PartnerPriceListDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT")
  archiveItem(
    @Param("id", uuid) id: string,
    @Param("itemId", uuid) itemId: string,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPriceListDto> {
    return this.prices.archiveItem(userOf(req), id, itemId, auditFromRequest(req));
  }
}
