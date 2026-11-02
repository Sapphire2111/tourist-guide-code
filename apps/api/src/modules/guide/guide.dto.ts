import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { LocalizedTextDto } from "../../common/http/index.js";
import {
  HOME_SECTIONS,
  PROMOTION_AD_LABELS,
  TAG_GROUPS,
  type HomeSection,
  type LocalizedText,
  type PromotionAdLabel,
  type TagGroup,
} from "../../db/index.js";
import { LonLatDto, ScheduleDto } from "../catalog/index.js";
import { MediaLinkDto } from "../media/index.js";

// DTO публичного каталога туриста (блок 4, ADR-0019): категории, поиск и «Що поруч», картка місця, избранное.
// Регион — query `regionId` (из QR-контекста или выбора туриста, как GET /feature-flags): данные публичные, сервис
// читает их в контексте этого региона (RLS). Туристу видны только опубликованные места активного региона.

/** «Що поруч» по умолчанию — 500 м (ТЗ §4.2 «300–500 м», D-06). */
export const SEARCH_RADIUS_DEFAULT = 500;
/** Верхняя граница радиуса: дальше «рядом» теряет смысл, а выдача — индекс. */
export const SEARCH_RADIUS_MAX = 20_000;
export const SEARCH_RADIUS_MIN = 10;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
/** Глубина листания поиска (offset): дальше — уточнить запрос. */
export const SEARCH_OFFSET_MAX = 1000;
export const SEARCH_QUERY_MAX = 100;

const toBool = ({ value }: { value: unknown }) =>
  value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : value;

/** Регион выдачи: uuid активного региона (иначе 404). */
export class RegionQueryDto {
  @ApiProperty({
    type: String,
    format: "uuid",
    description: "Регион туриста: regionId из GET /context/{start_param} (или выбранный туристом)",
  })
  @IsUUID()
  regionId!: string;
}

/** Точка туриста для расстояния: lat и lng только вместе. */
export class OriginQueryDto extends RegionQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: -90, maximum: 90, example: 48.4475, description: "Широта" })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiPropertyOptional({
    type: Number,
    minimum: -180,
    maximum: 180,
    example: 24.5626,
    description: "Долгота (вместе с lat)",
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng?: number;
}

export class SearchPlacesQueryDto extends OriginQueryDto {
  @ApiPropertyOptional({
    type: "integer",
    minimum: SEARCH_RADIUS_MIN,
    maximum: SEARCH_RADIUS_MAX,
    default: SEARCH_RADIUS_DEFAULT,
    description: "Радиус, м — только с lat/lng («Що поруч»)",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(SEARCH_RADIUS_MIN)
  @Max(SEARCH_RADIUS_MAX)
  radius?: number;

  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Категория (из GET /categories); раздел включает свои подкатегории",
  })
  @IsOptional()
  @IsUUID()
  category?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: 2,
    maxLength: SEARCH_QUERY_MAX,
    description: "Текст: название (uk, en) или адрес; без координат — поиск по всему региону",
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(SEARCH_QUERY_MAX)
  q?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description: "«Доступно зараз» — до блока 7 игнорируется (фильтр выключен, ответ без изменений)",
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  available_now?: boolean;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    maximum: SEARCH_LIMIT_MAX,
    default: SEARCH_LIMIT_DEFAULT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SEARCH_LIMIT_MAX)
  limit?: number;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 0,
    maximum: SEARCH_OFFSET_MAX,
    default: 0,
    description: "Сдвиг страницы: nextOffset из прошлого ответа",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(SEARCH_OFFSET_MAX)
  offset?: number;
}

export class AddFavoriteDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  regionId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  placeId!: string;
}

// --- ответы ---

export class GuideCategoryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true, description: "Раздел; null — корневой" })
  parentId!: string | null;
  @ApiProperty({ type: String, example: "where-to-eat" }) code!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedText;
  @ApiProperty({ type: String, nullable: true, example: "utensils", description: "Имя иконки packages/ui" })
  icon!: string | null;
  @ApiProperty({
    enum: HOME_SECTIONS,
    enumName: "HomeSection",
    nullable: true,
    description: "Кнопка главной C02 (только у корневых)",
  })
  homeSection!: HomeSection | null;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
  @ApiProperty({
    type: "integer",
    description: "Опубликованных мест (у раздела — вместе с подкатегориями)",
  })
  placeCount!: number;
}

export class GuideCategoryListDto {
  @ApiProperty({
    type: [GuideCategoryDto],
    description:
      "Активные категории региона, плоско (parentId), по sortOrder; подкатегории выключенного раздела не входят",
  })
  items!: GuideCategoryDto[];
}

/** Фото места: готовые варианты (w320, w800, w1600) и alt text. */
export class PlacePhotoDto {
  @ApiProperty({ type: String, format: "uuid" }) mediaAssetId!: string;
  @ApiProperty({
    type: LocalizedTextDto,
    nullable: true,
    description: "Alt text (у опубликованного места есть)",
  })
  alt!: LocalizedText | null;
  @ApiProperty({ type: "integer", nullable: true }) width!: number | null;
  @ApiProperty({ type: "integer", nullable: true }) height!: number | null;
  @ApiProperty({ type: Boolean }) isCover!: boolean;
  @ApiProperty({ type: [MediaLinkDto], description: "Варианты по ширине; выбирать по размеру экрана" })
  variants!: MediaLinkDto[];
}

/** Место в выдаче (список, карта, избранное). */
export class PlaceSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) categoryId!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedText;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) address!: LocalizedText | null;
  @ApiProperty({ type: LonLatDto, description: "Точка на карте и для маршрута" }) location!: LonLatDto;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Расстояние от lat/lng запроса, м (PostGIS, сфероид WGS 84); null — точка не передана",
  })
  distanceMeters!: number | null;
  @ApiProperty({
    type: Boolean,
    description: "«Ми рекомендуємо» — только редакционный бейдж (D-32), реклама его не даёт",
  })
  recommended!: boolean;
  @ApiProperty({
    enum: PROMOTION_AD_LABELS,
    enumName: "AdLabel",
    nullable: true,
    description: "Метка платного размещения «Реклама» / «Партнер» (ТЗ §4.3); показывать всегда, если не null",
  })
  adLabel!: PromotionAdLabel | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: "«Відкрито зараз» по графику в таймзоне региона; null — график неизвестен",
  })
  openNow!: boolean | null;
  @ApiProperty({ type: String, nullable: true, example: "+380501234567" }) phone!: string | null;
  @ApiProperty({ type: PlacePhotoDto, nullable: true, description: "Обложка (или первое готовое фото)" })
  cover!: PlacePhotoDto | null;
}

export class PlaceSearchResultDto {
  @ApiProperty({
    type: [PlaceSummaryDto],
    description:
      "Порядок (BR-10, C-02): совпадение с q → расстояние → «Ми рекомендуємо» → название; реклама порядок не меняет",
  })
  items!: PlaceSummaryDto[];
  @ApiProperty({ type: "integer", nullable: true, description: "offset следующей страницы; null — конец" })
  nextOffset!: number | null;
  @ApiProperty({ type: "integer", nullable: true, description: "Применённый радиус, м; null — без точки" })
  radiusMeters!: number | null;
}

export class GuideCategoryRefDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) parentId!: string | null;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedText;
  @ApiProperty({ type: String, nullable: true }) icon!: string | null;
}

export class GuideTagDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedText;
  @ApiProperty({ enum: TAG_GROUPS, enumName: "TagGroup" }) group!: TagGroup;
}

/** Картка місця (C05). */
export class PlaceCardDto extends PlaceSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: GuideCategoryRefDto }) category!: GuideCategoryRefDto;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) description!: LocalizedText | null;
  @ApiProperty({ type: String, nullable: true, example: "https://example.com" }) website!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Имя в Telegram без @" }) telegram!:
    | string
    | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "«Дата перевірки інформації» (ТЗ §4.4)",
  })
  verifiedAt!: string | null;
  @ApiProperty({ type: [PlacePhotoDto], description: "Готовые фото по порядку (обложка первой)" })
  photos!: PlacePhotoDto[];
  @ApiProperty({ type: [GuideTagDto], description: "Активные теги места" }) tags!: GuideTagDto[];
  @ApiProperty({
    type: ScheduleDto,
    description: "Недельный график и исключения с вчерашней даты (местное время региона)",
  })
  schedule!: ScheduleDto;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "22:00",
    description: "До скольки открыто (HH:MM местного времени), если openNow = true",
  })
  openUntil!: string | null;
  @ApiProperty({ type: Boolean, nullable: true, description: "В избранном; null — без сессии" })
  favorite!: boolean | null;
}

export class FavoriteDto {
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class FavoriteListDto {
  @ApiProperty({
    type: [PlaceSummaryDto],
    description:
      "Избранные опубликованные места региона, новые сверху (до 200); снятые с публикации не входят",
  })
  items!: PlaceSummaryDto[];
}
