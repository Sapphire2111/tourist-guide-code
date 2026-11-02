import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  MAX_UPLOAD_BYTES,
  MEDIA_KINDS,
  MEDIA_MIME_TYPES,
  MEDIA_OWNER_TYPES,
  MEDIA_REJECT_REASONS,
  MEDIA_STATUSES,
  type MediaKind,
  type MediaOwnerType,
  type MediaStatus,
} from "@tg/media";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import type { LocalizedText, MediaAsset } from "../../db/index.js";
import type { MediaLink } from "./media.service.js";

// DTO файлов (T1-20). Тип файла в заявке — строка: недопустимый тип отклоняет сервис (422 с причиной), а не
// валидация DTO, чтобы клиент получил понятную причину mime_not_allowed.

/** Альтернативный текст: uk обязателен (is_localized_text), en — необязателен; другие языки — с i18n (T1-15). */
export class MediaAltTextDto {
  @ApiProperty({ type: String, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  uk!: string;

  @ApiPropertyOptional({ type: String, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  en?: string;
}

export class CreateMediaUploadDto {
  @ApiProperty({ enum: MEDIA_OWNER_TYPES, enumName: "MediaOwnerType" })
  @IsIn(MEDIA_OWNER_TYPES)
  ownerType!: MediaOwnerType;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  ownerId!: string;

  @ApiProperty({ enum: MEDIA_KINDS, enumName: "MediaKind" })
  @IsIn(MEDIA_KINDS)
  kind!: MediaKind;

  @ApiProperty({
    type: String,
    example: "image/jpeg",
    description: `Заявленный тип: фото — ${MEDIA_MIME_TYPES.slice(0, 3).join(", ")}; документ — ещё application/pdf`,
  })
  @IsString()
  @MaxLength(100)
  mime!: string;

  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: MAX_UPLOAD_BYTES,
    description: "Точный размер файла, байт",
  })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  size!: number;

  @ApiPropertyOptional({ type: MediaAltTextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MediaAltTextDto)
  alt?: MediaAltTextDto;
}

export class MediaLinkDto {
  @ApiProperty({ type: String, description: "Вариант (w320, w800, w1600) или original — документ" })
  name!: string;
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "Срок подписанной ссылки; null — постоянный публичный адрес",
  })
  expiresAt!: string | null;
}

export class MediaAssetDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ enum: MEDIA_OWNER_TYPES, enumName: "MediaOwnerType" }) ownerType!: MediaOwnerType;
  @ApiProperty({ type: String, format: "uuid" }) ownerId!: string;
  @ApiProperty({ enum: MEDIA_KINDS, enumName: "MediaKind" }) kind!: MediaKind;
  @ApiProperty({ enum: MEDIA_STATUSES, enumName: "MediaStatus" }) status!: MediaStatus;
  @ApiProperty({ type: String }) mime!: string;
  @ApiProperty({ type: Number }) size!: number;
  @ApiProperty({ type: MediaAltTextDto, nullable: true }) alt!: LocalizedText | null;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: [...MEDIA_REJECT_REASONS],
    description: "Причина отклонения (status = rejected)",
  })
  rejectReason!: string | null;
  @ApiProperty({ type: [MediaLinkDto], description: "Ссылки на варианты (ready)" }) links!: MediaLinkDto[];
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class MediaUploadTargetDto {
  @ApiProperty({ type: String }) url!: string;
  @ApiProperty({ type: String, enum: ["PUT"] }) method!: "PUT";
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
    description: "Заголовки, которые обязательно отправить с PUT (входят в подпись)",
  })
  headers!: Record<string, string>;
  @ApiProperty({ type: String, format: "date-time" }) expiresAt!: string;
}

export class MediaUploadDto {
  @ApiProperty({ type: MediaAssetDto }) asset!: MediaAssetDto;
  @ApiProperty({ type: MediaUploadTargetDto }) upload!: MediaUploadTargetDto;
}

export function toMediaAssetDto(a: MediaAsset, links: readonly MediaLink[] = []): MediaAssetDto {
  return {
    id: a.id,
    regionId: a.region_id,
    ownerType: a.owner_type as MediaOwnerType,
    ownerId: a.owner_id,
    kind: a.kind as MediaKind,
    status: a.status as MediaStatus,
    mime: a.mime,
    size: a.size_bytes,
    alt: a.alt_i18n,
    width: a.width,
    height: a.height,
    rejectReason: a.reject_reason,
    links: links.map((l) => ({ ...l, expiresAt: l.expiresAt?.toISOString() ?? null })),
    createdAt: a.created_at.toISOString(),
  };
}
