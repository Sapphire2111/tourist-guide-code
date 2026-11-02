import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  ParseIntPipe,
  Query,
  Redirect,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { ApiError, ApiErrors, PublicCache } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import type { LonLat } from "../../db/index.js";
import { RequireAuth } from "../auth/index.js";
import { EmergencyContactListDto, toEmergencyContactDto } from "../emergency-contacts/index.js";
import { RateLimit, SkipIpRateLimit } from "../rate-limit/index.js";
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
import {
  AddFavoriteDto,
  CoverQueryDto,
  GooglePhotoQueryDto,
  OriginQueryDto,
  RegionQueryDto,
  SearchPlacesQueryDto,
} from "./guide.dto.js";
import { FAVORITES_MAX } from "./guide.repository.js";
import { GuideService } from "./guide.service.js";

// Публичный каталог туриста (блок 4, ADR-0019; C02, C04–C06, C14). Без tenant-контекста принципала
// (@WithoutTenantContext): у туриста назначений нет, регион — query regionId; сервис сам читает данные в
// withTenant(regionContext) — RLS и TenantGuardPlugin ограничивают чтение этим регионом. Регион не найден или не
// active — 404.

/**
 * Лимит поиска на пользователя (без сессии — на IP): текст ищется ILIKE без индекса (pg_trgm — позже, ADR-0019),
 * один турист столько не набирает.
 */
export const SEARCH_RATE_LIMIT = { limit: 60, windowSec: 60 } as const;

/** Лимит прокси фото Google на пользователя/IP: галерея — до 5 фото в 2 ширинах на карточку. */
export const GOOGLE_PHOTO_RATE_LIMIT = { limit: 120, windowSec: 60 } as const;
/** Сколько браузер кэширует редирект на файл фото (адрес Google живёт дольше). */
export const GOOGLE_PHOTO_CACHE_SEC = 6 * 3600;

/**
 * Лимит обложек на пользователя/IP: лента/карта — десятки карточек за прокрутку, файл маленький и у нас (без запросов
 * к Google), повторы браузер берёт из кэша или получает 304.
 */
export const COVER_RATE_LIMIT = { limit: 600, windowSec: 60 } as const;

/**
 * If-None-Match совпадает с ETag: список через запятую, слабые W/"…" (сравнение слабое, RFC 9110 §13.1.2), «*».
 */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  return raw
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === "*" || t === etag);
}

/** Обложка меняется только вместе с версией v в ссылке — кэш на неделю. */
export const COVER_CACHE_SEC = 7 * 24 * 3600;

type BinaryResponse = {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  end(body?: Buffer): unknown;
};

const photoIndex = new ParseIntPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_index" } }),
});

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
  @PublicCache(300)
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
  @RateLimit(SEARCH_RATE_LIMIT)
  @ApiOperation({
    operationId: "searchPlaces",
    summary: "Поиск мест: «Що поруч» (lat/lng + радиус), категория, текст q",
    description:
      "Без аутентификации. Только опубликованные места активного региона. С lat/lng — места в радиусе " +
      `(по умолчанию ${SEARCH_RADIUS_DEFAULT} м, максимум ${SEARCH_RADIUS_MAX} м), расстояние — PostGIS geography; ` +
      "без точки — весь регион (radius игнорируется). Порядок (BR-10, C-02): совпадение с q (начало названия → " +
      "название → адрес) → расстояние → «Ми рекомендуємо» → название uk. Платное размещение помечено adLabel и " +
      `порядок не меняет. available_now до блока 7 игнорируется. Страница — limit (по умолчанию ${SEARCH_LIMIT_DEFAULT}) ` +
      `и offset (nextOffset). Rate limit ${SEARCH_RATE_LIMIT.limit}/мин. 404 — региона нет или он не активен.`,
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

  @Get(":id/cover")
  @RateLimit(COVER_RATE_LIMIT)
  // <img> грузится без Bearer: лента обложек не должна съедать общий лимит IP (туристы за одним Wi-Fi).
  @SkipIpRateLimit()
  @ApiOperation({
    operationId: "getGuidePlaceCover",
    summary: "Обложка места (WebP ~400 px, хранится у нас): списки и карточка",
    description:
      'Без аутентификации. ETag и Cache-Control public на неделю; If-None-Match с тем же ETag (в т. ч. W/"…" ' +
      "и список) — 304. Источник, автор и лицензия — в coverPhoto выдачи (подпись обязательна). 404 — места или " +
      `обложки нет. Rate limit ${COVER_RATE_LIMIT.limit}/мин.`,
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiResponse({ status: 200, description: "image/webp" })
  @ApiResponse({ status: 304, description: "Не изменилась" })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  async cover(
    @Param("id", uuid) id: string,
    @Query() q: CoverQueryDto,
    @Req() req: RbacRequest & { headers: Record<string, string | string[] | undefined> },
    @Res() res: BinaryResponse,
  ): Promise<void> {
    const ifNoneMatch = req.headers["if-none-match"];
    const c = await this.guide.cover(q.regionId, id, (v) => etagMatches(ifNoneMatch, `"${v}"`));
    if (!c) throw new ApiError("NOT_FOUND");
    const etag = `"${c.etag}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", `public, max-age=${COVER_CACHE_SEC}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!c.bytes) {
      res.status(304);
      res.end();
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", c.mime);
    res.setHeader("Content-Length", String(c.bytes.length));
    res.end(c.bytes);
  }

  @Get(":id/google-photos/:index")
  @RateLimit(GOOGLE_PHOTO_RATE_LIMIT)
  @PublicCache(GOOGLE_PHOTO_CACHE_SEC)
  @Redirect()
  @ApiOperation({
    operationId: "getGuidePlaceGooglePhoto",
    summary: "Фото Google места (галерея картки): 302 на файл Google без ключа api",
    description:
      "Без аутентификации. index — номер в googlePhotos карточки, w — 400 (превью) или 1200. Файл не копируется: " +
      "api получает адрес у Google Place Photos (кэш в памяти и БД) и отвечает редиректом. 404 — места, фото нет " +
      `или Google недоступен (суточный предел запросов). Rate limit ${GOOGLE_PHOTO_RATE_LIMIT.limit}/мин.`,
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "index", schema: { type: "integer", minimum: 0, maximum: 4 } })
  @ApiResponse({ status: 302, description: "Location — файл фото на googleusercontent.com" })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  async googlePhoto(
    @Param("id", uuid) id: string,
    @Param("index", photoIndex) index: number,
    @Query() q: GooglePhotoQueryDto,
  ): Promise<{ url: string; statusCode: number }> {
    if (index < 0 || index > 4) throw new ApiError("NOT_FOUND");
    const url = await this.guide.googlePhoto(q.regionId, id, index, q.w ?? 400);
    if (!url) throw new ApiError("NOT_FOUND");
    return { url, statusCode: 302 };
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
    description:
      "404 — места нет в регионе или оно не опубликовано. 409 errors.favorites.limitReached — в избранном региона " +
      `уже ${FAVORITES_MAX} мест.`,
  })
  @ApiCreatedResponse({ type: FavoriteDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "CONFLICT", "RATE_LIMITED")
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
  @PublicCache(300)
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
