import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import {
  CursorQueryDto,
  LocalizedDescriptionDto,
  LocalizedNameDto,
  LocalizedTextDto,
} from "../../common/http/index.js";
import { QR_POINT_TYPES, type LocalizedText, type QrPoint, type QrPointType } from "../../db/index.js";

// DTO админского API QR-точек (блок 3, AD04; ADR-0016, ADR-0018). Форматы — как CHECK миграции 0011.

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
const HTTPS_URL = /^https:\/\/\S+$/;

/** «Про заклад» для QR отеля (до Place блока 3): название обязательно. */
export class QrVenueInputDto {
  @ApiProperty({ type: LocalizedNameDto })
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name!: LocalizedNameDto;

  @ApiPropertyOptional({ type: LocalizedDescriptionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedDescriptionDto)
  description?: LocalizedDescriptionDto | null;

  @ApiPropertyOptional({ type: LocalizedDescriptionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedDescriptionDto)
  address?: LocalizedDescriptionDto | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "+380501234567", description: "E.164" })
  @IsOptional()
  @Matches(E164)
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300, example: "https://hotel.example" })
  @IsOptional()
  @Matches(HTTPS_URL)
  @MaxLength(300)
  website?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "test_hotel", description: "Без @" })
  @IsOptional()
  @Matches(TELEGRAM_USERNAME)
  telegram?: string | null;
}

export class CreateQrPointDto {
  @ApiProperty({ enum: QR_POINT_TYPES, enumName: "QrPointType" })
  @IsIn(QR_POINT_TYPES)
  type!: QrPointType;

  @ApiProperty({ type: String, maxLength: 200, description: "Подпись для админки; туристу не показывается" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label!: string;

  @ApiPropertyOptional({
    type: String,
    example: "summer-2026",
    description: "Метка кампании (обязательна у type=campaign)",
  })
  @IsOptional()
  @Matches(SLUG)
  campaign?: string;

  @ApiPropertyOptional({ type: String, example: "sticker", description: "Канал размещения" })
  @IsOptional()
  @Matches(SLUG)
  source?: string;

  @ApiPropertyOptional({ type: String, format: "uuid", description: "Место каталога (блок 3)" })
  @IsOptional()
  @IsUUID()
  placeId?: string;

  @ApiPropertyOptional({ type: QrVenueInputDto, description: "Только у type=hotel" })
  @IsOptional()
  @ValidateNested()
  @Type(() => QrVenueInputDto)
  venue?: QrVenueInputDto;
}

/** Правка: тип и код не меняются (перевыпуск — новая точка); null — очистить поле. */
export class UpdateQrPointDto {
  @ApiPropertyOptional({ type: String, maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((o: UpdateQrPointDto) => o.campaign !== undefined && o.campaign !== null)
  @Matches(SLUG)
  campaign?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((o: UpdateQrPointDto) => o.source !== undefined && o.source !== null)
  @Matches(SLUG)
  source?: string | null;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  @ValidateIf((o: UpdateQrPointDto) => o.placeId !== undefined && o.placeId !== null)
  @IsUUID()
  placeId?: string | null;

  @ApiPropertyOptional({
    type: QrVenueInputDto,
    nullable: true,
    description: "«Про заклад» целиком (замена); null — убрать",
  })
  @ValidateIf((o: UpdateQrPointDto) => o.venue !== undefined && o.venue !== null)
  @ValidateNested()
  @Type(() => QrVenueInputDto)
  venue?: QrVenueInputDto | null;
}

export class QrPointsQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: QR_POINT_TYPES, enumName: "QrPointType" })
  @IsOptional()
  @IsIn(QR_POINT_TYPES)
  type?: QrPointType;

  @ApiPropertyOptional({
    type: Boolean,
    description: "true — только активные, false — только деактивированные",
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === "true" ? true : value === "false" ? false : value))
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: String, example: "summer-2026" })
  @IsOptional()
  @Matches(SLUG)
  campaign?: string;
}

export class QrVenueDto {
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedTextDto;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) description!: LocalizedTextDto | null;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) address!: LocalizedTextDto | null;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) website!: string | null;
  @ApiProperty({ type: String, nullable: true }) telegram!: string | null;
}

export class AdminQrPointDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String, description: "Непрозрачный код startapp (генерирует сервер)" }) code!: string;
  @ApiProperty({ enum: QR_POINT_TYPES, enumName: "QrPointType" }) type!: QrPointType;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String, nullable: true }) campaign!: string | null;
  @ApiProperty({ type: String, nullable: true }) source!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) placeId!: string | null;
  @ApiProperty({ type: Boolean }) active!: boolean;
  @ApiProperty({ type: QrVenueDto, nullable: true }) venue!: QrVenueDto | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class QrPointPrintDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({
    type: String,
    example: "https://t.me/tourist_guide_bot?startapp=demoHotel01",
    description: "Ссылка, которую кодирует QR: открывает Mini App с start_param = code",
  })
  deepLink!: string;
  @ApiProperty({
    type: String,
    description: "QR-код ссылки в SVG (коррекция ошибок M, поле 4 модуля), для печати без доработки",
  })
  svg!: string;
}

const localized = (v: LocalizedText | null): LocalizedTextDto | null => v;

export function toAdminQrPointDto(row: QrPoint): AdminQrPointDto {
  return {
    id: row.id,
    regionId: row.region_id,
    code: row.code,
    type: row.type,
    label: row.label,
    campaign: row.campaign,
    source: row.source,
    placeId: row.place_id,
    active: row.active,
    venue: row.venue_name_i18n
      ? {
          name: row.venue_name_i18n,
          description: localized(row.venue_description_i18n),
          address: localized(row.venue_address_i18n),
          phone: row.venue_phone,
          website: row.venue_website,
          telegram: row.venue_telegram,
        }
      : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
