import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { OriginQueryDto, PlaceSummaryDto } from "../guide/index.js";
import {
  ASSISTANT_KINDS,
  ASSISTANT_SUGGESTIONS,
  INTENT_CATEGORIES_MAX,
  INTENT_NAME_MAX,
  INTENT_RADIUS_MAX,
  INTENT_RADIUS_MIN,
  type AssistantKind,
  type AssistantSuggestion,
} from "./intent.js";

// DTO ассистента на главной: запрос текстом (или распознанной речью) → намерение и реальные места каталога.
// Контекст диалога хранит клиент и присылает с каждым запросом (сервер ничего не хранит): прежние реплики и
// прежнее намерение.

/** Длина реплики туриста, символов. */
export const ASSISTANT_TEXT_MAX = 300;
/** Прежних реплик в контексте — не больше. */
export const ASSISTANT_HISTORY_MAX = 5;
/** Аудио — не больше 512 КиБ (≈ 1 мин Opus; клиент пишет до 15 с). */
export const ASSISTANT_AUDIO_MAX_BYTES = 512 * 1024;

export const ASSISTANT_NOTES = ["price_unknown", "none_open", "no_origin"] as const;
export type AssistantNote = (typeof ASSISTANT_NOTES)[number];

export const DESCRIPTION_SOURCES = ["ai", "wikipedia", "google"] as const;
export type DescriptionSource = (typeof DESCRIPTION_SOURCES)[number];

/** Намерение: ответ сервера и контекст следующего запроса (клиент присылает его обратно как есть). */
export class AssistantIntentDto {
  @ApiProperty({
    enum: ASSISTANT_KINDS,
    enumName: "AssistantKind",
    description: "places — места, tour — маршрут",
  })
  @IsIn(ASSISTANT_KINDS)
  kind!: AssistantKind;

  @ApiProperty({ type: [String], maxItems: INTENT_CATEGORIES_MAX, description: "Коды категорий каталога" })
  @IsArray()
  @ArrayMaxSize(INTENT_CATEGORIES_MAX)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  categories!: string[];

  @ApiProperty({ type: String, nullable: true, maxLength: INTENT_NAME_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(INTENT_NAME_MAX)
  nameQuery!: string | null;

  @ApiProperty({ type: "integer", nullable: true, minimum: INTENT_RADIUS_MIN, maximum: INTENT_RADIUS_MAX })
  @IsOptional()
  @IsInt()
  @Min(INTENT_RADIUS_MIN)
  @Max(INTENT_RADIUS_MAX)
  radiusMeters!: number | null;

  @ApiProperty({
    type: "integer",
    nullable: true,
    minimum: 0,
    maximum: 4,
    description: "Ценовой уровень Google",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  priceMin!: number | null;

  @ApiProperty({ type: "integer", nullable: true, minimum: 0, maximum: 4 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  priceMax!: number | null;

  @ApiProperty({ type: Boolean }) @IsBoolean() withKids!: boolean;
  @ApiProperty({ type: Boolean }) @IsBoolean() openNow!: boolean;
  @ApiProperty({ type: Boolean, description: "Запрос непонятен — уточнить (мест нет)" })
  @IsBoolean()
  clarify!: boolean;

  @ApiProperty({ enum: ASSISTANT_SUGGESTIONS, enumName: "AssistantSuggestion", isArray: true })
  @IsArray()
  @ArrayMaxSize(ASSISTANT_SUGGESTIONS.length)
  @IsIn(ASSISTANT_SUGGESTIONS, { each: true })
  suggestions!: AssistantSuggestion[];
}

export class AssistantQueryDto extends OriginQueryDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: ASSISTANT_TEXT_MAX, description: "Реплика туриста" })
  @IsString()
  @MinLength(1)
  @MaxLength(ASSISTANT_TEXT_MAX)
  text!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: ASSISTANT_HISTORY_MAX,
    description: "Прежние реплики диалога (контекст хранит клиент)",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ASSISTANT_HISTORY_MAX)
  @IsString({ each: true })
  @MaxLength(ASSISTANT_TEXT_MAX, { each: true })
  history?: string[];

  @ApiPropertyOptional({ type: AssistantIntentDto, description: "Намерение прошлого ответа (для уточнений)" })
  @IsOptional()
  @ValidateNested()
  @Type(() => AssistantIntentDto)
  previous?: AssistantIntentDto;
}

export class AssistantPlaceDto {
  @ApiProperty({ type: PlaceSummaryDto }) place!: PlaceSummaryDto;
  @ApiProperty({
    type: "integer",
    nullable: true,
    description: "Ценовой уровень Google 0–4; null — неизвестен",
  })
  priceLevel!: number | null;
  @ApiProperty({ type: Boolean, description: "По данным Google: подходит для детей или есть дитяче меню" })
  kidsFriendly!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Описание из обогащения (ИИ-текст, Вікіпедія, Google)",
  })
  description!: string | null;
  @ApiProperty({ enum: DESCRIPTION_SOURCES, enumName: "AssistantDescriptionSource", nullable: true })
  descriptionSource!: DescriptionSource | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Статья Вікіпедії (для wikipedia — ссылка обязательна)",
  })
  descriptionUrl!: string | null;
}

export class AssistantRouteDto {
  @ApiProperty({ type: "integer", description: "Длина маршрута между остановками по прямой, м" })
  lengthMeters!: number;
}

export class AssistantResultDto {
  @ApiProperty({ type: AssistantIntentDto }) intent!: AssistantIntentDto;
  @ApiProperty({
    type: [AssistantPlaceDto],
    description: "Только места каталога; для tour — в порядке обхода",
  })
  items!: AssistantPlaceDto[];
  @ApiProperty({ type: AssistantRouteDto, nullable: true, description: "Маршрут — только для tour" })
  route!: AssistantRouteDto | null;
  @ApiProperty({
    enum: ASSISTANT_NOTES,
    enumName: "AssistantNote",
    isArray: true,
    description: "Пояснения выдачи",
  })
  notes!: AssistantNote[];
}

export class AssistantTranscriptDto {
  @ApiProperty({ type: String, description: "Распознанный текст; пусто — речь не распознана" })
  text!: string;
}
