import { ApiProperty, ApiPropertyOptional, OmitType } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { LocalizedTextDto } from "../../common/http/index.js";
import {
  HOME_SECTIONS,
  PLACE_AMENITIES,
  PLACE_TAG_SOURCES,
  PROMOTION_AD_LABELS,
  TAG_GROUPS,
  type HomeSection,
  type PlaceAmenity,
  type PlaceTagSource,
  type LocalizedText,
  type PromotionAdLabel,
  type TagGroup,
} from "../../db/index.js";
import { LonLatDto, ScheduleDto } from "../catalog/index.js";
import { MediaLinkDto } from "../media/index.js";
import {
  PEAK_DIFFICULTIES,
  PEAK_RANGES,
  type PeakDifficulty,
  type PeakRange,
} from "../../places-import/peaks.js";
import { GOOGLE_PHOTO_WIDTHS, type GooglePhotoWidth } from "./google-photos.js";

// DTO публичного каталога туриста (блок 4, ADR-0019): категории, поиск и «Що поруч», картка місця, избранное.
// Регион — query `regionId` (из QR-контекста или выбора туриста, как GET /feature-flags): данные публичные, сервис
// читает их в контексте этого региона (RLS). Туристу видны только опубликованные места активного региона.

/** «Що поруч» по умолчанию — 500 м (ТЗ §4.2 «300–500 м», D-06). */
export const SEARCH_RADIUS_DEFAULT = 500;
/** Верхняя граница радиуса: дальше «рядом» теряет смысл, а выдача — индекс. */
export const SEARCH_RADIUS_MAX = 20_000;
export const SEARCH_RADIUS_MIN = 10;
export const SEARCH_LIMIT_DEFAULT = 20;
/** Предел страницы: карта «Що поруч» на радиусе 10–20 км берёт до 300 мест одним запросом (иначе — только ближайшие). */
export const SEARCH_LIMIT_MAX = 300;
/** Глубина листания поиска (offset): дальше — уточнить запрос. */
export const SEARCH_OFFSET_MAX = 1000;
export const SEARCH_QUERY_MAX = 100;
/** Локаций в фильтре поиска — не больше (в регионе их единицы). */
export const SEARCH_LOCALITIES_MAX = 10;
/** Тегов в фильтре (удобства «Де жити») — не больше. */
export const SEARCH_TAGS_MAX = 10;
/** Код тега — формат is_catalog_code (0012). */
const TAG_CODE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;

/** Повтор параметра (?localityIds=a&localityIds=b) и/или список через запятую — массив без пустых. */
const toList = ({ value }: { value: unknown }) =>
  value === undefined
    ? undefined
    : (Array.isArray(value) ? value : [value]).flatMap((v) =>
        typeof v === "string"
          ? v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
          : [v],
      );

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
    description:
      "Радиус, м — только с lat/lng («Що поруч»); с localityIds по умолчанию радиуса нет (точка — для расстояния)",
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
    enum: HOME_SECTIONS,
    enumName: "HomeSection",
    isArray: true,
    description:
      "Исключить места разделов главной (корень категории с этим homeSection), напр. stay — «Що поруч» и карты " +
      "без мест проживания. По умолчанию ничего не исключается (текстовый поиск, ассистент находят и отели).",
  })
  @IsOptional()
  // «a,b» и повтор параметра; пустое значение (exclude_section=) — как отсутствие, не 400.
  @Transform(({ value }: { value: unknown }) => {
    const list = (Array.isArray(value) ? value : [value])
      .flatMap((v) => (typeof v === "string" ? v.split(",") : [v]))
      .filter((v) => v !== "");
    return list.length ? list : undefined;
  })
  @IsArray()
  @ArrayMaxSize(HOME_SECTIONS.length)
  @IsIn(HOME_SECTIONS, { each: true })
  exclude_section?: HomeSection[];

  @ApiPropertyOptional({
    type: [String],
    format: "uuid",
    maxItems: SEARCH_LOCALITIES_MAX,
    description:
      "Населённые пункты (id из GET /localities): только места с этим locality_id; пусто — весь регион. " +
      "Повтор параметра или через запятую",
  })
  @IsOptional()
  @Transform(toList)
  @ArrayMaxSize(SEARCH_LOCALITIES_MAX)
  @IsUUID("all", { each: true })
  localityIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: SEARCH_TAGS_MAX,
    example: ["pool", "sauna"],
    description:
      "Коды тегов (фильтр удобств «Де жити»: pool, sauna, hot-tub, breakfast, parking, pets, kids, wifi, kitchen): " +
      "только места со ВСЕМИ указанными активными тегами (И). Повтор параметра или через запятую",
  })
  @IsOptional()
  @Transform(toList)
  @ArrayMaxSize(SEARCH_TAGS_MAX)
  @Matches(TAG_CODE, { each: true })
  tags?: string[];

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

/**
 * Число мест по тегам (фильтр удобств «Де жити»): те же фильтры, что у поиска (точка и радиус, категория, пункты,
 * текст) — счётчики совпадают со списком; без тегов, страницы и available_now.
 */
export class PlaceTagCountsQueryDto extends OmitType(SearchPlacesQueryDto, [
  "tags",
  "limit",
  "offset",
  "available_now",
] as const) {}

/** Фото Google места: ширина файла (превью 400 или полноэкранный 1200). */
export class GooglePhotoQueryDto extends RegionQueryDto {
  @ApiPropertyOptional({ enum: GOOGLE_PHOTO_WIDTHS, default: 400, description: "Ширина, px" })
  @IsOptional()
  @Type(() => Number)
  @IsIn([...GOOGLE_PHOTO_WIDTHS])
  w?: GooglePhotoWidth;

  @ApiPropertyOptional({
    type: String,
    description: "Отпечаток фото из googlePhotos карточки (кэш браузера); сервером не проверяется",
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  v?: string;
}

/** Обложка: v — версия из coverPhoto.url (кэш браузера), сервером не проверяется. */
export class CoverQueryDto extends RegionQueryDto {
  @ApiPropertyOptional({ type: String }) @IsOptional() @IsString() @MaxLength(32) v?: string;
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

/** Населённый пункт региона для фильтра «Локація» и голосового ассистента. */
export class GuideLocalityDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, example: "polianytsia" }) code!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedText;
  @ApiProperty({
    type: [String],
    example: ["Буковель", "Bukovel"],
    description: "Другие названия (курорт, латиница, формы) — для распознавания в тексте запроса",
  })
  aliases!: string[];
  @ApiProperty({ type: LonLatDto, nullable: true }) location!: LonLatDto | null;
  @ApiProperty({ type: "integer" }) sortOrder!: number;
  @ApiProperty({ type: "integer", description: "Опубликованных мест в пункте" }) placeCount!: number;
}

export class GuideLocalityListDto {
  @ApiProperty({ type: [GuideLocalityDto], description: "Активные населённые пункты региона по sortOrder" })
  items!: GuideLocalityDto[];
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

/** Автор фото Google — показывать обязательно (правила Google Maps Platform). */
export class CoverAuthorDto {
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, nullable: true }) uri!: string | null;
  @ApiProperty({ type: String, nullable: true }) photoUri!: string | null;
}

/** Обложка у нас (0018): WebP ~400 px из Google или Wikimedia; подпись автора обязательна. */
export class CoverPhotoDto {
  @ApiProperty({ type: String, description: "GET /places/{id}/cover (ETag, длинный кэш)" }) url!: string;
  @ApiProperty({ type: "integer" }) width!: number;
  @ApiProperty({ type: "integer" }) height!: number;
  @ApiProperty({ enum: ["google", "wikimedia"], enumName: "CoverSource" }) source!: "google" | "wikimedia";
  @ApiProperty({ type: [CoverAuthorDto] }) authors!: CoverAuthorDto[];
  @ApiProperty({ type: String, nullable: true, description: "Лицензия (Wikimedia)" }) license!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Страница файла (Wikimedia)" }) sourceUrl!:
    | string
    | null;
}

export class PeakSourceDto {
  @ApiProperty({ type: String, example: "Вікіпедія (uk): Говерла" }) title!: string;
  @ApiProperty({ type: String, description: "Ссылка на версию статьи / страницу источника" }) url!: string;
}

export class PeakPointDto {
  @ApiProperty({ type: Number }) lat!: number;
  @ApiProperty({ type: Number }) lng!: number;
}

/** Маршрут на вершину туда-назад — только из источников; чего нет — null. */
export class PeakRouteDto {
  @ApiProperty({ type: LocalizedTextDto, description: "Старт (село, база)" }) start!: LocalizedText;
  @ApiProperty({ type: PeakPointDto, nullable: true, description: "Точка старта; null — неизвестна" })
  startLocation!: PeakPointDto | null;
  @ApiProperty({ type: Number, nullable: true, description: "Туда-назад, км" }) roundTripKm!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: "Набор высоты, м" }) elevationGainM!:
    | number
    | null;
  @ApiProperty({
    enum: ["difference", "stated"],
    enumName: "PeakGainKind",
    nullable: true,
    description: "difference — разница высот вершины и старта; stated — перепад из источника",
  })
  gainKind!: "difference" | "stated" | null;
  @ApiProperty({ type: Number, nullable: true, description: "Подъём, ч" }) upHours!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: "Спуск, ч" }) downHours!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: "Туда-назад, ч (подъём + спуск)" })
  totalHours!: number | null;
  @ApiProperty({ type: LocalizedTextDto, nullable: true, description: "Маркировка/путь" })
  trail!: LocalizedText | null;
}

/** Данные вершины (раздел «Вершини»): высота, хребет, маршрут, сложность, источники. */
export class PeakDto {
  @ApiProperty({ type: String, example: "hoverla" }) slug!: string;
  @ApiProperty({ type: Number, nullable: true, description: "Высота, м" }) heightM!: number | null;
  @ApiProperty({ enum: PEAK_RANGES, enumName: "PeakRange", nullable: true }) range!: PeakRange | null;
  @ApiProperty({
    enum: PEAK_DIFFICULTIES,
    enumName: "PeakDifficulty",
    nullable: true,
    description: "Сложность по правилу PEAK_DIFFICULTY_RULE; null — нет данных маршрута",
  })
  difficulty!: PeakDifficulty | null;
  @ApiProperty({ type: PeakRouteDto, nullable: true }) route!: PeakRouteDto | null;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) note!: LocalizedText | null;
  @ApiProperty({ type: [LocalizedTextDto], description: "Сезонность и предупреждения" })
  warnings!: LocalizedText[];
  @ApiProperty({ type: [PeakSourceDto] }) sources!: PeakSourceDto[];
  @ApiProperty({
    type: PeakPointDto,
    nullable: true,
    description:
      "Горная точка прогноза погоды рядом с вершиной (GET /weather); null — у вершины прогноза нет",
  })
  weatherPoint!: PeakPointDto | null;
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
  @ApiProperty({
    type: CoverPhotoDto,
    nullable: true,
    description: "Обложка из Google/Wikimedia, хранимая у нас — если нет своей cover",
  })
  coverPhoto!: CoverPhotoDto | null;
  @ApiProperty({
    type: PeakDto,
    nullable: true,
    description: "Вершина (подкатегория peaks): высота, маршрут, сложность; null — не вершина",
  })
  peak!: PeakDto | null;
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
  @ApiProperty({
    enum: PLACE_TAG_SOURCES,
    enumName: "PlaceTagSource",
    description:
      "manual — админка; import — структурированные данные Google; reviews — по отзывам/описанию Google (places:amenities), " +
      "в карточке — с пометкой «за відгуками Google»",
  })
  source!: PlaceTagSource;
}

export class PlaceTagCountDto {
  @ApiProperty({ type: String, example: "pool" }) code!: string;
  @ApiProperty({ type: LocalizedTextDto }) name!: LocalizedText;
  @ApiProperty({ type: "integer", description: "Опубликованных мест с тегом" }) count!: number;
}

export class PlaceTagCountListDto {
  @ApiProperty({
    type: [PlaceTagCountDto],
    description: "Активные теги, у которых есть места; порядок — группа, sortOrder",
  })
  items!: PlaceTagCountDto[];
}

// --- богатая картка (0018): данные Google Place Details, Вікіпедія, ИИ-текст ---

/** Автор фото или отзыва Google — показывать обязательно (правила Google Maps Platform). */
export class GoogleAuthorDto {
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: "Профиль автора в Google Maps" }) uri!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true, description: "Аватар (googleusercontent.com)" }) photoUri!:
    | string
    | null;
}

export class GooglePhotoDto {
  @ApiProperty({ type: String, description: "Превью 400 px: редирект api на файл Google (без ключа)" })
  url!: string;
  @ApiProperty({ type: String, description: "То же фото 1200 px — полноэкранный просмотр" })
  largeUrl!: string;
  @ApiProperty({ type: "integer", nullable: true }) width!: number | null;
  @ApiProperty({ type: "integer", nullable: true }) height!: number | null;
  @ApiProperty({ type: [GoogleAuthorDto], description: "Авторы фото — подпись под фото" })
  authors!: GoogleAuthorDto[];
}

export class GoogleReviewDto {
  @ApiProperty({ type: GoogleAuthorDto }) author!: GoogleAuthorDto;
  @ApiProperty({ type: "integer", nullable: true, minimum: 1, maximum: 5 }) rating!: number | null;
  @ApiProperty({ type: String }) text!: string;
  @ApiProperty({ type: String, nullable: true }) language!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) publishTime!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "2 місяці тому" }) relativeTime!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Отзыв в Google Maps" }) uri!: string | null;
}

export class PlaceRatingDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 5, example: 4.8 }) value!: number;
  @ApiProperty({ type: "integer", description: "Число оценок" }) count!: number;
  @ApiProperty({ enum: ["google"], enumName: "RatingSource" }) source!: "google";
}

export class AiSummaryDto {
  @ApiProperty({
    type: String,
    description: "2–3 предложения «що це і чим цікаво» — показывать с пометкой ШІ",
  })
  text!: string;
  @ApiProperty({ type: String, example: "claude-sonnet-5-5" }) model!: string;
  @ApiProperty({ type: String, format: "date-time" }) generatedAt!: string;
}

export class WikipediaImageDto {
  @ApiProperty({ type: String, description: "Файл Wikimedia Commons (upload.wikimedia.org)" }) url!: string;
  @ApiProperty({ type: "integer", nullable: true }) width!: number | null;
  @ApiProperty({ type: "integer", nullable: true }) height!: number | null;
  @ApiProperty({ type: String, nullable: true }) author!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "CC BY-SA 4.0" }) license!: string | null;
  @ApiProperty({ type: String, nullable: true }) licenseUrl!: string | null;
  @ApiProperty({ type: String, description: "Страница файла на Commons" }) sourceUrl!: string;
}

/** Ссылка на статью: текст статьи (CC BY-SA) не отдаётся, описание места — пересказ ИИ (aiSummary). */
export class WikipediaDto {
  @ApiProperty({ type: String, example: "uk" }) lang!: string;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String, description: "Статья" }) url!: string;
  @ApiProperty({ type: WikipediaImageDto, nullable: true }) image!: WikipediaImageDto | null;
}

/** Картка місця (C05). */
export class PlaceCardDto extends PlaceSummaryDto {
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: GuideCategoryRefDto }) category!: GuideCategoryRefDto;
  @ApiProperty({ type: LocalizedTextDto, nullable: true }) description!: LocalizedText | null;
  @ApiProperty({
    type: Boolean,
    description:
      "description — автоописание импорта Google («… Джерело: Google Maps.»): при тексте ШІ/Google/Вікіпедії его можно скрыть; ручное описание — false",
  })
  descriptionAuto!: boolean;
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
  @ApiProperty({
    type: Boolean,
    description: "У места нет организации-партнёра: можно подать заявку «Це мій заклад» (0031)",
  })
  claimable!: boolean;
  @ApiProperty({ type: String, nullable: true, example: "Піцерія", description: "Тип места по Google (uk)" })
  typeLabel!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "Описание Google (editorialSummary)" })
  summary!: string | null;
  @ApiProperty({ type: AiSummaryDto, nullable: true, description: "Текст ИИ из фактов Google и Вікіпедії" })
  aiSummary!: AiSummaryDto | null;
  @ApiProperty({
    type: "integer",
    nullable: true,
    minimum: 0,
    maximum: 4,
    description: "Ценовой уровень Google: 0 — бесплатно, 1–4 — от недорого до очень дорого",
  })
  priceLevel!: number | null;
  @ApiProperty({
    enum: PLACE_AMENITIES,
    enumName: "PlaceAmenity",
    isArray: true,
    description: "«Що пропонує» — только подтверждённые Google",
  })
  amenities!: PlaceAmenity[];
  @ApiProperty({ type: PlaceRatingDto, nullable: true, description: "Рейтинг Google" })
  rating!: PlaceRatingDto | null;
  @ApiProperty({ type: [GoogleReviewDto], description: "До 5 отзывов Google" }) reviews!: GoogleReviewDto[];
  @ApiProperty({ type: [GooglePhotoDto], description: "До 5 фото Google (через прокси api)" })
  googlePhotos!: GooglePhotoDto[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Место в Google Maps (атрибуция, «усі відгуки»)",
  })
  googleMapsUri!: string | null;
  @ApiProperty({ type: WikipediaDto, nullable: true, description: "Вікіпедія для пам'яток" })
  wikipedia!: WikipediaDto | null;
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
