import { ApiProperty, ApiPropertyOptional, OmitType } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { CursorQueryDto } from "../../common/http/index.js";
import {
  BADGE_ACTIONS,
  HOME_SECTIONS,
  LOCALITY_KINDS,
  PLACE_STATUSES,
  REGION_STATUSES,
  TAG_GROUPS,
  type BadgeAction,
  type Category,
  type HomeSection,
  type LocalityKind,
  type PlaceBadgeEvent,
  type PlaceStatus,
  type Region,
  type RegionStatus,
  type Tag,
  type TagGroup,
} from "../../db/index.js";
import { PUBLISH_PROBLEMS, type PublishProblem } from "./catalog-rules.js";
import type { LocalityRecord, PlaceMediaRecord } from "./catalog.repository.js";
import type { PlaceDetails, PlaceSchedule } from "./catalog.service.js";

// DTO админки каталога (блок 3, ADR-0017). Мультиязычные поля — объект «язык → текст», uk обязателен (D-05: контент
// только uk, en — необязателен). В PATCH: поле не передано — не меняется; null — очистить (только у необязательных).

/** В PATCH обязательное поле можно не передавать, но нельзя обнулить. */
const Present = () => ValidateIf((_o: unknown, v: unknown) => v !== undefined);

const CODE_RE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;
const CODE_DOC = { type: String, pattern: CODE_RE.source, example: "where-to-eat" };
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIME_DOC = { type: String, pattern: TIME_RE.source, example: "09:00" };
const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;
const TELEGRAM_RE = /^[A-Za-z0-9_]{5,32}$/;

export class ShortTextDto {
  @ApiProperty({ type: String, maxLength: 300 })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  uk!: string;

  @ApiPropertyOptional({ type: String, maxLength: 300 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  en?: string;
}

export class LongTextDto {
  @ApiProperty({ type: String, maxLength: 5000 })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  uk!: string;

  @ApiPropertyOptional({ type: String, maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  en?: string;
}

/** Точка WGS 84. */
export class LonLatDto {
  @ApiProperty({ type: Number, minimum: -180, maximum: 180, example: 24.5626 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lon!: number;

  @ApiProperty({ type: Number, minimum: -90, maximum: 90, example: 48.4475 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat!: number;
}

const toText = (t: { uk: string; en?: string } | null | undefined) =>
  t === undefined ? undefined : t === null ? null : { ...t };

// --- regions ---

export class RegionDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, example: "test-region" }) code!: string;
  @ApiProperty({ type: ShortTextDto }) name!: ShortTextDto;
  @ApiProperty({ enum: REGION_STATUSES, enumName: "RegionStatus" }) status!: RegionStatus;
  @ApiProperty({ type: String, example: "Europe/Kyiv", description: "IANA-зона: график мест — в ней" })
  timezone!: string;
  @ApiProperty({ type: String, example: "uk" }) defaultLanguage!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export const toRegionDto = (r: Region): RegionDto => ({
  id: r.id,
  code: r.code,
  name: r.name_i18n,
  status: r.status,
  timezone: r.timezone,
  defaultLanguage: r.default_language,
  updatedAt: r.updated_at.toISOString(),
});

export class RegionListDto {
  @ApiProperty({ type: [RegionDto] }) items!: RegionDto[];
}

export class UpdateRegionDto {
  @ApiPropertyOptional({ type: ShortTextDto })
  @Present()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name?: ShortTextDto;

  @ApiPropertyOptional({ type: String, example: "Europe/Kyiv" })
  @Present()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ type: String, example: "uk", pattern: "^[a-z]{2,3}(-[A-Z]{2})?$" })
  @Present()
  @Matches(/^[a-z]{2,3}(-[A-Z]{2})?$/)
  defaultLanguage?: string;
}

export class CreateRegionDto extends OmitType(UpdateRegionDto, ["name"] as const) {
  @ApiProperty(CODE_DOC)
  @Matches(CODE_RE)
  code!: string;

  @ApiProperty({ type: ShortTextDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name!: ShortTextDto;
}

export class RegionStatusDto {
  @ApiProperty({ enum: REGION_STATUSES, enumName: "RegionStatus" })
  @IsIn(REGION_STATUSES)
  status!: RegionStatus;

  @ApiPropertyOptional({ type: String, maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

// --- localities ---

export class LocalityDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty(CODE_DOC) code!: string;
  @ApiProperty({ enum: LOCALITY_KINDS, enumName: "LocalityKind" }) kind!: LocalityKind;
  @ApiProperty({ type: ShortTextDto }) name!: ShortTextDto;
  @ApiProperty({ type: LonLatDto, nullable: true }) location!: LonLatDto | null;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
  @ApiProperty({ type: Boolean }) active!: boolean;
}

export const toLocalityDto = (l: LocalityRecord): LocalityDto => ({
  id: l.id,
  code: l.code,
  kind: l.kind,
  name: l.name_i18n,
  location: l.location,
  sortOrder: l.sort_order,
  active: l.active,
});

export class LocalityListDto {
  @ApiProperty({ type: [LocalityDto] }) items!: LocalityDto[];
}

export class UpdateLocalityDto {
  @ApiPropertyOptional(CODE_DOC)
  @Present()
  @Matches(CODE_RE)
  code?: string;

  @ApiPropertyOptional({ enum: LOCALITY_KINDS, enumName: "LocalityKind" })
  @Present()
  @IsIn(LOCALITY_KINDS)
  kind?: LocalityKind;

  @ApiPropertyOptional({ type: ShortTextDto })
  @Present()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name?: ShortTextDto;

  @ApiPropertyOptional({ type: LonLatDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LonLatDto)
  location?: LonLatDto | null;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 100000 })
  @Present()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;

  @ApiPropertyOptional({ type: Boolean })
  @Present()
  @IsBoolean()
  active?: boolean;
}

export class CreateLocalityDto extends OmitType(UpdateLocalityDto, ["code", "name"] as const) {
  @ApiProperty(CODE_DOC)
  @Matches(CODE_RE)
  code!: string;

  @ApiProperty({ type: ShortTextDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name!: ShortTextDto;
}

export const localityInput = (b: UpdateLocalityDto) => ({
  code: b.code,
  kind: b.kind,
  name: toText(b.name) ?? undefined,
  location: b.location === undefined ? undefined : b.location && { lon: b.location.lon, lat: b.location.lat },
  sortOrder: b.sortOrder,
  active: b.active,
});

// --- categories ---

export class CategoryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) parentId!: string | null;
  @ApiProperty(CODE_DOC) code!: string;
  @ApiProperty({ type: ShortTextDto }) name!: ShortTextDto;
  @ApiProperty({ type: String, nullable: true, example: "utensils" }) icon!: string | null;
  @ApiProperty({ enum: HOME_SECTIONS, enumName: "HomeSection", nullable: true })
  homeSection!: HomeSection | null;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
  @ApiProperty({ type: Boolean }) active!: boolean;
}

export const toCategoryDto = (c: Category): CategoryDto => ({
  id: c.id,
  parentId: c.parent_id,
  code: c.code,
  name: c.name_i18n,
  icon: c.icon,
  homeSection: c.home_section,
  sortOrder: c.sort_order,
  active: c.active,
});

export class CategoryListDto {
  @ApiProperty({ type: [CategoryDto], description: "Плоский список: корневые и подкатегории (parentId)" })
  items!: CategoryDto[];
}

export class UpdateCategoryDto {
  @ApiPropertyOptional(CODE_DOC)
  @Present()
  @Matches(CODE_RE)
  code?: string;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    nullable: true,
    description: "Корневая категория региона; null — сделать корневой",
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({ type: ShortTextDto })
  @Present()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name?: ShortTextDto;

  @ApiPropertyOptional({ type: String, nullable: true, pattern: "^[a-z0-9][a-z0-9-]{0,63}$" })
  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9-]{0,63}$/)
  icon?: string | null;

  @ApiPropertyOptional({
    enum: HOME_SECTIONS,
    enumName: "HomeSection",
    nullable: true,
    description: "Кнопка главной C02 — только у корневой категории",
  })
  @IsOptional()
  @IsIn(HOME_SECTIONS)
  homeSection?: HomeSection | null;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 100000 })
  @Present()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;

  @ApiPropertyOptional({ type: Boolean })
  @Present()
  @IsBoolean()
  active?: boolean;
}

export class CreateCategoryDto extends OmitType(UpdateCategoryDto, ["code", "name"] as const) {
  @ApiProperty(CODE_DOC)
  @Matches(CODE_RE)
  code!: string;

  @ApiProperty({ type: ShortTextDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name!: ShortTextDto;
}

export const categoryInput = (b: UpdateCategoryDto) => ({
  code: b.code,
  parentId: b.parentId,
  name: toText(b.name) ?? undefined,
  icon: b.icon,
  homeSection: b.homeSection,
  sortOrder: b.sortOrder,
  active: b.active,
});

// --- tags ---

export class TagDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty(CODE_DOC) code!: string;
  @ApiProperty({ type: ShortTextDto }) name!: ShortTextDto;
  @ApiProperty({ enum: TAG_GROUPS, enumName: "TagGroup" }) group!: TagGroup;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
  @ApiProperty({ type: Boolean }) active!: boolean;
}

export const toTagDto = (tag: Tag): TagDto => ({
  id: tag.id,
  code: tag.code,
  name: tag.name_i18n,
  group: tag.tag_group,
  sortOrder: tag.sort_order,
  active: tag.active,
});

export class TagListDto {
  @ApiProperty({ type: [TagDto] }) items!: TagDto[];
}

export class UpdateTagDto {
  @ApiPropertyOptional(CODE_DOC)
  @Present()
  @Matches(CODE_RE)
  code?: string;

  @ApiPropertyOptional({ type: ShortTextDto })
  @Present()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name?: ShortTextDto;

  @ApiPropertyOptional({ enum: TAG_GROUPS, enumName: "TagGroup" })
  @Present()
  @IsIn(TAG_GROUPS)
  group?: TagGroup;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 100000 })
  @Present()
  @IsInt()
  @Min(0)
  @Max(100000)
  sortOrder?: number;

  @ApiPropertyOptional({ type: Boolean })
  @Present()
  @IsBoolean()
  active?: boolean;
}

export class CreateTagDto extends OmitType(UpdateTagDto, ["code", "name"] as const) {
  @ApiProperty(CODE_DOC)
  @Matches(CODE_RE)
  code!: string;

  @ApiProperty({ type: ShortTextDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name!: ShortTextDto;
}

export const tagInput = (b: UpdateTagDto) => ({
  code: b.code,
  name: toText(b.name) ?? undefined,
  group: b.group,
  sortOrder: b.sortOrder,
  active: b.active,
});

// --- places ---

export class PlaceDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: PLACE_STATUSES, enumName: "PlaceStatus" }) status!: PlaceStatus;
  @ApiProperty({ type: String, format: "uuid" }) categoryId!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) localityId!: string | null;
  @ApiProperty({ type: ShortTextDto }) name!: ShortTextDto;
  @ApiProperty({ type: LongTextDto, nullable: true }) description!: LongTextDto | null;
  @ApiProperty({ type: ShortTextDto, nullable: true }) address!: ShortTextDto | null;
  @ApiProperty({ type: LonLatDto, nullable: true }) location!: LonLatDto | null;
  @ApiProperty({ type: String, nullable: true, example: "+380000000001" }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "https://place.example" }) website!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "place_demo" }) telegram!: string | null;
  @ApiProperty({ type: Boolean, description: "«Ми рекомендуємо» (D-32)" }) recommended!: boolean;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "Дата перевірки інформації",
  })
  verifiedAt!: string | null;
  @ApiProperty({ type: [String], description: "id тегов" }) tagIds!: string[];
  @ApiProperty({
    type: [String],
    description:
      "id дополнительных категорий (0020): место видно и в этих разделах; ставит импорт Google или админка (manual)",
  })
  extraCategoryIds!: string[];
  @ApiProperty({
    type: Boolean,
    description:
      "Отель/садиба: категория проживания или привязан QR отеля — в админке показывать «Модуль готелю» (блок 5)",
  })
  hostCapable!: boolean;
  @ApiProperty({
    type: String,
    format: "uuid",
    nullable: true,
    description:
      "Организация партнёра (блок 6); null — место админки. Модерация — GET /admin/moderation/cases?placeId=",
  })
  organizationId!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export const toPlaceDto = (
  p: PlaceDetails | (Omit<PlaceDetails, "tagIds"> & { tagIds?: string[] }),
  hostCapable = false,
) => ({
  id: p.id,
  status: p.status,
  categoryId: p.category_id,
  localityId: p.locality_id,
  name: p.name_i18n,
  description: p.description_i18n,
  address: p.address_i18n,
  location: p.location,
  phone: p.phone,
  website: p.website,
  telegram: p.telegram,
  recommended: p.recommended,
  verifiedAt: p.verified_at?.toISOString() ?? null,
  tagIds: p.tagIds ?? [],
  extraCategoryIds: ("extraCategoryIds" in p ? p.extraCategoryIds : undefined) ?? [],
  hostCapable,
  organizationId: p.organization_id ?? null,
  createdAt: p.created_at.toISOString(),
  updatedAt: p.updated_at.toISOString(),
});

/** Задана хотя бы одна граница рамки — тогда обязательны все четыре. */
const hasBbox = (o: { minLat?: unknown; maxLat?: unknown; minLng?: unknown; maxLng?: unknown }): boolean =>
  [o.minLat, o.maxLat, o.minLng, o.maxLng].some((v) => v !== undefined);

/** Граница рамки из query: пустая строка — не 0, а ошибка isNumber (Number("") === 0 прошёл бы проверку). */
const toBound = ({ value }: { value: unknown }): unknown =>
  value === undefined
    ? undefined
    : typeof value === "string" && value.trim() === ""
      ? Number.NaN
      : Number(value);

export class PlaceListQueryDto extends CursorQueryDto {
  @ApiPropertyOptional({ enum: PLACE_STATUSES, enumName: "PlaceStatus" })
  @IsOptional()
  @IsIn(PLACE_STATUSES)
  status?: PlaceStatus;

  @ApiPropertyOptional({ type: String, format: "uuid", description: "Категория или её подкатегории" })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ type: String, maxLength: 100, description: "Поиск по названию (uk, en)" })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  // Рамка карты (выбор места на карте в админке): все четыре границы или ни одной; места без точки не попадают.
  @ApiPropertyOptional({
    type: Number,
    minimum: -90,
    maximum: 90,
    description:
      "Рамка карты: южная граница (широта). minLat, maxLat, minLng, maxLng — все четыре или ни одного",
  })
  @ValidateIf(hasBbox)
  @IsDefined()
  @Transform(toBound)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  minLat?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: -90,
    maximum: 90,
    description: "Рамка карты: северная граница (широта), не меньше minLat",
  })
  @ValidateIf(hasBbox)
  @IsDefined()
  @Transform(toBound)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  maxLat?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: -180,
    maximum: 180,
    description: "Рамка карты: западная граница (долгота)",
  })
  @ValidateIf(hasBbox)
  @IsDefined()
  @Transform(toBound)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  minLng?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: -180,
    maximum: 180,
    description: "Рамка карты: восточная граница (долгота), не меньше minLng",
  })
  @ValidateIf(hasBbox)
  @IsDefined()
  @Transform(toBound)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  maxLng?: number;
}

export class UpdatePlaceDto {
  @ApiPropertyOptional({ type: String, format: "uuid" })
  @Present()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  @IsOptional()
  @IsUUID()
  localityId?: string | null;

  @ApiPropertyOptional({ type: ShortTextDto })
  @Present()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name?: ShortTextDto;

  @ApiPropertyOptional({ type: LongTextDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LongTextDto)
  description?: LongTextDto | null;

  @ApiPropertyOptional({ type: ShortTextDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShortTextDto)
  address?: ShortTextDto | null;

  @ApiPropertyOptional({ type: LonLatDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LonLatDto)
  location?: LonLatDto | null;

  @ApiPropertyOptional({ type: String, nullable: true, pattern: PHONE_RE.source, description: "E.164" })
  @IsOptional()
  @Matches(PHONE_RE)
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300, description: "Только https://" })
  @IsOptional()
  @IsString()
  @Matches(/^https:\/\/[^\s]+$/)
  @MaxLength(300)
  website?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: TELEGRAM_RE.source,
    description: "Имя без @",
  })
  @IsOptional()
  @Matches(TELEGRAM_RE)
  telegram?: string | null;

  @ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  verifiedAt?: string | null;

  @ApiPropertyOptional({ type: [String], description: "Полный набор тегов (заменяет текущий)" })
  @Present()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("all", { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: 5,
    description:
      "Дополнительные категории: активные разделы и подкатегории, не основная, до 5. Заменяет список целиком (строки становятся ручными — импорт их не трогает)",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUUID("all", { each: true })
  extraCategoryIds?: string[];
}

export class CreatePlaceDto extends OmitType(UpdatePlaceDto, ["categoryId", "name"] as const) {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ type: ShortTextDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ShortTextDto)
  name!: ShortTextDto;
}

export const placeInput = (b: UpdatePlaceDto) => ({
  categoryId: b.categoryId,
  localityId: b.localityId,
  name: toText(b.name) ?? undefined,
  description: toText(b.description),
  address: toText(b.address),
  location: b.location === undefined ? undefined : b.location && { lon: b.location.lon, lat: b.location.lat },
  phone: b.phone,
  website: b.website,
  telegram: b.telegram,
  verifiedAt: b.verifiedAt,
  tagIds: b.tagIds?.map((id) => id.toLowerCase()),
  extraCategoryIds: b.extraCategoryIds?.map((id) => id.toLowerCase()),
});

export class TransitionDto {
  @ApiPropertyOptional({ type: String, maxLength: 1000, description: "Причина (в аудит)" })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class PublishCheckDto {
  @ApiProperty({
    enum: PUBLISH_PROBLEMS,
    enumName: "PublishProblem",
    isArray: true,
    description: "Пусто — можно публиковать",
  })
  problems!: PublishProblem[];
}

// --- schedule ---

export class WeeklyIntervalDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 7, description: "1 — понедельник … 7 — воскресенье" })
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @ApiProperty(TIME_DOC)
  @Matches(TIME_RE)
  opensAt!: string;

  @ApiProperty({ ...TIME_DOC, description: "Не позже opensAt — закрывается после полуночи" })
  @Matches(TIME_RE)
  closesAt!: string;
}

export class ScheduleExceptionDto {
  @ApiProperty({ type: String, format: "date", example: "2026-12-31" })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  date!: string;

  @ApiProperty({ type: Boolean, description: "Закрыто весь день" })
  @IsBoolean()
  closed!: boolean;

  @ApiPropertyOptional({ ...TIME_DOC, nullable: true })
  @IsOptional()
  @Matches(TIME_RE)
  opensAt?: string | null;

  @ApiPropertyOptional({ ...TIME_DOC, nullable: true })
  @IsOptional()
  @Matches(TIME_RE)
  closesAt?: string | null;

  @ApiPropertyOptional({ type: ShortTextDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShortTextDto)
  note?: ShortTextDto | null;
}

export class PutScheduleDto {
  @ApiProperty({ type: [WeeklyIntervalDto] })
  @IsArray()
  @ArrayMaxSize(70)
  @ValidateNested({ each: true })
  @Type(() => WeeklyIntervalDto)
  weekly!: WeeklyIntervalDto[];

  @ApiProperty({ type: [ScheduleExceptionDto] })
  @IsArray()
  @ArrayMaxSize(400)
  @ValidateNested({ each: true })
  @Type(() => ScheduleExceptionDto)
  exceptions!: ScheduleExceptionDto[];
}

export class ScheduleExceptionViewDto {
  @ApiProperty({ type: String, format: "date" }) date!: string;
  @ApiProperty({ type: Boolean }) closed!: boolean;
  @ApiProperty({ ...TIME_DOC, nullable: true }) opensAt!: string | null;
  @ApiProperty({ ...TIME_DOC, nullable: true }) closesAt!: string | null;
  @ApiProperty({ type: ShortTextDto, nullable: true }) note!: ShortTextDto | null;
}

export class ScheduleDto {
  @ApiProperty({ type: String, example: "Europe/Kyiv", description: "Таймзона региона" }) timezone!: string;
  @ApiProperty({ type: [WeeklyIntervalDto], description: "Пусто — график неизвестен" })
  weekly!: WeeklyIntervalDto[];
  @ApiProperty({ type: [ScheduleExceptionViewDto] }) exceptions!: ScheduleExceptionViewDto[];
}

export const toScheduleDto = (s: PlaceSchedule): ScheduleDto => ({
  timezone: s.timezone,
  weekly: s.weekly,
  exceptions: s.exceptions.map((e) => ({
    date: e.date,
    closed: e.closed,
    opensAt: e.opensAt ?? null,
    closesAt: e.closesAt ?? null,
    note: e.note,
  })),
});

export const scheduleInput = (b: PutScheduleDto) => ({
  weekly: b.weekly.map((w) => ({ dayOfWeek: w.dayOfWeek, opensAt: w.opensAt, closesAt: w.closesAt })),
  exceptions: b.exceptions.map((e) => ({
    date: e.date,
    closed: e.closed,
    opensAt: e.opensAt ?? null,
    closesAt: e.closesAt ?? null,
    note: toText(e.note) ?? null,
  })),
});

// --- media ---

export class PlaceMediaDto {
  @ApiProperty({ type: String, format: "uuid", description: "Файл (GET /media/{id} — ссылки на варианты)" })
  mediaAssetId!: string;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
  @ApiProperty({ type: Boolean }) isCover!: boolean;
  @ApiProperty({ type: ShortTextDto, nullable: true, description: "Alt text; без него место не публикуется" })
  alt!: ShortTextDto | null;
  @ApiProperty({ type: String, example: "ready", description: "Статус обработки файла (media_assets)" })
  status!: string;
  @ApiProperty({ type: String, example: "image/jpeg" }) mime!: string;
}

export const toPlaceMediaDto = (m: PlaceMediaRecord): PlaceMediaDto => ({
  mediaAssetId: m.media_asset_id,
  sortOrder: m.sort_order,
  isCover: m.is_cover,
  alt: m.alt_i18n,
  status: m.status,
  mime: m.mime,
});

export class PlaceMediaListDto {
  @ApiProperty({ type: [PlaceMediaDto] }) items!: PlaceMediaDto[];
}

export class UpdatePlaceMediaDto {
  @ApiPropertyOptional({ type: ShortTextDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ShortTextDto)
  alt?: ShortTextDto | null;

  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 1000 })
  @Present()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @ApiPropertyOptional({ type: Boolean, description: "Сделать обложкой (прежняя снимается)" })
  @Present()
  @IsBoolean()
  isCover?: boolean;
}

export class AttachPlaceMediaDto extends UpdatePlaceMediaDto {
  @ApiProperty({
    type: String,
    format: "uuid",
    description: "Файл из POST /media/uploads (ownerType place, ownerId — это место)",
  })
  @IsUUID()
  mediaAssetId!: string;
}

export const placeMediaInput = (b: UpdatePlaceMediaDto) => ({
  alt: toText(b.alt),
  sortOrder: b.sortOrder,
  isCover: b.isCover,
});

// --- badge ---

export class BadgeReasonDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1000, description: "Причина выдачи/снятия (D-32)" })
  @IsString()
  @Matches(/\S/)
  @MaxLength(1000)
  reason!: string;
}

export class BadgeEventDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ enum: BADGE_ACTIONS, enumName: "BadgeAction" }) action!: BadgeAction;
  @ApiProperty({ type: String }) reason!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) actorUserId!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export const toBadgeEventDto = (e: PlaceBadgeEvent): BadgeEventDto => ({
  id: e.id,
  action: e.action,
  reason: e.reason,
  actorUserId: e.actor_user_id,
  createdAt: e.created_at.toISOString(),
});

export class BadgeHistoryDto {
  @ApiProperty({ type: [BadgeEventDto] }) items!: BadgeEventDto[];
}
