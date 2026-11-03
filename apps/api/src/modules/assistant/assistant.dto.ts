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
  IsUUID,
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
  DAY_PARTS,
  INTENT_CATEGORIES_MAX,
  INTENT_KEYWORD_MAX,
  INTENT_KEYWORDS_MAX,
  INTENT_NAME_MAX,
  INTENT_PLAN_DAYS_MAX,
  INTENT_RADIUS_MAX,
  INTENT_RADIUS_MIN,
  PLAN_STARTS,
  type AssistantKind,
  type AssistantSuggestion,
  type DayPart,
  type PlanStart,
} from "./intent.js";
import { PLAN_ROLES, PLAN_TRAVELS, type PlanRole, type PlanTravel } from "./plan.js";

// DTO ассистента на главной: запрос текстом (или распознанной речью) → намерение и реальные места каталога.
// Контекст диалога хранит клиент и присылает с каждым запросом (сервер ничего не хранит): прежние реплики и
// прежнее намерение.

/** Длина реплики туриста, символов. */
export const ASSISTANT_TEXT_MAX = 300;
/** Выбранных населённых пунктов — не больше. */
export const ASSISTANT_LOCALITIES_MAX = 10;
/** Прежних реплик в контексте — не больше. */
export const ASSISTANT_HISTORY_MAX = 5;
/** Аудио — не больше 512 КиБ (≈ 1 мин Opus; клиент пишет до 15 с). */
export const ASSISTANT_AUDIO_MAX_BYTES = 512 * 1024;

/**
 * Пояснения выдачи: keyword_none — блюда/кухни из запроса нет ни в одном месте, показаны места категории; widened —
 * рядом мало, поиск расширен на весь регион (или выбранные пункты); plan_tomorrow — сегодня уже поздно, план с завтра.
 */
export const ASSISTANT_NOTES = [
  "price_unknown",
  "none_open",
  "no_origin",
  "keyword_none",
  "widened",
  "plan_tomorrow",
] as const;
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

  @ApiPropertyOptional({
    type: [String],
    maxItems: INTENT_KEYWORDS_MAX,
    description:
      "Блюдо, кухня или особенность в нескольких написаниях (поиск по названию, типу, описаниям, отзывам)",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(INTENT_KEYWORDS_MAX)
  @IsString({ each: true })
  @MaxLength(INTENT_KEYWORD_MAX, { each: true })
  keywords?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 64,
    description: "Код населённого пункта, названного туристом; null — действует выбор localityIds",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  locality!: string | null;

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

  @ApiPropertyOptional({
    type: "integer",
    nullable: true,
    minimum: 1,
    maximum: INTENT_PLAN_DAYS_MAX,
    description: "План: дней; не план — null",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(INTENT_PLAN_DAYS_MAX)
  days?: number | null;

  @ApiPropertyOptional({
    enum: DAY_PARTS,
    enumName: "AssistantDayPart",
    isArray: true,
    description: "План: части дня; пусто — весь день",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DAY_PARTS.length)
  @IsIn(DAY_PARTS, { each: true })
  dayParts?: DayPart[];

  @ApiPropertyOptional({
    enum: PLAN_STARTS,
    enumName: "AssistantPlanStart",
    nullable: true,
    description: "План: начало (null — сегодня)",
  })
  @IsOptional()
  @IsIn(PLAN_STARTS)
  start?: PlanStart | null;
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

  @ApiPropertyOptional({
    type: [String],
    format: "uuid",
    maxItems: ASSISTANT_LOCALITIES_MAX,
    description: "Населённые пункты, выбранные туристом («Локація»); названный в реплике — главнее",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ASSISTANT_LOCALITIES_MAX)
  @IsUUID("all", { each: true })
  localityIds?: string[];

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

export class AssistantPlanStopDto {
  @ApiProperty({ type: "integer", description: "Индекс места в items" }) item!: number;
  @ApiProperty({
    enum: PLAN_ROLES,
    enumName: "AssistantPlanRole",
    description: "see — огляд, fun — активність, eat — їжа, relax — відпочинок",
  })
  role!: PlanRole;
  @ApiProperty({ type: String, example: "13:00", description: "Начало, местное время" }) start!: string;
  @ApiProperty({ type: "integer", description: "Оценка времени на месте, мин" }) durationMin!: number;
  @ApiProperty({ enum: PLAN_TRAVELS, enumName: "AssistantPlanTravel", nullable: true })
  travel!: PlanTravel | null;
  @ApiProperty({ type: "integer", nullable: true, description: "Переезд от предыдущей точки, мин (оценка)" })
  travelMinutes!: number | null;
  @ApiProperty({ type: "integer", nullable: true, description: "Переезд по прямой, м" })
  travelMeters!: number | null;
  @ApiProperty({ type: String, nullable: true, description: "Часы работы в этот день по графику каталога" })
  hours!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Пояснение (Claude по фактам каталога); null — нет",
  })
  note!: string | null;
}

export class AssistantPlanPartDto {
  @ApiProperty({ enum: DAY_PARTS, enumName: "AssistantDayPart" }) part!: DayPart;
  @ApiProperty({ type: [AssistantPlanStopDto] }) stops!: AssistantPlanStopDto[];
}

export class AssistantPlanDayDto {
  @ApiProperty({ type: "integer" }) dayNo!: number;
  @ApiProperty({ type: String, format: "date", example: "2026-11-07" }) date!: string;
  @ApiProperty({ type: [AssistantPlanPartDto] }) parts!: AssistantPlanPartDto[];
}

export class AssistantPlanDto {
  @ApiProperty({ type: [AssistantPlanDayDto] }) days!: AssistantPlanDayDto[];
  @ApiProperty({ type: "integer", description: "Сумма переездов по прямой, м" }) lengthMeters!: number;
}

export class AssistantResultDto {
  @ApiProperty({ type: AssistantIntentDto }) intent!: AssistantIntentDto;
  @ApiProperty({
    type: [AssistantPlaceDto],
    description: "Только места каталога; для tour — в порядке обхода; для plan — в порядке плана",
  })
  items!: AssistantPlaceDto[];
  @ApiProperty({ type: AssistantRouteDto, nullable: true, description: "Маршрут — только для tour" })
  route!: AssistantRouteDto | null;
  @ApiProperty({
    type: AssistantPlanDto,
    nullable: true,
    description: "План отдыха по дням и частям дня — только для plan",
  })
  plan!: AssistantPlanDto | null;
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
