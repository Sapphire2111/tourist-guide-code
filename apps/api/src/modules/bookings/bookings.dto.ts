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
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateNested,
} from "class-validator";
import { LocalizedDescriptionDto, LocalizedNameDto, LocalizedTextDto } from "../../common/http/index.js";
import {
  BOOKING_ACTORS,
  BOOKING_MODES,
  BOOKING_SOURCES,
  BOOKING_STATUSES,
  MANUAL_AVAILABILITY,
  RESOURCE_STATUSES,
  type BookingActor,
  type BookingMode,
  type BookingSource,
  type BookingStatus,
  type ManualAvailability,
  type ResourceStatus,
} from "../../db/index.js";
import { BOOKING_PARAMS } from "./booking-rules.js";

// DTO блока 7 (бронирования): турист — регион из запроса (regionId, как каталог гида), партнёр — из назначений ORG_*
// на сервере. Время — UTC (RFC 3339), правила доступности — местное время региона ("HH:MM").

/** RFC 3339 date-time со смещением (время без смещения читалось бы в зоне сервера). */
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;

function IsRfc3339DateTime(): PropertyDecorator {
  return ValidateBy({
    name: "isRfc3339DateTime",
    validator: {
      validate: (v: unknown) =>
        typeof v === "string" && RFC3339_DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)),
    },
  });
}

/** Дата "YYYY-MM-DD" (существующая). */
function IsIsoDate(): PropertyDecorator {
  return ValidateBy({
    name: "isIsoDate",
    validator: {
      validate: (v: unknown) =>
        typeof v === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(v) &&
        new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v,
    },
  });
}

/** Телефон E.164: "+380501234567". */
export const PHONE_E164_RE = /^\+[1-9][0-9]{7,14}$/;
/** Время "HH:MM" местного времени; закрытие может быть "24:00". */
export const HHMM_OPEN_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const HHMM_CLOSE_RE = /^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;
export const BOOKING_COMMENT_MAX = 500;
export const BOOKING_REASON_MAX = 500;
export const AVAILABILITY_RULES_MAX = 60;

/** Источник телефона туриста (D-42 А): requestContact Telegram или ручной ввод запасным путём. */
export const TOURIST_PHONE_SOURCES = ["telegram_contact", "manual"] as const;
export type TouristPhoneSource = (typeof TOURIST_PHONE_SOURCES)[number];
/** Источник ручной записи партнёра (ТЗ §10.4 «джерело»). */
export const MANUAL_BOOKING_SOURCES = ["manual", "phone"] as const;
export type ManualBookingSource = (typeof MANUAL_BOOKING_SOURCES)[number];
/** Статусы, которые выставляет PATCH /bookings/{id}/status (new, pending_partner, expired — только система). */
export const TARGET_STATUSES = [
  "confirmed",
  "alternative_proposed",
  "cancelled_by_user",
  "cancelled_by_partner",
  "completed",
  "no_show",
] as const satisfies readonly BookingStatus[];
export type BookingTargetStatus = (typeof TARGET_STATUSES)[number];

// --- запросы ---

export class BookingRegionQueryDto {
  @ApiProperty({ type: String, format: "uuid", description: "Регион туриста: regionId из GET /context" })
  @IsUUID()
  regionId!: string;
}

export class ResourcesQueryDto extends BookingRegionQueryDto {
  @ApiProperty({ type: String, format: "uuid", description: "Опубликованное место" })
  @IsUUID()
  placeId!: string;
}

export class SlotsQueryDto extends BookingRegionQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: "date",
    example: "2026-11-05",
    description: "Первая местная дата (по умолчанию — сегодня в таймзоне региона)",
  })
  @IsOptional()
  @IsIsoDate()
  from?: string;

  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: BOOKING_PARAMS.slotsMaxDays, default: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(BOOKING_PARAMS.slotsMaxDays)
  days?: number;
}

export class CreateBookingDto extends BookingRegionQueryDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  resourceId!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    description: "Начало слота из GET /resources/{id}/slots",
  })
  @IsRfc3339DateTime()
  startsAt!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  peopleCount!: number;

  @ApiPropertyOptional({ type: String, maxLength: BOOKING_COMMENT_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(BOOKING_COMMENT_MAX)
  comment?: string;

  @ApiProperty({ type: String, example: "+380501234567", description: "Телефон E.164 (D-42)" })
  @Matches(PHONE_E164_RE)
  phone!: string;

  @ApiProperty({
    enum: TOURIST_PHONE_SOURCES,
    enumName: "TouristPhoneSource",
    description: "telegram_contact — requestContact Telegram; manual — введён вручную",
  })
  @IsIn(TOURIST_PHONE_SOURCES)
  phoneSource!: TouristPhoneSource;

  @ApiProperty({
    type: Boolean,
    description:
      "Согласие на передачу телефона этому заведению (галочка C08, ТЗ §14.1). false — 422 phoneConsentRequired",
  })
  @IsBoolean()
  phoneShareConsent!: boolean;

  @ApiPropertyOptional({ type: String, format: "uuid", description: "EntryContext входа (атрибуция)" })
  @IsOptional()
  @IsUUID()
  entryContextId?: string;
}

export class UpdateBookingStatusDto extends BookingRegionQueryDto {
  @ApiProperty({ enum: TARGET_STATUSES, enumName: "BookingTargetStatus" })
  @IsIn(TARGET_STATUSES)
  status!: BookingTargetStatus;

  @ApiPropertyOptional({
    type: String,
    maxLength: BOOKING_REASON_MAX,
    description: "Причина — обязательна для cancelled_by_partner",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(BOOKING_REASON_MAX)
  reason?: string;

  @ApiPropertyOptional({
    type: String,
    format: "date-time",
    description:
      "Начало предложенного слота — обязательно для alternative_proposed (D-66: одна альтернатива)",
  })
  @IsOptional()
  @IsRfc3339DateTime()
  alternativeStartsAt?: string;
}

export class CreateManualBookingDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  resourceId!: string;

  @ApiProperty({ type: String, format: "date-time" })
  @IsRfc3339DateTime()
  startsAt!: string;

  @ApiPropertyOptional({
    type: String,
    format: "date-time",
    description: "Конец (по умолчанию — длительность слота ресурса)",
  })
  @IsOptional()
  @IsRfc3339DateTime()
  endsAt?: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  peopleCount!: number;

  @ApiProperty({ type: String, minLength: 1, maxLength: 200, description: "Имя клиента (вводит партнёр)" })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  customerName!: string;

  @ApiPropertyOptional({ type: String, example: "+380501234567" })
  @IsOptional()
  @Matches(PHONE_E164_RE)
  customerPhone?: string;

  @ApiPropertyOptional({ type: String, maxLength: BOOKING_COMMENT_MAX })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(BOOKING_COMMENT_MAX)
  comment?: string;

  @ApiPropertyOptional({ enum: MANUAL_BOOKING_SOURCES, enumName: "ManualBookingSource", default: "manual" })
  @IsOptional()
  @IsIn(MANUAL_BOOKING_SOURCES)
  source?: ManualBookingSource;
}

export class PartnerBookingsQueryDto {
  @ApiPropertyOptional({ type: String, format: "uuid", description: "Одно из своих мест; без него — все" })
  @IsOptional()
  @IsUUID()
  placeId?: string;

  @ApiPropertyOptional({ enum: BOOKING_STATUSES, enumName: "BookingStatus" })
  @IsOptional()
  @IsIn(BOOKING_STATUSES)
  status?: BookingStatus;

  @ApiPropertyOptional({ type: String, format: "date-time", description: "Начало брони не раньше" })
  @IsOptional()
  @IsRfc3339DateTime()
  from?: string;

  @ApiPropertyOptional({ type: String, format: "date-time", description: "Начало брони раньше" })
  @IsOptional()
  @IsRfc3339DateTime()
  to?: string;
}

export class PartnerResourcesQueryDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  placeId!: string;
}

class ResourceSettingsDto {
  @ApiPropertyOptional({ type: LocalizedDescriptionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedDescriptionDto)
  description?: LocalizedDescriptionDto | null;

  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 100, description: "Людей на слот (D-04 А)" })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  capacityPeople?: number;

  @ApiPropertyOptional({ type: "integer", minimum: 15, maximum: 720 })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(720)
  slotDurationMin?: number;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 240, description: "Buffer до слота, мин" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  bufferBeforeMin?: number;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 240, description: "Buffer после слота, мин" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  bufferAfterMin?: number;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 0,
    maximum: 10080,
    description: "Бронь не раньше чем за, мин",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10080)
  leadTimeMin?: number;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    maximum: 365,
    description: "Горизонт бронирования, дней",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  horizonDays?: number;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 5,
    maximum: 1440,
    description: "SLA ответа партнёра, мин (D-43)",
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  confirmSlaMin?: number;

  @ApiPropertyOptional({ enum: BOOKING_MODES, enumName: "BookingMode" })
  @IsOptional()
  @IsIn(BOOKING_MODES)
  bookingMode?: BookingMode;

  @ApiPropertyOptional({ type: "integer", minimum: 0, nullable: true, description: "Ориентир цены, копейки" })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceMinor?: number | null;

  @ApiPropertyOptional({ type: String, example: "UAH", nullable: true })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string | null;
}

export class CreateResourceDto extends ResourceSettingsDto {
  @ApiProperty({ type: String, format: "uuid", description: "Место партнёра" })
  @IsUUID()
  placeId!: string;

  @ApiProperty({ type: LocalizedNameDto })
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name!: LocalizedNameDto;
}

export class UpdateResourceDto extends ResourceSettingsDto {
  @ApiPropertyOptional({ type: LocalizedNameDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name?: LocalizedNameDto;

  @ApiPropertyOptional({ enum: RESOURCE_STATUSES, enumName: "ResourceStatus" })
  @IsOptional()
  @IsIn(RESOURCE_STATUSES)
  status?: ResourceStatus;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    description: "Версия из PartnerResourceDto: изменилась — 409 errors.resource.versionConflict",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class AvailabilityRuleDto {
  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    maximum: 7,
    nullable: true,
    description: "ISO: 1 — пн",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number | null;

  @ApiPropertyOptional({ type: String, format: "date", nullable: true, description: "Правило на дату" })
  @IsOptional()
  @IsIsoDate()
  date?: string | null;

  @ApiPropertyOptional({ type: Boolean, description: "Выходной на дату" })
  @IsOptional()
  @IsBoolean()
  closed?: boolean;

  @ApiPropertyOptional({ type: String, example: "10:00", nullable: true })
  @IsOptional()
  @Matches(HHMM_OPEN_RE)
  opensAt?: string | null;

  @ApiPropertyOptional({
    type: String,
    example: "22:00",
    nullable: true,
    description: "Позже opensAt; до 24:00",
  })
  @IsOptional()
  @Matches(HHMM_CLOSE_RE)
  closesAt?: string | null;
}

export class PutAvailabilityDto {
  @ApiProperty({ type: [AvailabilityRuleDto], maxItems: AVAILABILITY_RULES_MAX })
  @IsArray()
  @ArrayMaxSize(AVAILABILITY_RULES_MAX)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityRuleDto)
  rules!: AvailabilityRuleDto[];
}

export class PutManualAvailabilityDto {
  @ApiProperty({
    enum: MANUAL_AVAILABILITY,
    enumName: "ManualAvailability",
    description: "available_now — «є вільні місця», busy — «немає місць», unknown — снять ручной статус",
  })
  @IsIn(MANUAL_AVAILABILITY)
  status!: ManualAvailability;

  @ApiPropertyOptional({
    type: "integer",
    minimum: BOOKING_PARAMS.manualTtlMinMin,
    maximum: BOOKING_PARAMS.manualTtlMaxMin,
    default: BOOKING_PARAMS.manualTtlDefaultMin,
    description: "TTL ручного статуса, мин (D-78 А: короткий)",
  })
  @IsOptional()
  @IsInt()
  @Min(BOOKING_PARAMS.manualTtlMinMin)
  @Max(BOOKING_PARAMS.manualTtlMaxMin)
  ttlMinutes?: number;
}

// --- ответы ---

export class AvailabilityNowDto {
  @ApiProperty({ type: Boolean, description: "«Доступно зараз»; false — «Уточнити доступність» (BR-04)" })
  availableNow!: boolean;

  @ApiProperty({
    type: String,
    enum: ["slot", "manual"],
    nullable: true,
    description: "slot — реальный свободный слот; manual — ручной статус партнёра с неистёкшим TTL",
  })
  source!: "slot" | "manual" | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true }) manualExpiresAt!: string | null;
}

export class ResourceDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedTextDto;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) description!: LocalizedTextDto | null;
  @ApiProperty({ type: "integer" }) capacityPeople!: number;
  @ApiProperty({ type: "integer" }) slotDurationMin!: number;
  @ApiProperty({ enum: BOOKING_MODES, enumName: "BookingMode" }) bookingMode!: BookingMode;
  @ApiProperty({ type: "integer", nullable: true, description: "Ориентир цены, копейки" })
  priceMinor!: number | null;
  @ApiProperty({ type: String, nullable: true, example: "UAH" }) currency!: string | null;
  @ApiProperty({ type: AvailabilityNowDto }) availability!: AvailabilityNowDto;
}

export class ResourceListDto {
  @ApiProperty({ type: [ResourceDto] }) items!: ResourceDto[];
}

export class AvailabilityRuleViewDto {
  @ApiProperty({ type: "integer", nullable: true }) dayOfWeek!: number | null;
  @ApiProperty({ type: String, format: "date", nullable: true }) date!: string | null;
  @ApiProperty({ type: Boolean }) closed!: boolean;
  @ApiProperty({ type: String, nullable: true, example: "10:00" }) opensAt!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "22:00" }) closesAt!: string | null;
}

export class PartnerResourceDto extends ResourceDto {
  @ApiProperty({ type: String, format: "uuid" }) organizationId!: string;
  @ApiProperty({ enum: RESOURCE_STATUSES, enumName: "ResourceStatus" }) status!: ResourceStatus;
  @ApiProperty({ type: "integer" }) bufferBeforeMin!: number;
  @ApiProperty({ type: "integer" }) bufferAfterMin!: number;
  @ApiProperty({ type: "integer" }) leadTimeMin!: number;
  @ApiProperty({ type: "integer" }) horizonDays!: number;
  @ApiProperty({ type: "integer" }) confirmSlaMin!: number;
  @ApiProperty({ enum: MANUAL_AVAILABILITY, enumName: "ManualAvailability" })
  manualAvailability!: ManualAvailability;
  @ApiProperty({ type: [AvailabilityRuleViewDto] }) rules!: AvailabilityRuleViewDto[];
  @ApiProperty({ type: "integer" }) version!: number;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class PartnerResourceListDto {
  @ApiProperty({ type: [PartnerResourceDto] }) items!: PartnerResourceDto[];
}

export class SlotDto {
  @ApiProperty({ type: String, format: "date-time" }) startsAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) endsAt!: string;
  @ApiProperty({ type: Boolean, description: "Свободен (иначе занят бронью или ручной записью)" })
  free!: boolean;
}

export class SlotListDto {
  @ApiProperty({ type: String, format: "uuid" }) resourceId!: string;
  @ApiProperty({ type: String, example: "Europe/Kyiv" }) timezone!: string;
  @ApiProperty({ type: String, format: "date" }) from!: string;
  @ApiProperty({ type: "integer" }) days!: number;
  @ApiProperty({ type: [SlotDto] }) items!: SlotDto[];
  @ApiProperty({ type: AvailabilityNowDto }) availability!: AvailabilityNowDto;
}

export class BookingEventDto {
  @ApiProperty({ enum: BOOKING_STATUSES, enumName: "BookingStatus", nullable: true })
  fromStatus!: BookingStatus | null;
  @ApiProperty({ enum: BOOKING_STATUSES, enumName: "BookingStatus" }) toStatus!: BookingStatus;
  @ApiProperty({ enum: BOOKING_ACTORS, enumName: "BookingActor" }) actor!: BookingActor;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) at!: string;
}

export class BookingAlternativeDto {
  @ApiProperty({ type: String, format: "date-time" }) startsAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) endsAt!: string;
  @ApiProperty({ type: String, format: "date-time", description: "Ответить до (D-66), затем expired" })
  respondBy!: string;
}

export class BookingDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: LocalizedTextDto }) placeName!: LocalizedTextDto;
  @ApiProperty({ type: String, format: "uuid" }) resourceId!: string;
  @ApiProperty({ type: LocalizedTextDto }) resourceName!: LocalizedTextDto;
  @ApiProperty({ enum: BOOKING_STATUSES, enumName: "BookingStatus" }) status!: BookingStatus;
  @ApiProperty({ type: String, nullable: true }) statusReason!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) startsAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) endsAt!: string;
  @ApiProperty({ type: "integer" }) peopleCount!: number;
  @ApiProperty({ type: String, nullable: true }) comment!: string | null;
  @ApiProperty({ type: BookingAlternativeDto, nullable: true }) alternative!: BookingAlternativeDto | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "Срок ответа партнёра (D-43)",
  })
  partnerResponseDueAt!: string | null;
  @ApiProperty({
    enum: TARGET_STATUSES,
    enumName: "BookingTargetStatus",
    isArray: true,
    description: "Переходы, доступные текущему пользователю",
  })
  allowedTransitions!: BookingTargetStatus[];
  @ApiProperty({ type: [BookingEventDto] }) history!: BookingEventDto[];
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class BookingListDto {
  @ApiProperty({ type: [BookingDto] }) items!: BookingDto[];
}

export class PartnerBookingDto extends BookingDto {
  @ApiProperty({ type: String, format: "uuid" }) organizationId!: string;
  @ApiProperty({ enum: BOOKING_SOURCES, enumName: "BookingSource" }) source!: BookingSource;
  @ApiProperty({ type: String, nullable: true, description: "Имя клиента (пользователь или ручная запись)" })
  customerName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "Телефон клиента: только при согласии на передачу этому партнёру (D-42) и роли с правом booking.admin.read " +
      "(менеджер, владелец; кассиру — нет, C-20); у ручной записи — введённый партнёром",
  })
  contactPhone!: string | null;
}

export class PartnerBookingListDto {
  @ApiProperty({ type: [PartnerBookingDto] }) items!: PartnerBookingDto[];
}
