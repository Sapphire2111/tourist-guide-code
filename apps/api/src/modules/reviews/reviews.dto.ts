import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
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
} from "class-validator";
import { LocalizedTextDto } from "../../common/http/index.js";
import {
  APPEAL_KINDS,
  APPEAL_STATUSES,
  COMPLAINT_KINDS,
  COMPLAINT_REASONS,
  COMPLAINT_STATUSES,
  REVIEW_AUTO_FLAGS,
  REVIEW_ELIGIBILITY_STATUSES,
  REVIEW_STATUSES,
  REVIEW_VERIFICATION_LEVELS,
  type AppealKind,
  type AppealStatus,
  type ComplaintKind,
  type ComplaintReason,
  type ComplaintStatus,
  type ReviewAutoFlag,
  type ReviewEligibilityStatus,
  type ReviewStatus,
  type ReviewVerificationLevel,
} from "../../db/index.js";
import { RATING_PARAMS, REVIEW_PARAMS } from "./review-rules.js";

// DTO блока 10 (подтверждённые отзывы): турист и публичные эндпоинты — регион из запроса (regionId, как каталог
// гида); партнёр — права из назначений ORG_* на сервере; модератор — назначения MODERATOR/REGION_ADMIN на регион.

/** Фильтр очереди модерации: queue — требует решения (автофильтр, открытая жалоба или апелляция). */
export const ADMIN_REVIEW_FILTERS = ["queue", "all", ...REVIEW_STATUSES] as const;
export type AdminReviewFilter = (typeof ADMIN_REVIEW_FILTERS)[number];
export const REVIEW_DECISIONS = ["publish", "hide"] as const;
export const APPEAL_DECISIONS = ["grant", "deny"] as const;
/** Список uuid через запятую (до 50). */
const UUID_LIST_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,49}$/i;

// --- запросы ---

export class ReviewRegionQueryDto {
  @ApiProperty({ type: String, format: "uuid", description: "Регион туриста: regionId из GET /context" })
  @IsUUID()
  regionId!: string;
}

export class PlaceReviewsQueryDto extends ReviewRegionQueryDto {
  @ApiProperty({ type: String, format: "uuid", description: "Опубликованное место" })
  @IsUUID()
  placeId!: string;
}

export class PlaceRatingsQueryDto extends ReviewRegionQueryDto {
  @ApiProperty({ type: String, description: "id мест через запятую (до 50)", example: "0190…,0190…" })
  @IsString()
  @Matches(UUID_LIST_RE)
  placeIds!: string;
}

export class SubmitReviewDto extends ReviewRegionQueryDto {
  @ApiProperty({ type: String, format: "uuid", description: "Право на отзыв из GET /reviews/eligibility" })
  @IsUUID()
  eligibilityId!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiProperty({ type: String, minLength: REVIEW_PARAMS.textMin, maxLength: REVIEW_PARAMS.textMax })
  @IsString()
  @MinLength(REVIEW_PARAMS.textMin)
  @MaxLength(REVIEW_PARAMS.textMax)
  text!: string;
}

export class CreateComplaintDto extends ReviewRegionQueryDto {
  @ApiProperty({ enum: COMPLAINT_REASONS, enumName: "ComplaintReason" })
  @IsIn(COMPLAINT_REASONS)
  reasonCode!: ComplaintReason;

  @ApiPropertyOptional({ type: String, maxLength: REVIEW_PARAMS.complaintTextMax })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REVIEW_PARAMS.complaintTextMax)
  text?: string;
}

export class CreateAppealDto extends ReviewRegionQueryDto {
  @ApiProperty({ type: String, format: "uuid" })
  @IsUUID()
  reviewId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: REVIEW_PARAMS.appealTextMax })
  @IsString()
  @MinLength(1)
  @MaxLength(REVIEW_PARAMS.appealTextMax)
  text!: string;
}

export class PutReviewResponseDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: REVIEW_PARAMS.responseMax })
  @IsString()
  @MinLength(1)
  @MaxLength(REVIEW_PARAMS.responseMax)
  text!: string;
}

export class PartnerReviewsQueryDto {
  @ApiPropertyOptional({ type: String, format: "uuid", description: "Только это место партнёра" })
  @IsOptional()
  @IsUUID()
  placeId?: string;
}

export class AdminReviewsQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: "uuid",
    description: "Регион (по умолчанию — все регионы модератора)",
  })
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional({ enum: ADMIN_REVIEW_FILTERS, enumName: "AdminReviewFilter", default: "queue" })
  @IsOptional()
  @IsIn(ADMIN_REVIEW_FILTERS)
  status?: AdminReviewFilter;
}

export class ReviewDecisionDto {
  @ApiProperty({
    enum: REVIEW_DECISIONS,
    enumName: "ReviewDecision",
    description:
      "publish — оставить / одобрить / вернуть (→ published); hide — скрыть (published → hidden, " +
      "pending_moderation → rejected)",
  })
  @IsIn(REVIEW_DECISIONS)
  decision!: (typeof REVIEW_DECISIONS)[number];

  @ApiPropertyOptional({
    type: String,
    maxLength: REVIEW_PARAMS.decisionReasonMax,
    description: "Причина — обязательна для hide (видна автору)",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REVIEW_PARAMS.decisionReasonMax)
  reason?: string;
}

export class AppealDecisionDto {
  @ApiProperty({ enum: APPEAL_DECISIONS, enumName: "AppealDecision" })
  @IsIn(APPEAL_DECISIONS)
  decision!: (typeof APPEAL_DECISIONS)[number];

  @ApiPropertyOptional({ type: String, maxLength: REVIEW_PARAMS.decisionReasonMax })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(REVIEW_PARAMS.decisionReasonMax)
  reason?: string;
}

// --- ответы ---

export class PlaceRatingDto {
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: "integer", description: "Опубликованных проверенных отзывов" }) reviewCount!: number;
  @ApiProperty({
    type: Boolean,
    description: `Меньше ${RATING_PARAMS.minReviews} отзывов — «Мало відгуків» вместо цифры (score = null)`,
  })
  fewReviews!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Рейтинг 1–5 (D-37 В: сглаживание к среднему категории и вес давности), до десятых",
  })
  score!: number | null;
  @ApiProperty({ type: "integer" }) minReviews!: number;
  @ApiProperty({ type: "integer", description: "Версия формулы рейтинга" }) formulaVersion!: number;
  @ApiProperty({ type: String, format: "date-time" }) computedAt!: string;
}

export class PlaceRatingListDto {
  @ApiProperty({ type: [PlaceRatingDto] }) items!: PlaceRatingDto[];
}

export class ReviewResponseDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String }) text!: string;
  @ApiProperty({ type: "integer" }) version!: number;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
}

export class PublicReviewDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: "integer", minimum: 1, maximum: 5 }) rating!: number;
  @ApiProperty({ type: String, description: "Текст последней версии" }) text!: string;
  @ApiProperty({ type: "integer", description: "Номер версии (правка — новая версия)" }) version!: number;
  @ApiProperty({ enum: REVIEW_VERIFICATION_LEVELS, enumName: "ReviewVerificationLevel" })
  verificationLevel!: ReviewVerificationLevel;
  @ApiProperty({ type: String, nullable: true, description: "Имя автора (первое слово профиля)" })
  authorName!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) publishedAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: ReviewResponseDto, nullable: true, description: "Ответ заведения" })
  response!: ReviewResponseDto | null;
}

export class PlaceReviewsDto {
  @ApiProperty({ type: PlaceRatingDto }) rating!: PlaceRatingDto;
  @ApiProperty({ type: [PublicReviewDto] }) items!: PublicReviewDto[];
}

export class ReviewRevisionDto {
  @ApiProperty({ type: "integer" }) version!: number;
  @ApiProperty({ type: "integer" }) rating!: number;
  @ApiProperty({ type: String }) text!: string;
  @ApiProperty({ enum: REVIEW_AUTO_FLAGS, enumName: "ReviewAutoFlag", isArray: true })
  autoFlags!: ReviewAutoFlag[];
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class ComplaintDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) reviewId!: string;
  @ApiProperty({ enum: COMPLAINT_KINDS, enumName: "ComplaintKind" }) kind!: ComplaintKind;
  @ApiProperty({ enum: COMPLAINT_REASONS, enumName: "ComplaintReason" }) reasonCode!: ComplaintReason;
  @ApiProperty({ type: String, nullable: true }) text!: string | null;
  @ApiProperty({ enum: COMPLAINT_STATUSES, enumName: "ComplaintStatus" }) status!: ComplaintStatus;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) decidedAt!: string | null;
}

export class AppealDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) reviewId!: string;
  @ApiProperty({ enum: APPEAL_KINDS, enumName: "AppealKind" }) kind!: AppealKind;
  @ApiProperty({ type: String }) text!: string;
  @ApiProperty({ enum: APPEAL_STATUSES, enumName: "AppealStatus" }) status!: AppealStatus;
  @ApiProperty({ type: String, nullable: true }) decisionNote!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) decidedAt!: string | null;
}

export class MyReviewDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({
    enum: REVIEW_STATUSES,
    enumName: "ReviewStatus",
    description:
      "published — виден; pending_moderation — сработал автофильтр, ждёт модератора; hidden — скрыт модератором; " +
      "rejected — отклонён модератором",
  })
  status!: ReviewStatus;
  @ApiProperty({ type: "integer" }) rating!: number;
  @ApiProperty({ type: String }) text!: string;
  @ApiProperty({ type: "integer" }) version!: number;
  @ApiProperty({ enum: REVIEW_AUTO_FLAGS, enumName: "ReviewAutoFlag", isArray: true })
  autoFlags!: ReviewAutoFlag[];
  @ApiProperty({ type: String, nullable: true, description: "Причина скрытия/отклонения" })
  hiddenReason!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) publishedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: ReviewResponseDto, nullable: true }) response!: ReviewResponseDto | null;
  @ApiProperty({ type: AppealDto, nullable: true }) appeal!: AppealDto | null;
  @ApiProperty({
    type: Boolean,
    description: "Можно подать апелляцию (hidden/rejected, апелляций ещё не было)",
  })
  canAppeal!: boolean;
}

export class ReviewEligibilityDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: LocalizedTextDto }) placeName!: LocalizedTextDto;
  @ApiProperty({ type: String, format: "uuid" }) bookingId!: string;
  @ApiProperty({ enum: REVIEW_VERIFICATION_LEVELS, enumName: "ReviewVerificationLevel" })
  level!: ReviewVerificationLevel;
  @ApiProperty({
    enum: REVIEW_ELIGIBILITY_STATUSES,
    enumName: "ReviewEligibilityStatus",
    description:
      "active — можно написать отзыв; consumed — отзыв написан (повторный POST /reviews — новая версия); expired — " +
      `окно ${REVIEW_PARAMS.eligibilityWindowDays} дн. после брони прошло; revoked — бронь отменена/возвращена`,
  })
  status!: ReviewEligibilityStatus;
  @ApiProperty({ type: String, format: "date-time" }) issuedAt!: string;
  @ApiProperty({ type: String, format: "date-time", description: "До какого момента можно написать отзыв" })
  expiresAt!: string;
  @ApiProperty({ type: MyReviewDto, nullable: true }) review!: MyReviewDto | null;
}

export class ReviewEligibilityListDto {
  @ApiProperty({ type: [ReviewEligibilityDto] }) items!: ReviewEligibilityDto[];
}

export class PartnerReviewDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: LocalizedTextDto }) placeName!: LocalizedTextDto;
  @ApiProperty({ enum: REVIEW_STATUSES, enumName: "ReviewStatus" }) status!: ReviewStatus;
  @ApiProperty({ type: "integer" }) rating!: number;
  @ApiProperty({ type: String }) text!: string;
  @ApiProperty({ type: "integer" }) version!: number;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) publishedAt!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: ReviewResponseDto, nullable: true }) response!: ReviewResponseDto | null;
  @ApiProperty({ type: [ComplaintDto], description: "Жалобы этого партнёра на отзыв" })
  myComplaints!: ComplaintDto[];
  @ApiProperty({ type: AppealDto, nullable: true }) appeal!: AppealDto | null;
  @ApiProperty({ type: Boolean, description: "Можно ответить (право review.respond)" }) canRespond!: boolean;
  @ApiProperty({
    type: Boolean,
    description: "Можно подать апелляцию: модератор оставил отзыв по жалобе партнёра (право review.appeal)",
  })
  canAppeal!: boolean;
}

export class PartnerReviewListDto {
  @ApiProperty({ type: [PartnerReviewDto] }) items!: PartnerReviewDto[];
}

export class AdminReviewDto {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) regionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) placeId!: string;
  @ApiProperty({ type: LocalizedTextDto }) placeName!: LocalizedTextDto;
  @ApiProperty({ type: String, format: "uuid", nullable: true }) organizationId!: string | null;
  @ApiProperty({ type: String, format: "uuid" }) authorUserId!: string;
  @ApiProperty({ type: String, nullable: true }) authorName!: string | null;
  @ApiProperty({ enum: REVIEW_STATUSES, enumName: "ReviewStatus" }) status!: ReviewStatus;
  @ApiProperty({ type: "integer" }) rating!: number;
  @ApiProperty({ type: String }) text!: string;
  @ApiProperty({ type: "integer" }) version!: number;
  @ApiProperty({ enum: REVIEW_AUTO_FLAGS, enumName: "ReviewAutoFlag", isArray: true })
  autoFlags!: ReviewAutoFlag[];
  @ApiProperty({ type: String, nullable: true }) hiddenReason!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) publishedAt!: string | null;
  @ApiProperty({ type: String, format: "uuid", nullable: true, description: "Модератор последнего решения" })
  lastDecisionBy!: string | null;
  @ApiProperty({ type: String, format: "date-time", nullable: true }) lastDecisionAt!: string | null;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({ type: [ReviewRevisionDto], description: "История версий (старые сверху)" })
  revisions!: ReviewRevisionDto[];
  @ApiProperty({ type: [ComplaintDto] }) complaints!: ComplaintDto[];
  @ApiProperty({ type: AppealDto, nullable: true }) appeal!: AppealDto | null;
  @ApiProperty({ type: ReviewResponseDto, nullable: true }) response!: ReviewResponseDto | null;
  @ApiProperty({
    type: Boolean,
    description: "У модератора роль в организации места (BR-12) — решать нельзя",
  })
  ownOrganization!: boolean;
  @ApiProperty({
    type: Boolean,
    description: "Открытую апелляцию может решить этот модератор (не он принимал обжалуемое решение)",
  })
  canDecideAppeal!: boolean;
  @ApiProperty({ type: String, format: "date-time", description: "С какого момента элемент ждёт решения" })
  waitingSince!: string;
}

export class AdminReviewListDto {
  @ApiProperty({ type: [AdminReviewDto] }) items!: AdminReviewDto[];
}
