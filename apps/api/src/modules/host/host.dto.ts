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
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { LocalizedDescriptionDto, LocalizedNameDto, LocalizedTextDto } from "../../common/http/index.js";
import {
  ROOM_SOURCES,
  SERVICE_REQUEST_ACTORS,
  SERVICE_REQUEST_STATUSES,
  type RoomSource,
  type ServiceRequestActor,
  type ServiceRequestStatus,
} from "../../db/index.js";

// DTO блока 5 (ADR-0020): «Про заклад» (C03), заявки гостя (S-03, C22), экран персонала (P10), настройки отеля и
// персонал в админке. Регион туриста — regionId (как в каталоге гида, ADR-0019); персонал и админ — из назначений.

/** Разделы «Про заклад» (C03): rules — правила, contacts, breakfast, checkout, pool, transfer, custom. */
export const HOST_SECTION_KINDS = [
  "rules",
  "contacts",
  "breakfast",
  "checkout",
  "pool",
  "transfer",
  "custom",
] as const;
export type HostSectionKind = (typeof HOST_SECTION_KINDS)[number];

/** Код услуги — как коды справочников (is_catalog_code): cleaning, towels, breakfast, pool, late-checkout… */
export const SERVICE_CODE_RE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;
/** Время «HH:MM» (местное время региона). */
export const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const ROOM_LABEL_MAX = 20;
export const COMMENT_MAX = 500;
export const REASON_MAX = 500;
export const SLA_MIN = 5;
export const SLA_MAX = 1440;
export const HOST_SECTIONS_MAX = 20;
export const HOST_SERVICES_MAX = 20;

/** Статусы, которые выставляет персонал (P10). */
export const STAFF_TARGET_STATUSES = ["accepted", "in_progress", "done", "rejected"] as const;
export type StaffTargetStatus = (typeof STAFF_TARGET_STATUSES)[number];

/** Роли персонала заведения, которые назначает админ региона. */
export const PLACE_STAFF_ROLES = ["ORG_STAFF", "ORG_OWNER"] as const;
export type PlaceStaffRole = (typeof PLACE_STAFF_ROLES)[number];

/** Строка-число не больше 2^53 − 1 (Telegram user id помещается в JS number без потери точности). */
function MaxSafeIntegerString(): PropertyDecorator {
  return ValidateBy({
    name: "maxSafeInteger",
    validator: {
      validate: (v: unknown) => typeof v === "string" && Number(v) <= Number.MAX_SAFE_INTEGER,
      defaultMessage: () => "telegramUserId больше 2^53 - 1",
    },
  });
}

// --- запросы ---

export class HostRegionQueryDto {
  @ApiProperty({
    type: String,
    format: "uuid",
    description: "Регион туриста: regionId из GET /context/{start_param}",
  })
  @IsUUID()
  regionId!: string;
}

export class HostModuleQueryDto extends HostRegionQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description:
      "EntryContext входа (из GET /context): с QR этого места — пароль Wi-Fi и номер комнаты QR номера (D-49)",
  })
  @IsOptional()
  @IsUUID()
  entryContextId?: string;
}

export class CreateServiceRequestDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  regionId!: string;

  @ApiProperty({ type: String, format: "uuid", description: "Место-отель (HostModule)" })
  @IsUUID()
  placeId!: string;

  @ApiProperty({ type: String, example: "cleaning", description: "Код услуги из HostModule.services" })
  @Matches(SERVICE_CODE_RE)
  serviceCode!: string;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "EntryContext входа: у QR номера номер комнаты берётся из него (roomLabel игнорируется)",
  })
  @IsOptional()
  @IsUUID()
  entryContextId?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: ROOM_LABEL_MAX,
    example: "204",
    description: "Номер комнаты, введённый гостем на общем QR (пометка «введено гостем»)",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ROOM_LABEL_MAX)
  roomLabel?: string;

  @ApiPropertyOptional({ type: String, maxLength: COMMENT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(COMMENT_MAX)
  comment?: string;
}

export class CancelServiceRequestDto extends HostRegionQueryDto {}

export class MyServiceRequestsQueryDto extends HostRegionQueryDto {}

export class StaffServiceRequestsQueryDto {
  @ApiPropertyOptional({ enum: SERVICE_REQUEST_STATUSES, enumName: "ServiceRequestStatus" })
  @IsOptional()
  @IsIn(SERVICE_REQUEST_STATUSES)
  status?: ServiceRequestStatus;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Одно из своих мест; без него — все места сотрудника",
  })
  @IsOptional()
  @IsUUID()
  placeId?: string;
}

export class UpdateServiceRequestStatusDto {
  @ApiProperty({ enum: STAFF_TARGET_STATUSES, enumName: "StaffServiceRequestStatus" })
  @IsIn(STAFF_TARGET_STATUSES)
  status!: StaffTargetStatus;

  @ApiPropertyOptional({
    type: String,
    maxLength: REASON_MAX,
    description: "Причина — обязательна для rejected",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REASON_MAX)
  reason?: string;
}

// --- «Про заклад» ---

export class HostSectionDto {
  @ApiProperty({ enum: HOST_SECTION_KINDS, enumName: "HostSectionKind" })
  @IsIn(HOST_SECTION_KINDS)
  kind!: HostSectionKind;

  @ApiProperty({ type: LocalizedTextDto })
  title!: LocalizedTextDto;

  @ApiProperty({ type: LocalizedTextDto })
  content!: LocalizedTextDto;

  @ApiProperty({ type: "integer" })
  sortOrder!: number;
}

export class HostServiceDto {
  @ApiProperty({ type: String, example: "cleaning" })
  code!: string;

  @ApiProperty({ type: LocalizedTextDto })
  title!: LocalizedTextDto;

  @ApiProperty({ type: LocalizedTextDto, nullable: true })
  description!: LocalizedTextDto | null;

  @ApiProperty({ type: "integer", description: "Целевое время выполнения, мин (SLA, D-55)" })
  slaMinutes!: number;

  @ApiProperty({ type: "integer" })
  sortOrder!: number;
}

export class HostHoursDto {
  @ApiProperty({ type: String, example: "08:00", description: "Начало приёма заявок, местное время" })
  from!: string;

  @ApiProperty({ type: String, example: "22:00", description: "Конец (<= from — через полночь)" })
  to!: string;

  @ApiProperty({ type: String, example: "Europe/Kyiv" })
  timezone!: string;
}

export class HostWifiDto {
  @ApiProperty({ type: String }) ssid!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Только при входе с QR этого места (entryContextId), иначе null",
  })
  password!: string | null;
}

export class RoomContextDto {
  @ApiProperty({ type: String, example: "204" }) label!: string;

  @ApiProperty({
    enum: ROOM_SOURCES,
    enumName: "RoomSource",
    description: "qr — из QR номера; guest — введено гостем",
  })
  source!: RoomSource;
}

/** «Про заклад» (C03) для гостя. */
export class HostModuleDto {
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: LocalizedTextDto }) placeName!: LocalizedTextDto;

  @ApiProperty({ type: HostWifiDto, nullable: true }) wifi!: HostWifiDto | null;

  @ApiProperty({ type: String, nullable: true, example: "+380501234567" })
  receptionPhone!: string | null;

  @ApiProperty({ type: HostHoursDto, nullable: true, description: "null — заявки принимаются круглосуточно" })
  hours!: HostHoursDto | null;

  @ApiProperty({ type: Boolean, description: "Сейчас часы приёма (иначе заявка — «буде оброблено з …»)" })
  acceptingNow!: boolean;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "Когда начнётся приём, если сейчас вне часов",
  })
  nextOpensAt!: string | null;

  @ApiProperty({ type: [HostSectionDto] }) sections!: HostSectionDto[];

  @ApiProperty({ type: [HostServiceDto], description: "Включённые услуги-заявки по порядку" })
  services!: HostServiceDto[];

  @ApiProperty({
    type: RoomContextDto,
    nullable: true,
    description: "Номер комнаты из QR номера (entryContextId), иначе null — гость вводит сам",
  })
  room!: RoomContextDto | null;
}

// --- заявки ---

export class ServiceRequestEventDto {
  @ApiProperty({ enum: SERVICE_REQUEST_STATUSES, enumName: "ServiceRequestStatus", nullable: true })
  fromStatus!: ServiceRequestStatus | null;

  @ApiProperty({ enum: SERVICE_REQUEST_STATUSES, enumName: "ServiceRequestStatus" })
  toStatus!: ServiceRequestStatus;

  @ApiProperty({ enum: SERVICE_REQUEST_ACTORS, enumName: "ServiceRequestActor" })
  actor!: ServiceRequestActor;

  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) at!: string;
}

export class ServiceRequestDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: LocalizedTextDto }) placeName!: LocalizedTextDto;
  @ApiProperty({ type: String, example: "cleaning" }) serviceCode!: string;
  @ApiProperty({ type: LocalizedTextDto }) serviceTitle!: LocalizedTextDto;
  @ApiProperty({ type: RoomContextDto, nullable: true }) room!: RoomContextDto | null;
  @ApiProperty({ type: String, nullable: true }) comment!: string | null;

  @ApiProperty({ enum: SERVICE_REQUEST_STATUSES, enumName: "ServiceRequestStatus" })
  status!: ServiceRequestStatus;

  @ApiProperty({ type: String, nullable: true, description: "Причина отклонения" })
  statusReason!: string | null;

  @ApiProperty({ type: Boolean, description: "Создана вне часов приёма" }) outsideHours!: boolean;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "«Буде оброблено з …» — начало приёма, если создана вне часов",
  })
  processFrom!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true }) slaDueAt!: string | null;

  @ApiProperty({ type: Boolean, description: "Просрочен SLA (заявка не закрыта, срок прошёл)" })
  overdue!: boolean;

  @ApiProperty({ type: Boolean, description: "Гость может отменить (new, accepted)" })
  cancellable!: boolean;

  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: [ServiceRequestEventDto] }) history!: ServiceRequestEventDto[];
}

export class ServiceRequestListDto {
  @ApiProperty({ type: [ServiceRequestDto], description: "Новые сверху, до 100" })
  items!: ServiceRequestDto[];
}

/** Заявка на экране персонала (P10): плюс имя гостя из Telegram (D-49 А) и допустимые переходы. */
export class StaffServiceRequestDto extends ServiceRequestDto {
  @ApiProperty({ type: String, nullable: true, description: "Имя гостя в Telegram (first_name)" })
  guestName!: string | null;

  @ApiProperty({
    enum: STAFF_TARGET_STATUSES,
    enumName: "StaffServiceRequestStatus",
    isArray: true,
    description: "Куда персонал может перевести заявку сейчас",
  })
  allowedTransitions!: StaffTargetStatus[];
}

export class StaffServiceRequestListDto {
  @ApiProperty({ type: [StaffServiceRequestDto], description: "Новые сверху, до 200" })
  items!: StaffServiceRequestDto[];
}

export class StaffPlaceDto {
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedTextDto;
  @ApiProperty({ enum: PLACE_STAFF_ROLES, enumName: "PlaceStaffRole" }) role!: PlaceStaffRole;

  @ApiProperty({ type: "integer", description: "Открытых заявок (new, accepted, in_progress)" })
  openRequests!: number;
}

export class StaffPlaceListDto {
  @ApiProperty({
    type: [StaffPlaceDto],
    description: "Места, где пользователь — персонал (пусто — режима персонала нет, D-50)",
  })
  items!: StaffPlaceDto[];
}

// --- админка: настройки «Про заклад» ---

export class HostSectionInputDto {
  @ApiProperty({ enum: HOST_SECTION_KINDS, enumName: "HostSectionKind" })
  @IsIn(HOST_SECTION_KINDS)
  kind!: HostSectionKind;

  @ApiProperty({ type: LocalizedNameDto })
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  title!: LocalizedNameDto;

  @ApiProperty({ type: LocalizedDescriptionDto })
  @ValidateNested()
  @Type(() => LocalizedDescriptionDto)
  content!: LocalizedDescriptionDto;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 10000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
}

export class HostServiceInputDto {
  @ApiProperty({ type: String, example: "cleaning", description: "Уникален в модуле" })
  @Matches(SERVICE_CODE_RE)
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

  @ApiProperty({ type: "integer", minimum: SLA_MIN, maximum: SLA_MAX, example: 60 })
  @IsInt()
  @Min(SLA_MIN)
  @Max(SLA_MAX)
  slaMinutes!: number;

  @ApiPropertyOptional({ type: Boolean, default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 10000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
}

export class HostHoursInputDto {
  @ApiProperty({ type: String, example: "08:00" })
  @Matches(HHMM_RE)
  from!: string;

  @ApiProperty({ type: String, example: "22:00" })
  @Matches(HHMM_RE)
  to!: string;
}

/** Полная замена настроек «Про заклад» места (PUT). */
export class PutHostModuleDto {
  @ApiPropertyOptional({
    type: Boolean,
    default: true,
    description: "false — раздел скрыт, заявки не принимаются",
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  wifiSsid?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 128 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  wifiPassword?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: "+380501234567", description: "E.164" })
  @IsOptional()
  @Matches(/^\+[1-9][0-9]{6,14}$/)
  receptionPhone?: string | null;

  @ApiPropertyOptional({
    type: HostHoursInputDto,
    nullable: true,
    description: "Часы приёма заявок; null — круглосуточно",
  })
  @ValidateIf((o: PutHostModuleDto) => o.hours !== undefined && o.hours !== null)
  @ValidateNested()
  @Type(() => HostHoursInputDto)
  hours?: HostHoursInputDto | null;

  @ApiProperty({ type: [HostSectionInputDto] })
  @IsArray()
  @ArrayMaxSize(HOST_SECTIONS_MAX)
  @ValidateNested({ each: true })
  @Type(() => HostSectionInputDto)
  sections!: HostSectionInputDto[];

  @ApiProperty({ type: [HostServiceInputDto] })
  @IsArray()
  @ArrayMaxSize(HOST_SERVICES_MAX)
  @ValidateNested({ each: true })
  @Type(() => HostServiceInputDto)
  services!: HostServiceInputDto[];
}

export class AdminHostServiceDto extends HostServiceDto {
  @ApiProperty({ type: Boolean }) enabled!: boolean;
}

export class AdminHostModuleDto {
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;

  @ApiProperty({
    type: Boolean,
    description: "false — модуль ещё не настраивался (ответ — значения по умолчанию)",
  })
  configured!: boolean;

  @ApiProperty({ type: Boolean }) enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) wifiSsid!: string | null;
  @ApiProperty({ type: String, nullable: true }) wifiPassword!: string | null;
  @ApiProperty({ type: String, nullable: true }) receptionPhone!: string | null;
  @ApiProperty({ type: HostHoursInputDto, nullable: true }) hours!: HostHoursInputDto | null;
  @ApiProperty({ type: [HostSectionDto] }) sections!: HostSectionDto[];
  @ApiProperty({ type: [AdminHostServiceDto] }) services!: AdminHostServiceDto[];
  @ApiProperty({ type: String, format: "date-time", nullable: true }) updatedAt!: string | null;
}

// --- админка: персонал места ---

export class AssignPlaceStaffDto {
  @ApiPropertyOptional({
    type: String,
    example: "123456789",
    description: "Telegram user id пользователя, уже входившего в Mini App (или username)",
  })
  @ValidateIf((o: AssignPlaceStaffDto) => o.username === undefined)
  @Matches(/^[1-9][0-9]{0,15}$/)
  @MaxSafeIntegerString()
  telegramUserId?: string;

  @ApiPropertyOptional({ type: String, example: "hotel_staff", description: "Telegram username без @" })
  @ValidateIf((o: AssignPlaceStaffDto) => o.telegramUserId === undefined)
  @Matches(/^@?[A-Za-z0-9_]{5,32}$/)
  username?: string;

  @ApiPropertyOptional({ enum: PLACE_STAFF_ROLES, enumName: "PlaceStaffRole", default: "ORG_STAFF" })
  @IsOptional()
  @IsIn(PLACE_STAFF_ROLES)
  role?: PlaceStaffRole;
}

export class PlaceStaffMemberDto {
  @ApiProperty({ type: String, format: "uuid", description: "Назначение роли (для снятия)" })
  assignmentId!: string;

  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  @ApiProperty({ enum: PLACE_STAFF_ROLES, enumName: "PlaceStaffRole" }) role!: PlaceStaffRole;
  @ApiProperty({ type: String, nullable: true }) telegramUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) username!: string | null;
  @ApiProperty({ type: String, nullable: true }) firstName!: string | null;

  @ApiProperty({
    type: Boolean,
    description: "Дал согласие на сервисные сообщения бота (уведомления о заявках)",
  })
  notificationsEnabled!: boolean;

  @ApiProperty({ type: String, format: "date-time" }) grantedAt!: string;
}

export class PlaceStaffListDto {
  @ApiProperty({ type: [PlaceStaffMemberDto] }) items!: PlaceStaffMemberDto[];
}
