import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";
import {
  PLACE_CLAIM_PHONE_SOURCES,
  PLACE_CLAIM_ROLES,
  PLACE_CLAIM_STATUSES,
  PLACE_STATUSES,
  type PlaceClaimPhoneSource,
  type PlaceClaimRole,
  type PlaceClaimStatus,
  type PlaceStatus,
} from "../../db/index.js";
import { ShortTextDto } from "../catalog/index.js";
import { MODERATION_COMMENT_MAX } from "./partner.dto.js";

// DTO заявки «Це мій заклад» (0031): подача из карточки места (Mini App), статус в кабинете партнёра, очередь и
// решение модератора (AD02, вкладка «Заявки на заклад»).

/** Телефон E.164 (как бронь, D-42). */
export const CLAIM_PHONE_RE = /^\+[1-9][0-9]{7,14}$/;
export const CLAIM_COMMENT_MAX = 1000;
export const CLAIM_ORGANIZATION_NAME_MAX = 200;

const ROLE_ENUM = { enum: PLACE_CLAIM_ROLES, enumName: "PlaceClaimRole" } as const;
const STATUS_ENUM = { enum: PLACE_CLAIM_STATUSES, enumName: "PlaceClaimStatus" } as const;

export class CreatePlaceClaimDto {
  @ApiProperty({ type: String, format: "uuid", description: "Регион места" })
  @IsUUID()
  regionId!: string;

  @ApiProperty({
    type: String,
    format: "uuid",
    description: "Место каталога (опубликованное, без организации)",
  })
  @IsUUID()
  placeId!: string;

  @ApiProperty({ ...ROLE_ENUM, description: "Роль заявителя в заведении: власник / керуючий" })
  @IsIn(PLACE_CLAIM_ROLES)
  role!: PlaceClaimRole;

  @ApiProperty({
    type: String,
    example: "+380501234567",
    description: "Телефон для звонка модератора (E.164)",
  })
  @Matches(CLAIM_PHONE_RE)
  phone!: string;

  @ApiProperty({
    enum: PLACE_CLAIM_PHONE_SOURCES,
    enumName: "PlaceClaimPhoneSource",
    description: "telegram_contact — requestContact Telegram; manual — введён вручную",
  })
  @IsIn(PLACE_CLAIM_PHONE_SOURCES)
  phoneSource!: PlaceClaimPhoneSource;

  @ApiPropertyOptional({ type: String, maxLength: CLAIM_COMMENT_MAX, description: "Комментарий модератору" })
  @IsOptional()
  @IsString()
  @MaxLength(CLAIM_COMMENT_MAX)
  comment?: string;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Существующая организация, где заявитель ORG_OWNER (или organizationName — не оба)",
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: CLAIM_ORGANIZATION_NAME_MAX,
    description: "Название новой организации — создаётся при одобрении (или organizationId — не оба)",
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(CLAIM_ORGANIZATION_NAME_MAX)
  organizationName?: string;
}

export class PlaceClaimsQueryDto {
  @ApiProperty({ type: String, format: "uuid", description: "Регион (заявки пользователя в нём)" })
  @IsUUID()
  regionId!: string;
}

/** Заявка для заявителя (кабинет партнёра): статус и комментарий модератора. */
export class PlaceClaimDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: ShortTextDto }) placeName!: ShortTextDto;
  @ApiProperty({ ...ROLE_ENUM }) role!: PlaceClaimRole;
  @ApiProperty({ ...STATUS_ENUM }) status!: PlaceClaimStatus;
  @ApiProperty({ type: String, nullable: true, description: "Организация (существующая или итоговая)" })
  organizationId!: string | null;
  @ApiProperty({ type: String, description: "Название организации (существующей или новой)" })
  organizationName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Комментарий модератора (обязателен при отказе)",
  })
  decisionComment!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Причина отмены одобрения (status = revoked)" })
  revokeReason!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) decidedAt!: string | null;
}

export class PlaceClaimListDto {
  @ApiProperty({ type: [PlaceClaimDto], description: "Новые сверху" }) items!: PlaceClaimDto[];
}

// --- модерация (админка, AD02 «Заявки на заклад») ---

export const CLAIM_QUEUE_STATUSES = ["pending", "decided"] as const;
export type ClaimQueueStatus = (typeof CLAIM_QUEUE_STATUSES)[number];

export class PlaceClaimQueueQueryDto {
  @ApiPropertyOptional({
    enum: CLAIM_QUEUE_STATUSES,
    enumName: "PlaceClaimQueueStatus",
    description: "pending (по умолчанию) — на рассмотрении; decided — одобренные, отклонённые, отозванные",
  })
  @IsOptional()
  @IsIn(CLAIM_QUEUE_STATUSES)
  status?: ClaimQueueStatus;

  @ApiPropertyOptional({ type: String, format: "uuid", description: "Регион (модератор — только свой)" })
  @IsOptional()
  @IsUUID()
  regionId?: string;
}

export class PlaceClaimSummaryDto extends PlaceClaimDto {
  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  @ApiProperty({ type: String, nullable: true, description: "Имя заявителя" }) claimantName!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Telegram username заявителя" })
  claimantUsername!: string | null;
  @ApiProperty({ type: Boolean, description: "Новая организация (создаётся при одобрении)" })
  newOrganization!: boolean;
  @ApiProperty({ type: String, nullable: true, description: "Кто решил: имя или логин админки" })
  decidedByName!: string | null;
  @ApiProperty({
    type: Boolean,
    description: "Своя заявка или организация модератора: решить нельзя — 403 own_claim / own_organization",
  })
  own!: boolean;
}

export class PlaceClaimQueueDto {
  @ApiProperty({ type: [PlaceClaimSummaryDto], description: "На рассмотрении — старые сверху" })
  items!: PlaceClaimSummaryDto[];
}

/** Карточка места для проверки: телефон, сайт и Google Maps — модератор звонит на номер Google (D-47 А). */
export class PlaceClaimPlaceDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: ShortTextDto }) name!: ShortTextDto;
  @ApiProperty({ enum: PLACE_STATUSES, enumName: "PlaceStatus" }) status!: PlaceStatus;
  @ApiProperty({ type: String, enum: ["manual", "google"] }) source!: "manual" | "google";
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Телефон места (Google или админка)" })
  phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) website!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Место в Google Maps" }) googleMapsUri!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true, description: "Название категории (uk)" }) category!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true, description: "Организация места сейчас (уже заявлено)" })
  organizationName!: string | null;
}

export class PlaceClaimDetailDto extends PlaceClaimSummaryDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Телефон заявителя (E.164); null — стёрт через 90 дней после решения",
  })
  phone!: string | null;
  @ApiProperty({ enum: PLACE_CLAIM_PHONE_SOURCES, enumName: "PlaceClaimPhoneSource" })
  phoneSource!: PlaceClaimPhoneSource;
  @ApiProperty({ type: String, nullable: true, description: "Комментарий заявителя" }) comment!:
    | string
    | null;
  @ApiProperty({ type: PlaceClaimPlaceDto }) place!: PlaceClaimPlaceDto;
  @ApiProperty({
    type: [PlaceClaimSummaryDto],
    description: "Другие заявки на это место (конкурирующие и прошлые), новые сверху",
  })
  otherClaims!: PlaceClaimSummaryDto[];
}

export class ApprovePlaceClaimDto {
  @ApiPropertyOptional({ type: String, maxLength: MODERATION_COMMENT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(MODERATION_COMMENT_MAX)
  comment?: string;
}

export class RejectPlaceClaimDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: MODERATION_COMMENT_MAX,
    description: "Причина (обязательна, видна заявителю)",
  })
  @IsString()
  @MinLength(1)
  @Matches(/\S/)
  @MaxLength(MODERATION_COMMENT_MAX)
  reason!: string;
}
