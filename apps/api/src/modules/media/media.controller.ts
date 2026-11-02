import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { ErrorCode } from "@tg/shared";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { currentTenant } from "../../db/index.js";
import { RequirePermission, scopeFromTenant, type RbacRequest } from "../rbac/index.js";
import { MediaAssetDto, MediaUploadDto, toMediaAssetDto } from "./media.dto.js";
// Класс DTO нужен в рантайме: emitDecoratorMetadata передаёт его в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateMediaUploadDto } from "./media.dto.js";
import { MediaError, MediaService } from "./media.service.js";

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

/**
 * Файлы и изображения (T1-20, ADR-0013): право media.upload в регионе запроса. Сам файл через api не идёт:
 * клиент кладёт его PUT по подписанной ссылке прямо в хранилище (local-драйвер — на /storage/objects).
 * Публичная выдача фото туристу — с карточкой места (блок 4) через ссылки вариантов.
 */
@ApiTags("media")
@Controller("media")
@RequirePermission("media.upload", scopeFromTenant)
export class MediaController {
  constructor(@Inject(MediaService) private readonly media: MediaService) {}

  @Post("uploads")
  @ApiOperation({
    operationId: "createMediaUpload",
    summary: "Заявка на загрузку: проверка типа и размера, подписанная ссылка PUT",
  })
  @ApiCreatedResponse({ type: MediaUploadDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "UNPROCESSABLE")
  async create(@Body() body: CreateMediaUploadDto, @Req() req: RbacRequest): Promise<MediaUploadDto> {
    const { asset, upload } = await this.media
      .createUpload({
        regionId: regionOfRequest(),
        ownerType: body.ownerType,
        ownerId: body.ownerId,
        kind: body.kind,
        mime: body.mime,
        size: body.size,
        alt: body.alt ? { ...body.alt } : null,
        createdBy: req.principal?.userId ?? null,
      })
      .catch(rethrow);
    return {
      asset: toMediaAssetDto(asset),
      upload: { ...upload, expiresAt: upload.expiresAt.toISOString() },
    };
  }

  @Post(":id/confirm")
  @HttpCode(200)
  @ApiOperation({
    operationId: "confirmMediaUpload",
    summary: "Подтвердить загрузку: размер и сигнатура файла; не тот тип — status rejected, файл удалён",
  })
  @ApiOkResponse({ type: MediaAssetDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT")
  async confirm(@Param("id", uuid) id: string): Promise<MediaAssetDto> {
    regionOfRequest();
    const asset = await this.media.confirm(id).catch(rethrow);
    if (!asset) throw new ApiError("NOT_FOUND");
    return toMediaAssetDto(asset, await this.media.links(asset));
  }

  @Get(":id")
  @ApiOperation({
    operationId: "getMediaAsset",
    summary: "Файл и ссылки на варианты (документ — короткая подпись)",
  })
  @ApiOkResponse({ type: MediaAssetDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async get(@Param("id", uuid) id: string): Promise<MediaAssetDto> {
    regionOfRequest();
    const asset = await this.media.find(id);
    if (!asset) throw new ApiError("NOT_FOUND");
    return toMediaAssetDto(asset, await this.media.links(asset));
  }
}

/** Регион запроса: файл принадлежит региону, поэтому нужен контекст региона (PLATFORM без выбранного — 403). */
function regionOfRequest(): string {
  const tenant = currentTenant();
  if (tenant?.kind !== "region")
    throw new ApiError("FORBIDDEN", { details: { reason: "region_context_required" } });
  return tenant.regionId;
}

const ERROR_CODE = {
  mime_not_allowed: "UNPROCESSABLE",
  size_invalid: "UNPROCESSABLE",
  size_too_large: "UNPROCESSABLE",
  owner_region_mismatch: "UNPROCESSABLE",
  not_uploaded: "CONFLICT",
} as const satisfies Record<MediaError["reason"], ErrorCode>;

function rethrow(e: unknown): never {
  if (!(e instanceof MediaError)) throw e;
  throw new ApiError(ERROR_CODE[e.reason], { details: { reason: e.reason }, cause: e });
}
