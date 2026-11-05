import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

// DTO прайса заведения (миграция 0030): разделы → позиции с ценой. Мультиязычные поля — объект «язык → текст», uk
// обязателен (кабинет пока шлёт только uk). В PATCH: поле не передано — не меняется; null — очистить (только
// необязательные). Архивные разделы и позиции в ответах не появляются.

/** Не больше позиций (не в архиве) на место. */
export const PRICE_LIST_MAX_ITEMS = 200;
/** Не больше разделов (не в архиве) на место. */
export const PRICE_LIST_MAX_SECTIONS = 30;
/** Цена, копейки: до 10 000 000 грн (CHECK 0030). */
export const PRICE_MINOR_MAX = 1_000_000_000;

export const PRICE_LIST_LIMITS = { title: 80, name: 120, description: 500, unit: 40 } as const;

/** Не только пробелы (CHECK is_localized_text — btrim(uk) <> ''). */
const NOT_BLANK = /\S/;

export class PriceSectionTitleDto {
  @ApiProperty({ type: String, maxLength: PRICE_LIST_LIMITS.title, example: "Страви" })
  @IsString()
  @MinLength(1)
  @MaxLength(PRICE_LIST_LIMITS.title)
  @Matches(NOT_BLANK)
  uk!: string;

  @ApiPropertyOptional({ type: String, maxLength: PRICE_LIST_LIMITS.title })
  @IsOptional()
  @IsString()
  @MaxLength(PRICE_LIST_LIMITS.title)
  @Matches(NOT_BLANK)
  en?: string;
}

export class PriceItemNameDto {
  @ApiProperty({ type: String, maxLength: PRICE_LIST_LIMITS.name, example: "Банош з бринзою" })
  @IsString()
  @MinLength(1)
  @MaxLength(PRICE_LIST_LIMITS.name)
  @Matches(NOT_BLANK)
  uk!: string;

  @ApiPropertyOptional({ type: String, maxLength: PRICE_LIST_LIMITS.name })
  @IsOptional()
  @IsString()
  @MaxLength(PRICE_LIST_LIMITS.name)
  @Matches(NOT_BLANK)
  en?: string;
}

export class PriceItemDescriptionDto {
  @ApiProperty({ type: String, maxLength: PRICE_LIST_LIMITS.description })
  @IsString()
  @MinLength(1)
  @MaxLength(PRICE_LIST_LIMITS.description)
  @Matches(NOT_BLANK)
  uk!: string;

  @ApiPropertyOptional({ type: String, maxLength: PRICE_LIST_LIMITS.description })
  @IsOptional()
  @IsString()
  @MaxLength(PRICE_LIST_LIMITS.description)
  @Matches(NOT_BLANK)
  en?: string;
}

export class PriceItemUnitDto {
  @ApiProperty({ type: String, maxLength: PRICE_LIST_LIMITS.unit, example: "за годину" })
  @IsString()
  @MinLength(1)
  @MaxLength(PRICE_LIST_LIMITS.unit)
  @Matches(NOT_BLANK)
  uk!: string;

  @ApiPropertyOptional({ type: String, maxLength: PRICE_LIST_LIMITS.unit })
  @IsOptional()
  @IsString()
  @MaxLength(PRICE_LIST_LIMITS.unit)
  @Matches(NOT_BLANK)
  en?: string;
}

// --- ответы кабинета ---

export class PartnerPriceItemDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) sectionId!: string;
  @ApiProperty({ type: PriceItemNameDto }) name!: PriceItemNameDto;
  @ApiProperty({ type: PriceItemDescriptionDto, nullable: true })
  description!: PriceItemDescriptionDto | null;
  @ApiProperty({ type: "integer", minimum: 0, description: "Цена, копейки" }) priceMinor!: number;
  @ApiProperty({ type: String, enum: ["UAH"], example: "UAH" }) currency!: "UAH";
  @ApiProperty({ type: Boolean, description: "«від …»: цена — нижняя граница" }) priceFrom!: boolean;
  @ApiProperty({ type: PriceItemUnitDto, nullable: true, description: "«за годину», «за особу»" })
  unit!: PriceItemUnitDto | null;
  @ApiProperty({ type: Boolean, description: "Скрыта от туриста" }) hidden!: boolean;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
  @ApiProperty({ type: "integer", minimum: 1, description: "Версия: передать в PATCH (409 при расхождении)" })
  version!: number;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class PartnerPriceSectionDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: PriceSectionTitleDto }) title!: PriceSectionTitleDto;
  @ApiProperty({ type: Boolean, description: "Скрыт от туриста вместе с позициями" }) hidden!: boolean;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
  @ApiProperty({ type: "integer", minimum: 1 }) version!: number;
  @ApiProperty({ type: [PartnerPriceItemDto], description: "Позиции по порядку (без архивных)" })
  items!: PartnerPriceItemDto[];
}

export class PriceListLimitsDto {
  @ApiProperty({ type: "integer", example: PRICE_LIST_MAX_ITEMS }) maxItems!: number;
  @ApiProperty({ type: "integer", example: PRICE_LIST_MAX_SECTIONS }) maxSections!: number;
}

/** Прайс в кабинете: разделы по порядку с позициями; каждое изменение возвращает его целиком. */
export class PartnerPriceListDto {
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: [PartnerPriceSectionDto] }) sections!: PartnerPriceSectionDto[];
  @ApiProperty({ type: "integer", description: "Позиций не в архиве (лимит — limits.maxItems)" })
  itemCount!: number;
  @ApiProperty({ type: PriceListLimitsDto }) limits!: PriceListLimitsDto;
}

// --- запросы кабинета ---

export class CreatePriceSectionDto {
  @ApiProperty({ type: PriceSectionTitleDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PriceSectionTitleDto)
  title!: PriceSectionTitleDto;
}

export class UpdatePriceSectionDto {
  @ApiPropertyOptional({ type: PriceSectionTitleDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceSectionTitleDto)
  title?: PriceSectionTitleDto;

  @ApiPropertyOptional({ type: Boolean, description: "Скрыть раздел от туриста / показать" })
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    description: "Версия из ответа: изменилась — 409 errors.priceList.versionConflict",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class UpdatePriceItemDto {
  @ApiPropertyOptional({ type: PriceItemNameDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceItemNameDto)
  name?: PriceItemNameDto;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: PRICE_MINOR_MAX, description: "Копейки" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PRICE_MINOR_MAX)
  priceMinor?: number;

  @ApiPropertyOptional({ type: Boolean, description: "«від …»" })
  @IsOptional()
  @IsBoolean()
  priceFrom?: boolean;

  @ApiPropertyOptional({ type: PriceItemUnitDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceItemUnitDto)
  unit?: PriceItemUnitDto | null;

  @ApiPropertyOptional({ type: PriceItemDescriptionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceItemDescriptionDto)
  description?: PriceItemDescriptionDto | null;

  @ApiPropertyOptional({ type: Boolean, description: "Скрыть позицию от туриста / показать" })
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Перенести в другой раздел этого места (в конец)",
  })
  @IsOptional()
  @IsUUID()
  sectionId?: string;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    description: "Версия из ответа: изменилась — 409 errors.priceList.versionConflict",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class CreatePriceItemDto {
  @ApiProperty({ type: String, format: "uuid", description: "Раздел этого места" })
  @IsUUID()
  sectionId!: string;

  @ApiProperty({ type: PriceItemNameDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PriceItemNameDto)
  name!: PriceItemNameDto;

  @ApiProperty({ type: "integer", minimum: 0, maximum: PRICE_MINOR_MAX, description: "Копейки" })
  @IsInt()
  @Min(0)
  @Max(PRICE_MINOR_MAX)
  priceMinor!: number;

  @ApiPropertyOptional({ type: Boolean, description: "«від …»" })
  @IsOptional()
  @IsBoolean()
  priceFrom?: boolean;

  @ApiPropertyOptional({ type: PriceItemUnitDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceItemUnitDto)
  unit?: PriceItemUnitDto | null;

  @ApiPropertyOptional({ type: PriceItemDescriptionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceItemDescriptionDto)
  description?: PriceItemDescriptionDto | null;
}

export const MOVE_DIRECTIONS = ["up", "down"] as const;
export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

/** ▲▼: поменяться местами с соседом (раздел — среди разделов места, позиция — внутри раздела). */
export class MovePriceListEntryDto {
  @ApiProperty({ enum: MOVE_DIRECTIONS, enumName: "PriceListMoveDirection" })
  @IsIn(MOVE_DIRECTIONS)
  direction!: MoveDirection;
}
