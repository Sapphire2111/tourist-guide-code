import { ApiProperty, ApiPropertyOptional, OmitType } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
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
import { LocalizedTextDto } from "../../common/http/index.js";
import {
  MODERATION_CASE_STATUSES,
  MODERATION_DECISIONS,
  OFFER_STATUSES,
  PARTNER_MODULES,
  PARTNER_PLACE_FIELDS,
  PLACE_STATUSES,
  STAFF_INVITE_ROLES,
  VERIFICATION_METHODS,
  type ModerationCaseStatus,
  type ModerationDecision,
  type OfferStatus,
  type PartnerModule,
  type PartnerPlaceField,
  type PlaceStatus,
  type StaffInviteRole,
  type VerificationMethod,
} from "../../db/index.js";
import {
  LongTextDto,
  LonLatDto,
  PlaceMediaDto,
  ScheduleDto,
  ShortTextDto,
  UpdatePlaceDto,
} from "../catalog/index.js";
import { MediaAltTextDto } from "../media/index.js";

// DTO блока 6 «Кабинет партнёра» (ADR-0021): онбординг по шаблону (P12), редактор заведения (P06), модерация (AD02),
// сотрудники и приглашения (P09, P14), акции (P07), переключатель и дашборд (P13, P01). Мультиязычные поля — объект
// «язык → текст», uk обязателен. В PATCH: поле не передано — не меняется; null — очистить (только необязательные).

/** Роли партнёра (scope ORGANIZATION): владелец, менеджер, сотрудник-кассир. */
export const PARTNER_ROLES = ["ORG_OWNER", "ORG_MANAGER", "ORG_STAFF"] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];

/** Состояние приглашения (вычисляется): действует, принято, истекло, отозвано. */
export const STAFF_INVITE_STATES = ["active", "accepted", "expired", "revoked"] as const;
export type StaffInviteState = (typeof STAFF_INVITE_STATES)[number];

/** Срок приглашения сотрудника: 72 часа. */
export const STAFF_INVITE_TTL_HOURS = 72;
/** Комментарий модератора / причина решения. */
export const MODERATION_COMMENT_MAX = 2000;
/** Префикс start_param Mini App для ссылки-приглашения (t.me/<бот>?startapp=<префикс><токен>). */
export const STAFF_INVITE_START_PREFIX = "inv_";

const FIELD_ENUM = { enum: PARTNER_PLACE_FIELDS, enumName: "PartnerPlaceField" } as const;
const ROLE_ENUM = { enum: PARTNER_ROLES, enumName: "PartnerRole" } as const;
const INVITE_ROLE_ENUM = { enum: STAFF_INVITE_ROLES, enumName: "StaffInviteRole" } as const;

// --- шаблоны ---

export class PartnerTemplatesQueryDto {
  @ApiProperty({
    type: String,
    format: "uuid",
    description: "Регион онбординга: категории шаблона — из справочника этого региона",
  })
  @IsUUID()
  regionId!: string;
}

export class PartnerCategoryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, example: "hotels" }) code!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedTextDto;
}

export class PartnerTemplateDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, example: "hotel", description: "hotel | food | chan (D-03)" }) code!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedTextDto;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) description!: LocalizedTextDto | null;
  @ApiProperty({
    ...FIELD_ENUM,
    isArray: true,
    description: "Обязательные поля карточки для отправки на модерацию",
  })
  requiredFields!: PartnerPlaceField[];
  @ApiProperty({
    enum: PARTNER_MODULES,
    enumName: "PartnerModule",
    isArray: true,
    description: "Модули заведения: host_requests — заявки гостей отеля (блок 5), offers — акции",
  })
  modules!: PartnerModule[];
  @ApiProperty({
    type: [PartnerCategoryDto],
    description: "Категории шаблона в регионе (только активные); пусто — шаблон в регионе недоступен",
  })
  categories!: PartnerCategoryDto[];
}

export class PartnerTemplateListDto {
  @ApiProperty({ type: [PartnerTemplateDto] }) items!: PartnerTemplateDto[];
}

// --- онбординг ---

export class PartnerOnboardingDto {
  @ApiProperty({ type: String, format: "uuid", description: "Регион заведения" })
  @IsUUID()
  regionId!: string;

  @ApiProperty({ type: String, example: "hotel", description: "Код шаблона (GET /partner/templates)" })
  @IsString()
  @Matches(/^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/)
  templateCode!: string;

  @ApiProperty({ type: String, format: "uuid", description: "Категория из categories шаблона" })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ type: ShortTextDto, description: "Назва закладу" })
  @IsDefined()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name!: ShortTextDto;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 200,
    description: "Назва організації (юр./комерційна); по умолчанию — название заведения (uk)",
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(200)
  organizationName?: string;
}

// --- организация, место, модерация (для партнёра) ---

export class PartnerModerationSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) caseId!: string;
  @ApiProperty({ enum: MODERATION_CASE_STATUSES, enumName: "ModerationCaseStatus" })
  status!: ModerationCaseStatus;
  @ApiProperty({ enum: MODERATION_DECISIONS, enumName: "ModerationDecision", nullable: true })
  decision!: ModerationDecision | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Комментарий модератора (обязателен при reject и changes_requested)",
  })
  comment!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) submittedAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) decidedAt!: string | null;
}

/** Что может пользователь по своей роли (кнопки P01/P06/P07/P09). */
export class PartnerAbilitiesDto {
  @ApiProperty({ type: Boolean, description: "Редактор заведения P06 (ORG_OWNER, ORG_MANAGER)" })
  editPlace!: boolean;
  @ApiProperty({
    type: Boolean,
    description: "Поля личности места — название, категория, адрес, точка (ORG_OWNER)",
  })
  editIdentity!: boolean;
  @ApiProperty({ type: Boolean, description: "Отправить на модерацию (ORG_OWNER)" }) submit!: boolean;
  @ApiProperty({ type: Boolean, description: "Сотрудники P09 (ORG_OWNER)" }) manageStaff!: boolean;
  @ApiProperty({ type: Boolean, description: "Акции P07 (ORG_OWNER, ORG_MANAGER)" }) manageOffers!: boolean;
  @ApiProperty({ type: Boolean, description: "Заявки гостей P10 (все роли партнёра)" })
  serviceRequests!: boolean;
}

export class PartnerPlaceSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: ShortTextDto }) name!: ShortTextDto;
  @ApiProperty({ enum: PLACE_STATUSES, enumName: "PlaceStatus" }) status!: PlaceStatus;
  @ApiProperty({ type: String, nullable: true, example: "hotel" }) templateCode!: string | null;
  @ApiProperty({
    enum: PARTNER_MODULES,
    enumName: "PartnerModule",
    isArray: true,
    description: "Модули по шаблону",
  })
  modules!: PartnerModule[];
  @ApiProperty({
    type: PartnerModerationSummaryDto,
    nullable: true,
    description: "Последняя заявка на модерацию",
  })
  moderation!: PartnerModerationSummaryDto | null;
  @ApiProperty({
    type: "integer",
    nullable: true,
    description:
      "Открытые заявки гостей (new/accepted/in_progress); null — у заведения нет модуля host_requests",
  })
  openServiceRequests!: number | null;
  @ApiProperty({ type: "integer", description: "Действующие акции (active)" }) activeOffers!: number;
}

export class PartnerOrganizationDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ ...ROLE_ENUM, description: "Роль пользователя в организации" }) role!: PartnerRole;
  @ApiProperty({ type: String, format: "uuid", description: "Назначение роли (RoleAssignment)" })
  assignmentId!: string;
  @ApiProperty({ type: PartnerAbilitiesDto }) abilities!: PartnerAbilitiesDto;
  @ApiProperty({ type: [PartnerPlaceSummaryDto] }) places!: PartnerPlaceSummaryDto[];
}

/** Режим партнёра (P13, P01): организации и заведения пользователя; пусто — показать «Стати партнером» (P12). */
export class PartnerMeDto {
  @ApiProperty({ type: [PartnerOrganizationDto] }) organizations!: PartnerOrganizationDto[];
}

export class PartnerTemplateRefDto {
  @ApiProperty({ type: String, example: "hotel" }) code!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedTextDto;
  @ApiProperty({ ...FIELD_ENUM, isArray: true }) requiredFields!: PartnerPlaceField[];
  @ApiProperty({ enum: PARTNER_MODULES, enumName: "PartnerModule", isArray: true }) modules!: PartnerModule[];
  @ApiProperty({ type: [PartnerCategoryDto], description: "Допустимые категории (в регионе места)" })
  categories!: PartnerCategoryDto[];
}

/** Карточка заведения в редакторе P06. */
export class PartnerPlaceDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) organizationId!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ enum: PLACE_STATUSES, enumName: "PlaceStatus" }) status!: PlaceStatus;
  @ApiProperty({ type: PartnerTemplateRefDto }) template!: PartnerTemplateRefDto;
  @ApiProperty({ ...ROLE_ENUM, description: "Роль пользователя" }) role!: PartnerRole;
  @ApiProperty({ type: PartnerAbilitiesDto }) abilities!: PartnerAbilitiesDto;
  @ApiProperty({
    type: Boolean,
    description:
      "Можно ли сейчас править: false — на модерации (pending_moderation), приостановлено или в архиве",
  })
  editable!: boolean;
  @ApiProperty({ type: String, format: "uuid" }) categoryId!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) localityId!: string | null;
  @ApiProperty({ type: ShortTextDto }) name!: ShortTextDto;
  @ApiProperty({ type: LongTextDto, nullable: true }) description!: LongTextDto | null;
  @ApiProperty({ type: ShortTextDto, nullable: true }) address!: ShortTextDto | null;
  @ApiProperty({ type: LonLatDto, nullable: true }) location!: LonLatDto | null;
  @ApiProperty({ type: String, nullable: true, example: "+380000000001" }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) website!: string | null;
  @ApiProperty({ type: String, nullable: true }) telegram!: string | null;
  @ApiProperty({ type: [String], description: "id тегов" }) tagIds!: string[];
  @ApiProperty({ type: ScheduleDto }) schedule!: ScheduleDto;
  @ApiProperty({
    type: [PlaceMediaDto],
    description: "Фото (ссылки на варианты — GET /media/{id} недоступен партнёру: см. mediaLinks)",
  })
  media!: PlaceMediaDto[];
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
    description: "Ссылка на вариант w320 для превью каждого готового фото: mediaAssetId → url",
  })
  mediaPreview!: Record<string, string>;
  @ApiProperty({
    ...FIELD_ENUM,
    isArray: true,
    description: "Незаполненные обязательные поля шаблона (пусто — можно отправлять на модерацию)",
  })
  missingFields!: PartnerPlaceField[];
  @ApiProperty({
    type: PartnerModerationSummaryDto,
    nullable: true,
    description: "Последняя заявка на модерацию",
  })
  moderation!: PartnerModerationSummaryDto | null;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class PartnerOnboardingResultDto {
  @ApiProperty({ type: PartnerOrganizationDto }) organization!: PartnerOrganizationDto;
  @ApiProperty({ type: PartnerPlaceDto }) place!: PartnerPlaceDto;
}

/**
 * Правка карточки (P06): поля как в админке, без verifiedAt. ORG_MANAGER не меняет поля личности места (categoryId,
 * localityId, name, address, location) — 403 identity_fields_forbidden; у опубликованного места их не меняет никто —
 * 409 errors.partner.identityChangeRequiresModeration.
 */
export class UpdatePartnerPlaceDto extends OmitType(UpdatePlaceDto, ["verifiedAt"] as const) {}

// --- фото ---

export class PartnerMediaUploadRequestDto {
  @ApiProperty({ type: String, example: "image/jpeg", description: "image/jpeg, image/png, image/webp" })
  @IsString()
  @MaxLength(100)
  mime!: string;

  @ApiProperty({ type: Number, minimum: 1, description: "Точный размер файла, байт" })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  size!: number;

  @ApiPropertyOptional({ type: MediaAltTextDto, description: "Alt text (без него место не публикуется)" })
  @IsOptional()
  @ValidateNested()
  @Type(() => MediaAltTextDto)
  alt?: MediaAltTextDto;
}

export class PartnerMediaConfirmDto {
  @ApiPropertyOptional({ type: ShortTextDto, description: "Alt text фото (если не задан при загрузке)" })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShortTextDto)
  alt?: ShortTextDto;

  @ApiPropertyOptional({ type: Boolean, description: "Сделать обложкой" })
  @IsOptional()
  @IsBoolean()
  isCover?: boolean;
}

// --- модерация (партнёр) ---

export class PartnerSubmitDto {
  @ApiProperty({
    type: Boolean,
    description: "Согласие с условиями партнёра (S-05 п. 4); false — 422",
  })
  @IsBoolean()
  acceptTerms!: boolean;

  @ApiPropertyOptional({
    type: String,
    maxLength: MODERATION_COMMENT_MAX,
    description: "Комментарий для модератора (как связаться для подтверждения права на заведение, D-47)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(MODERATION_COMMENT_MAX)
  note?: string;
}

// --- сотрудники и приглашения ---

export class PartnerStaffMemberDto {
  @ApiProperty({ type: String, format: "uuid" }) assignmentId!: string;
  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  @ApiProperty({ type: String, nullable: true }) displayName!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Telegram username (без @)" })
  username!: string | null;
  @ApiProperty(ROLE_ENUM) role!: PartnerRole;
  @ApiProperty({ type: String, format: "date-time" }) grantedAt!: string;
  @ApiProperty({ type: Boolean, description: "Это вы" }) isMe!: boolean;
}

export class StaffInviteDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty(INVITE_ROLE_ENUM) role!: StaffInviteRole;
  @ApiProperty({ enum: STAFF_INVITE_STATES, enumName: "StaffInviteState" }) state!: StaffInviteState;
  @ApiProperty({ type: String, format: "date-time" }) expiresAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) acceptedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Кто принял (имя)" }) acceptedByName!:
    | string
    | null;
}

export class PartnerStaffDto {
  @ApiProperty({ type: [PartnerStaffMemberDto] }) members!: PartnerStaffMemberDto[];
  @ApiProperty({ type: [StaffInviteDto], description: "Приглашения (последние 50)" })
  invites!: StaffInviteDto[];
}

export class CreateStaffInviteDto {
  @ApiProperty({ ...INVITE_ROLE_ENUM, description: "ORG_MANAGER — менеджер, ORG_STAFF — касир" })
  @IsIn(STAFF_INVITE_ROLES)
  role!: StaffInviteRole;
}

export class StaffInviteCreatedDto {
  @ApiProperty({ type: StaffInviteDto }) invite!: StaffInviteDto;
  @ApiProperty({
    type: String,
    description: "Одноразовый токен (показывается один раз; в БД — только хэш)",
  })
  token!: string;
  @ApiProperty({
    type: String,
    example: "inv_…",
    description: "start_param Mini App: ссылка t.me/<бот>?startapp=<startParam> или QR",
  })
  startParam!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Готовая ссылка t.me (если задан TELEGRAM_BOT_USERNAME)",
  })
  link!: string | null;
}

export class ChangeStaffRoleDto {
  @ApiProperty({ ...INVITE_ROLE_ENUM, description: "Новая роль сотрудника (владельца менять нельзя)" })
  @IsIn(STAFF_INVITE_ROLES)
  role!: StaffInviteRole;
}

export class StaffInvitePreviewDto {
  @ApiProperty({ type: String }) organizationName!: string;
  @ApiProperty({ type: [ShortTextDto], description: "Заведения организации" }) placeNames!: ShortTextDto[];
  @ApiProperty(INVITE_ROLE_ENUM) role!: StaffInviteRole;
  @ApiProperty({ enum: STAFF_INVITE_STATES, enumName: "StaffInviteState" }) state!: StaffInviteState;
  @ApiProperty({ type: String, format: "date-time" }) expiresAt!: string;
  @ApiProperty({ type: Boolean, description: "Пользователь уже работает в этой организации" })
  alreadyMember!: boolean;
}

export class StaffInviteAcceptedDto {
  @ApiProperty({ type: String, format: "uuid" }) organizationId!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty(INVITE_ROLE_ENUM) role!: StaffInviteRole;
  @ApiProperty({ type: String, format: "uuid" }) assignmentId!: string;
}

// --- акции ---

export class OfferDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: ShortTextDto }) title!: ShortTextDto;
  @ApiProperty({ type: LongTextDto, nullable: true }) description!: LongTextDto | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) startsAt!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) endsAt!: string | null;
  @ApiProperty({ enum: OFFER_STATUSES, enumName: "OfferStatus" }) status!: OfferStatus;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class OfferListDto {
  @ApiProperty({ type: [OfferDto] }) items!: OfferDto[];
}

export class UpdateOfferDto {
  @ApiPropertyOptional({ type: ShortTextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShortTextDto)
  title?: ShortTextDto;

  @ApiPropertyOptional({ type: LongTextDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LongTextDto)
  description?: LongTextDto | null;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  startsAt?: string | null;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true, description: "Позже startsAt" })
  @IsOptional()
  @IsISO8601({ strict: true })
  endsAt?: string | null;
}

export class CreateOfferDto extends OmitType(UpdateOfferDto, ["title"] as const) {
  @ApiProperty({ type: ShortTextDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ShortTextDto)
  title!: ShortTextDto;
}

export class OfferListQueryDto {
  @ApiPropertyOptional({ enum: OFFER_STATUSES, enumName: "OfferStatus", description: "Без фильтра — все" })
  @IsOptional()
  @IsIn(OFFER_STATUSES)
  status?: OfferStatus;
}

// --- модерация (админка, AD02) ---

export class ModerationCasesQueryDto {
  @ApiPropertyOptional({
    enum: MODERATION_CASE_STATUSES,
    enumName: "ModerationCaseStatus",
    description: "По умолчанию open (очередь)",
  })
  @IsOptional()
  @IsIn(MODERATION_CASE_STATUSES)
  status?: ModerationCaseStatus;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description:
      "Регион (SUPERADMIN — любой; модератор/админ региона — только свой). Без него — все доступные",
  })
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Только заявки этого места (карточка места в админке: статус модерации и история)",
  })
  @IsOptional()
  @IsUUID()
  placeId?: string;
}

export class ModerationCaseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: ShortTextDto }) placeName!: ShortTextDto;
  @ApiProperty({ enum: PLACE_STATUSES, enumName: "PlaceStatus" }) placeStatus!: PlaceStatus;
  @ApiProperty({ type: String, format: "uuid" }) organizationId!: string;
  @ApiProperty({ type: String }) organizationName!: string;
  @ApiProperty({ type: String, nullable: true, example: "hotel" }) templateCode!: string | null;
  @ApiProperty({ type: LocalizedTextDto, nullable: true, description: "Название шаблона" })
  templateName!: LocalizedTextDto | null;
  @ApiProperty({ enum: MODERATION_CASE_STATUSES, enumName: "ModerationCaseStatus" })
  status!: ModerationCaseStatus;
  @ApiProperty({ enum: MODERATION_DECISIONS, enumName: "ModerationDecision", nullable: true })
  decision!: ModerationDecision | null;
  @ApiProperty({ type: String, nullable: true }) comment!: string | null;
  @ApiProperty({ enum: VERIFICATION_METHODS, enumName: "VerificationMethod", nullable: true })
  verificationMethod!: VerificationMethod | null;
  @ApiProperty({ type: String, format: "uuid" }) submittedBy!: string;
  @ApiProperty({ type: String, nullable: true, description: "Имя подавшего (владелец)" })
  submittedByName!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) submittedAt!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) decidedBy!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) decidedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Кто решил: имя или логин админки" })
  decidedByName!: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      "Заявка организации, где у модератора есть роль (BR-12): решить нельзя — 403 own_organization",
  })
  ownOrganization!: boolean;
}

export class ModerationCaseListDto {
  @ApiProperty({ type: [ModerationCaseDto], description: "Старые сверху (возраст заявки)" })
  items!: ModerationCaseDto[];
}

export class PossibleDuplicateDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: ShortTextDto }) name!: ShortTextDto;
  @ApiProperty({ enum: PLACE_STATUSES, enumName: "PlaceStatus" }) status!: PlaceStatus;
  @ApiProperty({
    type: String,
    enum: ["manual", "google"],
    description: "google — место из импорта Google Places",
  })
  source!: "manual" | "google";
  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Расстояние до места заявки, м (null — нет точки)",
  })
  distanceMeters!: number | null;
}

export class ModerationOwnerDto {
  @ApiProperty({ type: String, format: "uuid" }) userId!: string;
  @ApiProperty({ type: String, nullable: true }) displayName!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Telegram username (для связи, D-47)" })
  username!: string | null;
}

export class ModerationCaseDetailDto extends ModerationCaseDto {
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "Снимок карточки на момент подачи (поля как в PlaceDto админки, график, фото)",
  })
  placeSnapshot!: Record<string, unknown>;
  @ApiProperty({ type: String, nullable: true, description: "Комментарий партнёра при подаче" })
  partnerNote!: string | null;
  @ApiProperty({ type: [ModerationOwnerDto], description: "Владельцы организации" })
  owners!: ModerationOwnerDto[];
  @ApiProperty({ type: [ModerationCaseDto], description: "Прошлые заявки по этому месту (новые сверху)" })
  history!: ModerationCaseDto[];
  @ApiProperty({
    type: [String],
    description: "Что мешает публикации сейчас (PublishProblem каталога) — пусто: можно одобрять",
  })
  publishProblems!: string[];
  @ApiProperty({
    type: [PossibleDuplicateDto],
    description:
      "Возможные дубли: места региона в радиусе ~150 м или с похожим названием (до 5; источник google — импорт)",
  })
  possibleDuplicates!: PossibleDuplicateDto[];
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
    description: "Превью фото снимка: mediaAssetId → ссылка w320 (строится при чтении)",
  })
  snapshotMediaPreview!: Record<string, string>;
}

export class ApproveModerationDto {
  @ApiProperty({
    enum: VERIFICATION_METHODS,
    enumName: "VerificationMethod",
    description: "Как подтверждено право на заведение (D-47 А)",
  })
  @IsIn(VERIFICATION_METHODS)
  verificationMethod!: VerificationMethod;

  @ApiPropertyOptional({ type: String, maxLength: MODERATION_COMMENT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(MODERATION_COMMENT_MAX)
  comment?: string;
}

export class ModerationReasonDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: MODERATION_COMMENT_MAX,
    description: "Причина / что исправить (обязательна, видна партнёру)",
  })
  @IsString()
  @MinLength(1)
  @Matches(/\S/)
  @MaxLength(MODERATION_COMMENT_MAX)
  reason!: string;
}
