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
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import type { LonLat } from "../../db/index.js";
import { RequireAuth } from "../auth/index.js";
import { EmergencyContactListDto, toEmergencyContactDto } from "../emergency-contacts/index.js";
import type { RbacRequest } from "../rbac/index.js";
import {
  FavoriteDto,
  FavoriteListDto,
  GuideCategoryListDto,
  PlaceCardDto,
  PlaceSearchResultDto,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_RADIUS_DEFAULT,
  SEARCH_RADIUS_MAX,
} from "./guide.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AddFavoriteDto, OriginQueryDto, RegionQueryDto, SearchPlacesQueryDto } from "./guide.dto.js";
import { GuideService } from "./guide.service.js";

// Публичный каталог туриста (блок 4, ADR-0019; C02, C04–C06, C14). Без tenant-контекста принципала
// (@WithoutTenantContext): у туриста назначений нет, регион — query regionId; сервис сам читает данные в
// withTenant(regionContext) — RLS и TenantGuardPlugin ограничивают чтение этим регионом. Регион не найден или не
// active — 404.

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

/** lat и lng — только парой; иначе 400 по недостающему полю. */
export function originOf(q: { lat?: number; lng?: number }): LonLat | undefined {
  if (q.lat === undefined && q.lng === undefined) return undefined;
  if (q.lat === undefined || q.lng === undefined) {
    const field = q.lat === undefined ? "lat" : "lng";
    throw new ApiError("VALIDATION_FAILED", {
      details: { fields: [{ field, constraint: "isDefined", messageKey: "errors.validation.isDefined" }] },
    });
  }
  return { lon: q.lng, lat: q.lat };
}

@ApiTags("guide")
@Controller("categories")
@WithoutTenantContext()
export class GuideCategoriesController {
  constructor(@Inject(GuideService) private readonly guide: GuideService) {}

  @Get()
  // Справочник меняется редко; ответ одинаков для всех туристов региона.
  @Header("Cache-Control", "public, max-age=300")
  @ApiOperation({
    operationId: "listGuideCategories",
    summary: "Категории региона для туриста (главная C02, разделы C04): активные, с числом мест",
    description: "Без аутентификации. 404 — региона нет или он не активен.",
  })
  @ApiOkResponse({ type: GuideCategoryListDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  list(@Query() q: RegionQueryDto): Promise<GuideCategoryListDto> {
    return this.guide.categories(q.regionId);
  }
}

@ApiTags("guide")
@Controller("places")
@WithoutTenantContext()
export class GuidePlacesController {
  constructor(@Inject(GuideService) private readonly guide: GuideService) {}

  // До ":id": порядок объявления — порядок маршрутов Express.
  @Get("search")
  @ApiOperation({
    operationId: "searchPlaces",
    summary: "Поиск мест: «Що поруч» (lat/lng + радиус), категория, текст q",
    description:
      "Без аутентификации. Только опубликованные места активного региона. С lat/lng — места в радиусе " +
      `(по умолчанию ${SEARCH_RADIUS_DEFAULT} м, максимум ${SEARCH_RADIUS_MAX} м), расстояние — PostGIS geography; ` +
      "без точки — весь регион (radius игнорируется). Порядок (BR-10, C-02): совпадение с q (начало названия → " +
      "название → адрес) → расстояние → «Ми рекомендуємо» → название uk. Платное размещение помечено adLabel и " +
      `порядок не меняет. available_now до блока 7 игнорируется. Страница — limit (по умолчанию ${SEARCH_LIMIT_DEFAULT}) ` +
      "и offset (nextOffset). 404 — региона нет или он не активен.",
  })
  @ApiOkResponse({ type: PlaceSearchResultDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  search(@Query() q: SearchPlacesQueryDto): Promise<PlaceSearchResultDto> {
    const origin = originOf(q);
    return this.guide.search(q.regionId, {
      origin,
      radius: origin ? (q.radius ?? SEARCH_RADIUS_DEFAULT) : undefined,
      categoryId: q.category,
      text: q.q?.trim() || undefined,
      limit: q.limit ?? SEARCH_LIMIT_DEFAULT,
      offset: q.offset ?? 0,
    });
  }

  @Get(":id")
  @ApiOperation({
    operationId: "getGuidePlace",
    summary: "Картка місця (C05): фото, атрибуты, график, «Відкрито зараз», контакты, точка для маршрута",
    description:
      "Без аутентификации; с Bearer-сессией — признак favorite. Неопубликованное (черновик, приостановленное, " +
      "архив) или чужого региона — 404. lat/lng — для distanceMeters.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PlaceCardDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  async get(
    @Param("id", uuid) id: string,
    @Query() q: OriginQueryDto,
    @Req() req: RbacRequest,
  ): Promise<PlaceCardDto> {
    const card = await this.guide.place(q.regionId, id, {
      origin: originOf(q),
      userId: req.principal?.userId,
    });
    if (!card) throw new ApiError("NOT_FOUND");
    return card;
  }
}

@ApiTags("guide")
@Controller("favorites")
@RequireAuth()
@WithoutTenantContext()
export class FavoritesController {
  constructor(@Inject(GuideService) private readonly guide: GuideService) {}

  @Get()
  @ApiOperation({ operationId: "listFavorites", summary: "Избранные места туриста в регионе" })
  @ApiOkResponse({ type: FavoriteListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  list(@Query() q: RegionQueryDto, @Req() req: RbacRequest): Promise<FavoriteListDto> {
    return this.guide.favorites(q.regionId, userOf(req));
  }

  @Post()
  @ApiOperation({
    operationId: "addFavorite",
    summary: "Добавить место в избранное (повтор — без изменений, тот же ответ)",
    description: "404 — места нет в регионе или оно не опубликовано.",
  })
  @ApiCreatedResponse({ type: FavoriteDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  async add(@Body() body: AddFavoriteDto, @Req() req: RbacRequest): Promise<FavoriteDto> {
    const fav = await this.guide.addFavorite(body.regionId, userOf(req), body.placeId);
    if (!fav) throw new ApiError("NOT_FOUND");
    return fav;
  }

  @Delete(":placeId")
  @HttpCode(204)
  @ApiOperation({
    operationId: "removeFavorite",
    summary: "Убрать место из избранного (уже нет — тоже 204)",
  })
  @ApiParam({ name: "placeId", type: String, format: "uuid" })
  @ApiNoContentResponse({ description: "Убрано" })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  async remove(
    @Param("placeId", uuid) placeId: string,
    @Query() q: RegionQueryDto,
    @Req() req: RbacRequest,
  ): Promise<void> {
    await this.guide.removeFavorite(q.regionId, userOf(req), placeId);
  }
}

/**
 * «Халепа?» (C14) по региону туриста в query — тот же список, что GET /regions/{regionId}/emergency-contacts, в
 * форме остальных эндпоинтов гида.
 */
@ApiTags("guide")
@Controller("emergency-contacts")
@WithoutTenantContext()
export class GuideEmergencyContactsController {
  constructor(@Inject(GuideService) private readonly guide: GuideService) {}

  @Get()
  @Header("Cache-Control", "public, max-age=300")
  @ApiOperation({
    operationId: "listGuideEmergencyContacts",
    summary: "Экстренные контакты региона туриста («Халепа?»), только активные, по порядку",
    description: "Без аутентификации. 404 — региона нет или он не активен.",
  })
  @ApiOkResponse({ type: EmergencyContactListDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  async list(@Query() q: RegionQueryDto): Promise<EmergencyContactListDto> {
    const rows = await this.guide.emergencyContacts(q.regionId);
    return { items: rows.map(toEmergencyContactDto) };
  }
}

function userOf(req: RbacRequest): string {
  const userId = req.principal?.userId;
  if (!userId) throw new ApiError("UNAUTHENTICATED");
  return userId;
}
