import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
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
  ApiTags,
} from "@nestjs/swagger";
import type { CursorPage } from "@tg/shared";
import { ApiCursorPage, ApiErrors } from "../../common/http/index.js";
import type { AuditableRequest } from "../audit/index.js";
import { RequirePermission, scopeFromTenant } from "../rbac/index.js";
import type { PlaceTransition } from "./catalog-rules.js";
import { auditMeta, call, decodeCursor, DEFAULT_PAGE_SIZE, encodeCursor, uuid } from "./catalog-http.js";
import {
  BadgeHistoryDto,
  placeInput,
  placeMediaInput,
  PlaceDto,
  PlaceMediaListDto,
  PublishCheckDto,
  scheduleInput,
  ScheduleDto,
  toBadgeEventDto,
  toPlaceDto,
  toPlaceMediaDto,
  toScheduleDto,
} from "./catalog.dto.js";
// Классы DTO нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AttachPlaceMediaDto,
  BadgeReasonDto,
  CreatePlaceDto,
  PlaceListQueryDto,
  PutScheduleDto,
  TransitionDto,
  UpdatePlaceDto,
  UpdatePlaceMediaDto,
} from "./catalog.dto.js";
import { CatalogService } from "./catalog.service.js";

const READ = "catalog.read.admin";
const ITEM_ERRORS = ["VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"] as const;
const WRITE_ERRORS = [...ITEM_ERRORS, "CONFLICT", "UNPROCESSABLE"] as const;

/**
 * Места каталога в админке (блок 3, ADR-0017): CRUD, статусы, график, фото, «Ми рекомендуємо». Правка — сразу в живую
 * версию (§1.6, без PlaceRevision); опубликованное место после правки должно остаться готовым к публикации (иначе 422
 * errors.place.notPublishable). Регион — из tenant-контекста; место другого региона — 404.
 */
@ApiTags("admin")
@Controller("admin/places")
export class PlacesController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({
    operationId: "listPlaces",
    summary: "Места региона (новые сверху): фильтры статус, категория (с подкатегориями), поиск по названию",
  })
  @ApiCursorPage(PlaceDto)
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN")
  async list(@Query() q: PlaceListQueryDto): Promise<CursorPage<PlaceDto>> {
    const limit = q.limit ?? DEFAULT_PAGE_SIZE;
    const afterId = decodeCursor(q.cursor);
    const { items, hasMore } = await call(() =>
      this.catalog.listPlaces({ status: q.status, categoryId: q.categoryId, q: q.q, afterId, limit }),
    );
    const last = items.at(-1);
    return {
      items: items.map((p) => toPlaceDto(p)),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  @Get(":id")
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "getPlace", summary: "Место" })
  @ApiOkResponse({ type: PlaceDto })
  @ApiErrors(...ITEM_ERRORS)
  async get(@Param("id", uuid) id: string): Promise<PlaceDto> {
    return toPlaceDto(await call(() => this.catalog.getPlace(id)));
  }

  @Post()
  @RequirePermission("place.create", scopeFromTenant)
  @ApiOperation({ operationId: "createPlace", summary: "Новое место (черновик)" })
  @ApiCreatedResponse({ type: PlaceDto })
  @ApiErrors(...WRITE_ERRORS)
  async create(@Body() body: CreatePlaceDto, @Req() req: AuditableRequest): Promise<PlaceDto> {
    const input = { ...placeInput(body), categoryId: body.categoryId, name: { ...body.name } };
    return toPlaceDto(await call(() => this.catalog.createPlace(auditMeta(req), input)));
  }

  @Patch(":id")
  @RequirePermission("place.edit", scopeFromTenant)
  @ApiOperation({ operationId: "updatePlace", summary: "Изменить место (сразу в живую версию)" })
  @ApiOkResponse({ type: PlaceDto })
  @ApiErrors(...WRITE_ERRORS)
  async update(
    @Param("id", uuid) id: string,
    @Body() body: UpdatePlaceDto,
    @Req() req: AuditableRequest,
  ): Promise<PlaceDto> {
    return toPlaceDto(await call(() => this.catalog.updatePlace(auditMeta(req), id, placeInput(body))));
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermission("place.archive", scopeFromTenant)
  @ApiOperation({
    operationId: "deletePlace",
    summary: "Удалить черновик, который ни разу не публиковался (иначе 409 — используйте архив)",
  })
  @ApiNoContentResponse()
  @ApiErrors(...WRITE_ERRORS)
  async remove(@Param("id", uuid) id: string, @Req() req: AuditableRequest): Promise<void> {
    await call(() => this.catalog.deletePlace(auditMeta(req), id));
  }

  @Get(":id/publish-check")
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "checkPlacePublishable", summary: "Что мешает публикации (пусто — можно)" })
  @ApiOkResponse({ type: PublishCheckDto })
  @ApiErrors(...ITEM_ERRORS)
  async publishCheck(@Param("id", uuid) id: string): Promise<PublishCheckDto> {
    return { problems: await call(() => this.catalog.publishCheck(id)) };
  }

  @Post(":id/publish")
  @HttpCode(200)
  @RequirePermission("place.publish", scopeFromTenant)
  @ApiOperation({
    operationId: "publishPlace",
    summary:
      "Опубликовать: нужны описание, адрес, точка, активная категория и alt text у всех фото (иначе 422)",
  })
  @ApiOkResponse({ type: PlaceDto })
  @ApiErrors(...WRITE_ERRORS)
  publish(@Param("id", uuid) id: string, @Body() body: TransitionDto, @Req() req: AuditableRequest) {
    return this.transition(id, "publish", body, req);
  }

  @Post(":id/suspend")
  @HttpCode(200)
  @RequirePermission("place.suspend", scopeFromTenant)
  @ApiOperation({
    operationId: "suspendPlace",
    summary: "Приостановить опубликованное место (скрыть от туристов)",
  })
  @ApiOkResponse({ type: PlaceDto })
  @ApiErrors(...WRITE_ERRORS)
  suspend(@Param("id", uuid) id: string, @Body() body: TransitionDto, @Req() req: AuditableRequest) {
    return this.transition(id, "suspend", body, req);
  }

  @Post(":id/archive")
  @HttpCode(200)
  @RequirePermission("place.archive", scopeFromTenant)
  @ApiOperation({ operationId: "archivePlace", summary: "В архив" })
  @ApiOkResponse({ type: PlaceDto })
  @ApiErrors(...WRITE_ERRORS)
  archive(@Param("id", uuid) id: string, @Body() body: TransitionDto, @Req() req: AuditableRequest) {
    return this.transition(id, "archive", body, req);
  }

  private async transition(
    id: string,
    action: PlaceTransition,
    body: TransitionDto,
    req: AuditableRequest,
  ): Promise<PlaceDto> {
    return toPlaceDto(
      await call(() => this.catalog.transition(auditMeta(req), id, action, body.reason?.trim() || null)),
    );
  }

  // --- график ---

  @Get(":id/schedule")
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "getPlaceSchedule", summary: "График: недельные интервалы и исключения" })
  @ApiOkResponse({ type: ScheduleDto })
  @ApiErrors(...ITEM_ERRORS)
  async getSchedule(@Param("id", uuid) id: string): Promise<ScheduleDto> {
    return toScheduleDto(await call(() => this.catalog.getSchedule(id)));
  }

  @Put(":id/schedule")
  @RequirePermission("schedule.edit", scopeFromTenant)
  @ApiOperation({
    operationId: "replacePlaceSchedule",
    summary: "Заменить график целиком (время — местное, таймзона региона)",
  })
  @ApiOkResponse({ type: ScheduleDto })
  @ApiErrors(...WRITE_ERRORS)
  async putSchedule(
    @Param("id", uuid) id: string,
    @Body() body: PutScheduleDto,
    @Req() req: AuditableRequest,
  ): Promise<ScheduleDto> {
    return toScheduleDto(
      await call(() => this.catalog.replaceSchedule(auditMeta(req), id, scheduleInput(body))),
    );
  }

  // --- фото ---

  @Get(":id/media")
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({ operationId: "listPlaceMedia", summary: "Фото места по порядку" })
  @ApiOkResponse({ type: PlaceMediaListDto })
  @ApiErrors(...ITEM_ERRORS)
  async listMedia(@Param("id", uuid) id: string): Promise<PlaceMediaListDto> {
    return { items: (await call(() => this.catalog.listMedia(id))).map(toPlaceMediaDto) };
  }

  @Post(":id/media")
  @RequirePermission("media.upload", scopeFromTenant)
  @ApiOperation({
    operationId: "attachPlaceMedia",
    summary: "Привязать загруженное фото (POST /media/uploads с ownerType place и ownerId места)",
  })
  @ApiCreatedResponse({ type: PlaceMediaListDto })
  @ApiErrors(...WRITE_ERRORS)
  async attachMedia(
    @Param("id", uuid) id: string,
    @Body() body: AttachPlaceMediaDto,
    @Req() req: AuditableRequest,
  ): Promise<PlaceMediaListDto> {
    const items = await call(() =>
      this.catalog.attachMedia(auditMeta(req), id, body.mediaAssetId.toLowerCase(), placeMediaInput(body)),
    );
    return { items: items.map(toPlaceMediaDto) };
  }

  @Patch(":id/media/:mediaAssetId")
  @RequirePermission("media.upload", scopeFromTenant)
  @ApiOperation({ operationId: "updatePlaceMedia", summary: "Alt text, порядок, обложка" })
  @ApiOkResponse({ type: PlaceMediaListDto })
  @ApiErrors(...WRITE_ERRORS)
  async updateMedia(
    @Param("id", uuid) id: string,
    @Param("mediaAssetId", uuid) mediaAssetId: string,
    @Body() body: UpdatePlaceMediaDto,
    @Req() req: AuditableRequest,
  ): Promise<PlaceMediaListDto> {
    const items = await call(() =>
      this.catalog.updateMedia(auditMeta(req), id, mediaAssetId.toLowerCase(), placeMediaInput(body)),
    );
    return { items: items.map(toPlaceMediaDto) };
  }

  @Delete(":id/media/:mediaAssetId")
  @HttpCode(204)
  @RequirePermission("media.upload", scopeFromTenant)
  @ApiOperation({ operationId: "detachPlaceMedia", summary: "Отвязать фото (файл остаётся)" })
  @ApiNoContentResponse()
  @ApiErrors(...ITEM_ERRORS)
  async detachMedia(
    @Param("id", uuid) id: string,
    @Param("mediaAssetId", uuid) mediaAssetId: string,
    @Req() req: AuditableRequest,
  ): Promise<void> {
    await call(() => this.catalog.detachMedia(auditMeta(req), id, mediaAssetId.toLowerCase()));
  }

  // --- «Ми рекомендуємо» ---

  @Post(":id/badge")
  @HttpCode(200)
  @RequirePermission("badge.recommend.grant", scopeFromTenant)
  @ApiOperation({ operationId: "grantPlaceBadge", summary: "Выдать «Ми рекомендуємо» с причиной (D-32)" })
  @ApiOkResponse({ type: PlaceDto })
  @ApiErrors(...WRITE_ERRORS)
  async grantBadge(
    @Param("id", uuid) id: string,
    @Body() body: BadgeReasonDto,
    @Req() req: AuditableRequest,
  ): Promise<PlaceDto> {
    return toPlaceDto(await call(() => this.catalog.setBadge(auditMeta(req), id, true, body.reason.trim())));
  }

  @Delete(":id/badge")
  @HttpCode(200)
  @RequirePermission("badge.recommend.revoke", scopeFromTenant)
  @ApiOperation({
    operationId: "revokePlaceBadge",
    summary: "Снять «Ми рекомендуємо» с причиной (тело запроса)",
  })
  @ApiOkResponse({ type: PlaceDto })
  @ApiErrors(...WRITE_ERRORS)
  async revokeBadge(
    @Param("id", uuid) id: string,
    @Body() body: BadgeReasonDto,
    @Req() req: AuditableRequest,
  ): Promise<PlaceDto> {
    return toPlaceDto(await call(() => this.catalog.setBadge(auditMeta(req), id, false, body.reason.trim())));
  }

  @Get(":id/badge/history")
  @RequirePermission(READ, scopeFromTenant)
  @ApiOperation({
    operationId: "getPlaceBadgeHistory",
    summary: "История выдачи и снятия бейджа (новые сверху)",
  })
  @ApiOkResponse({ type: BadgeHistoryDto })
  @ApiErrors(...ITEM_ERRORS)
  async badgeHistory(@Param("id", uuid) id: string): Promise<BadgeHistoryDto> {
    return { items: (await call(() => this.catalog.badgeHistory(id))).map(toBadgeEventDto) };
  }
}
