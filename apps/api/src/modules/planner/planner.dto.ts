import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { LocalizedDescriptionDto, LocalizedNameDto, LocalizedTextDto } from "../../common/http/index.js";
import {
  PLAN_SLOTS,
  PROMOTION_AD_LABELS,
  SCENARIO_STATUSES,
  type PlanSlot,
  type PromotionAdLabel,
  type ScenarioStatus,
} from "../../db/index.js";
import { LonLatDto } from "../catalog/index.js";
import { PLAN_DAYS_MAX, type OptionReason, type Travel } from "./plan-options.js";

// DTO планировщика (блок 5, C09, S-04; ADR-0020): готовые сценарии региона, «Мій план» пользователя, CRUD сценариев
// в админке. Регион туриста — regionId (как в каталоге гида, ADR-0019).

/** Теги сценариев (C09: 1 день, з дітьми, дощ, без авто, романтичний…) — справочник в коде. */
export const SCENARIO_TAGS = [
  "one_day",
  "multi_day",
  "kids",
  "rain",
  "no_car",
  "romantic",
  "active",
  "budget",
  "premium",
  "winter",
  "summer",
] as const;
export type ScenarioTag = (typeof SCENARIO_TAGS)[number];

export const SCENARIO_DAYS_MAX = 5;
export const SCENARIO_ITEMS_MAX = 40;
export const ALTERNATIVES_MAX = 10;
export const USER_PLANS_MAX = 20;
const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;

// --- запросы туриста ---

export class PlannerRegionQueryDto {
  @ApiProperty({ type: String, format: "uuid", description: "Регион туриста: regionId из GET /context" })
  @IsUUID()
  regionId!: string;
}

export class ScenariosQueryDto extends PlannerRegionQueryDto {
  @ApiPropertyOptional({ enum: SCENARIO_TAGS, enumName: "ScenarioTag", description: "Только с этим тегом" })
  @IsOptional()
  @IsIn(SCENARIO_TAGS)
  tag?: ScenarioTag;

  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: SCENARIO_DAYS_MAX, description: "Число дней" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SCENARIO_DAYS_MAX)
  days?: number;
}

export const PLAN_PEOPLE_MAX = 20;
export const OPTION_REASONS = [
  "breakfast",
  "lunch",
  "dinner",
  "evening_out",
  "walk",
  "culture",
  "active",
  "fun",
  "relax",
  "shopping",
  "indoor",
] as const satisfies readonly OptionReason[];
export const TRAVEL_MODES = ["walk", "car", "transport"] as const satisfies readonly Travel[];

/** Параметры поездки (0018), любые из полей; при создании по умолчанию — 2 дорослих, 0 дітей, з авто. */
export class PlanTripInputDto extends PlannerRegionQueryDto {
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: PLAN_PEOPLE_MAX, description: "Дорослих" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PLAN_PEOPLE_MAX)
  adults?: number;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: PLAN_PEOPLE_MAX, description: "Дітей" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(PLAN_PEOPLE_MAX)
  children?: number;

  @ApiPropertyOptional({
    type: Boolean,
    description: "З авто; без авто — варіанти пішки, далі — «потрібен транспорт»",
  })
  @IsOptional()
  @IsBoolean()
  withCar?: boolean;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    maximum: PLAN_DAYS_MAX,
    description: "Днів у плані; менше — пункти зайвих днів прибираються",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(PLAN_DAYS_MAX)
  days?: number;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    nullable: true,
    description: "Де живе турист (місце каталогу, напр. готель з QR): від нього — відстань і «пішки»",
  })
  @ValidateIf((o: PlanTripInputDto) => o.basePlaceId !== undefined && o.basePlaceId !== null)
  @IsUUID()
  basePlaceId?: string | null;
}

export class CreateUserPlanDto extends PlanTripInputDto {
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Опубликованный сценарий региона; без него — свой план с вариантами на выбор",
  })
  @IsOptional()
  @IsUUID()
  scenarioId?: string;

  @ApiPropertyOptional({ type: String, format: "date", nullable: true, example: "2026-11-10" })
  @IsOptional()
  @Matches(DATE_RE)
  startDate?: string | null;
}

export class ReplacePlanItemDto {
  @ApiProperty({ type: String, format: "uuid", description: "Пункт плана" })
  @IsUUID()
  itemId!: string;

  @ApiProperty({ type: String, format: "uuid", description: "Место из alternatives пункта" })
  @IsUUID()
  placeId!: string;
}

/** Галочка у варианта: место — в план, в часть дня. */
export class AddPlanItemDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: PLAN_DAYS_MAX })
  @IsInt()
  @Min(1)
  @Max(PLAN_DAYS_MAX)
  dayNo!: number;

  @ApiProperty({ enum: PLAN_SLOTS, enumName: "PlanSlot" })
  @IsIn(PLAN_SLOTS)
  slot!: PlanSlot;

  @ApiProperty({ type: String, format: "uuid", description: "Опубликованное место региона" })
  @IsUUID()
  placeId!: string;
}

/** Правка плана: параметры, дата начала, галочка варианта, замена альтернативой, удаление (любые из полей). */
export class UpdateUserPlanDto extends PlanTripInputDto {
  @ApiPropertyOptional({ type: String, format: "date", nullable: true, description: "null — убрать дату" })
  @ValidateIf((o: UpdateUserPlanDto) => o.startDate !== undefined && o.startDate !== null)
  @Matches(DATE_RE)
  startDate?: string | null;

  @ApiPropertyOptional({
    type: ReplacePlanItemDto,
    description: "«Замінити»: место — из alternatives пункта",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReplacePlanItemDto)
  replaceItem?: ReplacePlanItemDto;

  @ApiPropertyOptional({ type: String, format: "uuid", description: "Удалить пункт (снять галочку)" })
  @IsOptional()
  @IsUUID()
  removeItemId?: string;

  @ApiPropertyOptional({ type: AddPlanItemDto, description: "Поставить галочку: вариант — в план" })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddPlanItemDto)
  addItem?: AddPlanItemDto;
}

// --- ответы туриста ---

export class PlanPlaceDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) categoryId!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedTextDto;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) address!: LocalizedTextDto | null;
  @ApiProperty({ type: LonLatDto }) location!: LonLatDto;
}

export class ScenarioItemDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer" }) position!: number;
  @ApiProperty({ type: String, nullable: true, example: "09:00" }) timeHint!: string | null;
  @ApiProperty({ type: "integer", nullable: true }) durationMin!: number | null;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) note!: LocalizedTextDto | null;

  @ApiProperty({
    type: PlanPlaceDto,
    nullable: true,
    description: "null — место недоступно (не опубликовано): «Недоступно. Замінити»",
  })
  place!: PlanPlaceDto | null;

  @ApiProperty({ type: Boolean }) available!: boolean;

  @ApiProperty({ type: [PlanPlaceDto], description: "Опубликованные альтернативы для «Замінити»" })
  alternatives!: PlanPlaceDto[];

  @ApiProperty({
    type: "integer",
    nullable: true,
    description: "Расстояние от предыдущего пункта дня по прямой, м",
  })
  distanceFromPreviousMeters!: number | null;
}

export class ScenarioDayDto {
  @ApiProperty({ type: "integer" }) dayNo!: number;
  @ApiProperty({ type: [ScenarioItemDto] }) items!: ScenarioItemDto[];
}

export class ScenarioSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: LocalizedTextDto }) title!: LocalizedTextDto;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) description!: LocalizedTextDto | null;
  @ApiProperty({ type: "integer" }) days!: number;
  @ApiProperty({ enum: SCENARIO_TAGS, enumName: "ScenarioTag", isArray: true }) tags!: ScenarioTag[];

  @ApiProperty({
    enum: PROMOTION_AD_LABELS,
    enumName: "AdLabel",
    nullable: true,
    description: "Платное участие: метка «Реклама/Партнер» (C-02)",
  })
  adLabel!: PromotionAdLabel | null;

  @ApiProperty({ type: "integer", description: "Доступных пунктов" }) itemCount!: number;
}

export class ScenarioListDto {
  @ApiProperty({ type: [ScenarioSummaryDto] }) items!: ScenarioSummaryDto[];
}

export class ScenarioDto extends ScenarioSummaryDto {
  @ApiProperty({ type: "integer" }) version!: number;
  @ApiProperty({ type: [ScenarioDayDto] }) plan!: ScenarioDayDto[];
}

export class UserPlanItemDto extends ScenarioItemDto {
  @ApiProperty({ type: Boolean, description: "Пункт заменён пользователем" }) replaced!: boolean;

  @ApiProperty({
    enum: PLAN_SLOTS,
    enumName: "PlanSlot",
    description:
      "Часть дня: выбранная галочкой или по timeHint (до 12 — ранок, до 17 — день); rain — «якщо дощ»",
  })
  slot!: PlanSlot;
}

export class UserPlanDayDto {
  @ApiProperty({ type: "integer" }) dayNo!: number;
  @ApiProperty({ type: [UserPlanItemDto] }) items!: UserPlanItemDto[];
}

export class PlanOptionPlaceDto extends PlanPlaceDto {
  @ApiProperty({ type: LocalizedTextDto, description: "Название категории из справочника региона" })
  categoryName!: LocalizedTextDto;
}

/** Вариант на выбор: настоящее место каталога; подпись и причина — ключи для текстов клиента (i18n). */
export class PlanOptionDto {
  @ApiProperty({ type: PlanOptionPlaceDto }) place!: PlanOptionPlaceDto;

  @ApiProperty({
    type: String,
    example: "museums",
    description: "Что это: код подкатегории; waterfall / bar — по названию места из Google",
  })
  kind!: string;

  @ApiProperty({ enum: OPTION_REASONS, enumName: "PlanOptionReason", description: "Почему подходит" })
  reason!: OptionReason;

  @ApiProperty({
    type: "integer",
    nullable: true,
    description: "По прямой от предыдущего пункта дня или базовой точки, м",
  })
  distanceMeters!: number | null;

  @ApiProperty({
    enum: TRAVEL_MODES,
    enumName: "PlanTravel",
    description: "walk — пішки; car — на авто; transport — без авто далеко: потрібен транспорт",
  })
  travel!: Travel;

  @ApiProperty({ type: "integer", nullable: true, description: "Оцінка в дорозі, хв" })
  travelMinutes!: number | null;

  @ApiProperty({ type: Boolean, description: "У місця є тег «З дітьми»" }) kidsFriendly!: boolean;
}

export class PlanSlotOptionsDto {
  @ApiProperty({ enum: PLAN_SLOTS, enumName: "PlanSlot" }) slot!: PlanSlot;
  @ApiProperty({ type: [PlanOptionDto] }) options!: PlanOptionDto[];
}

export class PlanDayOptionsDto {
  @ApiProperty({ type: "integer" }) dayNo!: number;
  @ApiProperty({ type: [PlanSlotOptionsDto] }) slots!: PlanSlotOptionsDto[];
}

export class PlanBaseDto {
  @ApiProperty({
    enum: ["place", "locality"],
    enumName: "PlanBaseKind",
    description: "place — basePlaceId; locality — центр населённого пункта",
  })
  kind!: "place" | "locality";

  @ApiProperty({ type: String, format: "uuid", nullable: true }) placeId!: string | null;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedTextDto;
}

export class PlanTripDto {
  @ApiProperty({ type: "integer" }) adults!: number;
  @ApiProperty({ type: "integer" }) children!: number;
  @ApiProperty({ type: Boolean }) withCar!: boolean;
  @ApiProperty({ type: "integer", minimum: 1, maximum: PLAN_DAYS_MAX }) days!: number;

  @ApiProperty({
    type: PlanBaseDto,
    nullable: true,
    description: "Від чого рахується відстань, якщо в день ще нічого не вибрано",
  })
  base!: PlanBaseDto | null;
}

export class UserPlanDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) scenarioId!: string | null;
  @ApiProperty({ type: "integer", nullable: true }) scenarioVersion!: number | null;

  @ApiProperty({
    type: Boolean,
    description: "Сценарий-основа изменился после сохранения (версия новее)",
  })
  scenarioUpdated!: boolean;

  @ApiProperty({ type: LocalizedTextDto }) title!: LocalizedTextDto;
  @ApiProperty({ type: String, format: "date", nullable: true }) startDate!: string | null;
  @ApiProperty({ type: PlanTripDto }) trip!: PlanTripDto;
  @ApiProperty({ type: [UserPlanDayDto], description: "Дни 1…trip.days (пустой день — items: [])" })
  plan!: UserPlanDayDto[];

  @ApiProperty({
    type: [PlanDayOptionsDto],
    description: "Варианты на выбор по дням и частям дня; в списке GET /me/plan — пусто",
  })
  options!: PlanDayOptionsDto[];
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class UserPlanListDto {
  @ApiProperty({ type: [UserPlanDto], description: `Сохранённые планы в регионе, до ${USER_PLANS_MAX}` })
  items!: UserPlanDto[];
}

// --- админка ---

export class ScenarioItemInputDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: SCENARIO_DAYS_MAX })
  @IsInt()
  @Min(1)
  @Max(SCENARIO_DAYS_MAX)
  dayNo!: number;

  @ApiProperty({ type: String, format: "uuid", description: "Место региона" })
  @IsUUID()
  placeId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: "09:00" })
  @IsOptional()
  @Matches(HHMM_RE)
  timeHint?: string | null;

  @ApiPropertyOptional({ type: "integer", nullable: true, minimum: 5, maximum: 1440 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  durationMin?: number | null;

  @ApiPropertyOptional({ type: LocalizedDescriptionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedDescriptionDto)
  note?: LocalizedDescriptionDto | null;

  @ApiPropertyOptional({ type: [String], format: "uuid", description: "Места-альтернативы для «Замінити»" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ALTERNATIVES_MAX)
  @IsUUID("all", { each: true })
  alternatives?: string[];
}

export class ScenarioInputDto {
  @ApiProperty({ type: String, example: "one-day-yaremche" })
  @Matches(CODE_RE)
  code!: string;

  @ApiProperty({ type: LocalizedNameDto })
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  title!: LocalizedNameDto;

  @ApiPropertyOptional({ type: LocalizedDescriptionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedDescriptionDto)
  description?: LocalizedDescriptionDto | null;

  @ApiProperty({ type: "integer", minimum: 1, maximum: SCENARIO_DAYS_MAX })
  @IsInt()
  @Min(1)
  @Max(SCENARIO_DAYS_MAX)
  days!: number;

  @ApiPropertyOptional({ enum: SCENARIO_TAGS, enumName: "ScenarioTag", isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCENARIO_TAGS.length)
  @IsIn(SCENARIO_TAGS, { each: true })
  tags?: ScenarioTag[];

  @ApiPropertyOptional({
    enum: PROMOTION_AD_LABELS,
    enumName: "AdLabel",
    nullable: true,
    description: "Платное участие — только с меткой (C-02)",
  })
  @IsOptional()
  @IsIn(PROMOTION_AD_LABELS)
  adLabel?: PromotionAdLabel | null;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 10000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiProperty({ type: [ScenarioItemInputDto], description: "Пункты по дням, порядок — порядок в массиве" })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SCENARIO_ITEMS_MAX)
  @ValidateNested({ each: true })
  @Type(() => ScenarioItemInputDto)
  items!: ScenarioItemInputDto[];
}

export class ScenarioStatusDto {
  @ApiProperty({ enum: SCENARIO_STATUSES, enumName: "ScenarioStatus" })
  @IsIn(SCENARIO_STATUSES)
  status!: ScenarioStatus;
}

export class AdminScenariosQueryDto {
  @ApiPropertyOptional({ enum: SCENARIO_STATUSES, enumName: "ScenarioStatus" })
  @IsOptional()
  @IsIn(SCENARIO_STATUSES)
  status?: ScenarioStatus;
}

export class AdminScenarioItemDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: "integer" }) dayNo!: number;
  @ApiProperty({ type: "integer" }) position!: number;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: LocalizedTextDto, nullable: true, description: "Название места" })
  placeName!: LocalizedTextDto | null;
  @ApiProperty({ type: String, nullable: true, description: "Статус места (published, draft…)" })
  placeStatus!: string | null;
  @ApiProperty({ type: String, nullable: true }) timeHint!: string | null;
  @ApiProperty({ type: "integer", nullable: true }) durationMin!: number | null;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) note!: LocalizedTextDto | null;
  @ApiProperty({ type: [String], format: "uuid" }) alternatives!: string[];
}

export class AdminScenarioDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: LocalizedTextDto }) title!: LocalizedTextDto;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) description!: LocalizedTextDto | null;
  @ApiProperty({ type: "integer" }) days!: number;
  @ApiProperty({ enum: SCENARIO_TAGS, enumName: "ScenarioTag", isArray: true }) tags!: ScenarioTag[];
  @ApiProperty({ enum: SCENARIO_STATUSES, enumName: "ScenarioStatus" }) status!: ScenarioStatus;
  @ApiProperty({ type: "integer" }) version!: number;
  @ApiProperty({ enum: PROMOTION_AD_LABELS, enumName: "AdLabel", nullable: true })
  adLabel!: PromotionAdLabel | null;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
  @ApiProperty({ type: "integer" }) itemCount!: number;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class AdminScenarioDetailDto extends AdminScenarioDto {
  @ApiProperty({ type: [AdminScenarioItemDto] }) items!: AdminScenarioItemDto[];
}

export class AdminScenarioListDto {
  @ApiProperty({ type: [AdminScenarioDto] }) items!: AdminScenarioDto[];
}
