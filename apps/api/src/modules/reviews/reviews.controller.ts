import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { RequireAuth } from "../auth/index.js";
import { RequireFeature, type FeatureRegionResolver } from "../feature-flags/index.js";
import { RateLimit } from "../rate-limit/index.js";
import type { RbacRequest } from "../rbac/index.js";
import {
  AdminReviewDto,
  AdminReviewListDto,
  AppealDto,
  ComplaintDto,
  MyReviewDto,
  PartnerReviewDto,
  PartnerReviewListDto,
  PlaceRatingListDto,
  PlaceReviewsDto,
  ReviewEligibilityListDto,
} from "./reviews.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AdminReviewsQueryDto,
  AppealDecisionDto,
  CreateAppealDto,
  CreateComplaintDto,
  PartnerReviewsQueryDto,
  PlaceRatingsQueryDto,
  PlaceReviewsQueryDto,
  PutReviewResponseDto,
  ReviewDecisionDto,
  ReviewRegionQueryDto,
  SubmitReviewDto,
} from "./reviews.dto.js";
import { ReviewsService } from "./reviews.service.js";

// Блок 10: подтверждённые отзывы. Турист и публичные эндпоинты — регион из запроса (regionId), флаг module.reviews
// региона — guard (выключен — 404). Партнёр (/partner/reviews) и модератор (/admin/reviews) — флаг в сервисе по
// региону назначений / отзыва.

/** Отзывов (и новых версий) за час на пользователя. */
export const REVIEW_RATE_LIMIT = { limit: 20, windowSec: 3600 } as const;
/** Жалоб и апелляций за час на пользователя. */
export const COMPLAINT_RATE_LIMIT = { limit: 20, windowSec: 3600 } as const;

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

/** Регион флага: query/body regionId. */
const requestRegion: FeatureRegionResolver = ({ request }) => {
  const q = request.query?.regionId;
  if (typeof q === "string") return q;
  const b = request.body as { regionId?: unknown } | undefined;
  return typeof b?.regionId === "string" ? b.regionId : undefined;
};

type AuthedRequest = RbacRequest & AuditableRequest;

function userOf(req: RbacRequest): string {
  const userId = req.principal?.userId;
  if (!userId) throw new ApiError("UNAUTHENTICATED");
  return userId;
}

@ApiTags("reviews")
@Controller("reviews")
@WithoutTenantContext()
@RequireFeature("module.reviews", { region: requestRegion })
export class ReviewsController {
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({
    operationId: "listPlaceReviews",
    summary: "Отзывы места (C06/C13): только опубликованные проверенные, новые сверху, и рейтинг места",
    description:
      "Без аутентификации. rating.fewReviews — меньше minReviews отзывов: показывать «Мало відгуків» вместо цифры " +
      "(score = null). Рейтинг Google в карточке — отдельное поле, здесь не участвует. 404 — места нет в регионе или " +
      "оно не опубликовано.",
  })
  @ApiOkResponse({ type: PlaceReviewsDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  list(@Query() q: PlaceReviewsQueryDto): Promise<PlaceReviewsDto> {
    return this.reviews.placeReviews(q.regionId, q.placeId);
  }

  @Get("ratings")
  @ApiOperation({
    operationId: "listPlaceRatings",
    summary: "Рейтинги мест по отзывам (для списков и карточек): до 50 мест за запрос",
    description: "Без аутентификации. Неопубликованные и чужие места пропускаются.",
  })
  @ApiOkResponse({ type: PlaceRatingListDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "RATE_LIMITED")
  ratings(@Query() q: PlaceRatingsQueryDto): Promise<PlaceRatingListDto> {
    return this.reviews.placeRatings(q.regionId, q.placeIds);
  }

  @Get("eligibility")
  @RequireAuth()
  @ApiOperation({
    operationId: "listMyReviewEligibility",
    summary: "Права на отзыв пользователя (после завершённой брони) с его отзывом, статусом и сроком",
    description:
      "active — можно написать отзыв до expiresAt; consumed — отзыв написан (review), повторный POST /reviews с тем " +
      "же eligibilityId — новая версия; expired; revoked — бронь отменена после завершения.",
  })
  @ApiOkResponse({ type: ReviewEligibilityListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  eligibility(@Query() q: ReviewRegionQueryDto, @Req() req: RbacRequest): Promise<ReviewEligibilityListDto> {
    return this.reviews.myEligibility(q.regionId, userOf(req));
  }

  @Post()
  @RequireAuth()
  @RateLimit(REVIEW_RATE_LIMIT)
  @ApiOperation({
    operationId: "submitReview",
    summary: "Отзыв по праву (оценка 1–5 + текст) или новая версия своего отзыва",
    description:
      "Без своего права на отзыв (нет eligibility, чужое) — 403 errors.review.notEligible (ТЗ §16.2); окно прошло — " +
      "422 errors.review.eligibilityExpired; бронь отменена — 422 errors.review.eligibilityRevoked. Один отзыв на " +
      "право: повтор — новая версия (история у модератора, показывается последняя). Ссылки, телефоны, e-mail, мат — " +
      "status pending_moderation (autoFlags), иначе published сразу. Правка скрытого/отклонённого — снова к " +
      "модератору. Бонуса за отзыв нет (D-35).",
  })
  @ApiCreatedResponse({ type: MyReviewDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "UNPROCESSABLE",
    "RATE_LIMITED",
  )
  submit(@Body() body: SubmitReviewDto, @Req() req: AuthedRequest): Promise<MyReviewDto> {
    return this.reviews.submit(userOf(req), body, auditFromRequest(req));
  }

  @Post(":id/complaints")
  @RequireAuth()
  @RateLimit(COMPLAINT_RATE_LIMIT)
  @ApiOperation({
    operationId: "createReviewComplaint",
    summary: "Жалоба на опубликованный отзыв: партнёр места (review.complain) или пользователь",
    description:
      "Отзыв остаётся опубликованным до решения модератора. Автор на свой отзыв — 403 own_review; отзыв не " +
      "опубликован — 409 errors.review.notPublished; уже есть открытая жалоба этого пользователя — 409 " +
      "errors.review.complaintExists.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiCreatedResponse({ type: ComplaintDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "RATE_LIMITED")
  complain(
    @Param("id", uuid) id: string,
    @Body() body: CreateComplaintDto,
    @Req() req: AuthedRequest,
  ): Promise<ComplaintDto> {
    return this.reviews.complain(userOf(req), id, body, auditFromRequest(req));
  }
}

@ApiTags("reviews")
@Controller("appeals")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.reviews", { region: requestRegion })
export class AppealsController {
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  @Post()
  @RateLimit(COMPLAINT_RATE_LIMIT)
  @ApiOperation({
    operationId: "createReviewAppeal",
    summary:
      "Апелляция: автора — на скрытый/отклонённый отзыв, владельца заведения — на «оставить» по его жалобе",
    description:
      "Одна апелляция на отзыв (409 errors.review.appealExists); решения модератора, к которому апеллировать, нет или " +
      "статус не тот — 422 errors.review.appealNotAllowed. Решает другой модератор (POST " +
      "/admin/reviews/{id}/appeal-decision). 404 — отзыв не найден или пользователь не автор и не владелец.",
  })
  @ApiCreatedResponse({ type: AppealDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "CONFLICT", "UNPROCESSABLE", "RATE_LIMITED")
  create(@Body() body: CreateAppealDto, @Req() req: AuthedRequest): Promise<AppealDto> {
    return this.reviews.appeal(userOf(req), body, auditFromRequest(req));
  }
}

@ApiTags("partner-reviews")
@Controller("partner/reviews")
@RequireAuth()
@WithoutTenantContext()
// Флаг module.reviews — в сервисе по регионам назначений партнёра: выключен во всех — 404.
export class PartnerReviewsController {
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({
    operationId: "listPartnerReviews",
    summary: "Отзывы о заведениях партнёра (P07): опубликованные и скрытые, с ответом и своими жалобами",
    description:
      "Право review.respond (ORG_OWNER, ORG_MANAGER) на место или организацию; скрыть отзыв партнёр не может — только " +
      "ответить и пожаловаться (POST /reviews/{id}/complaints). 403 not_partner — нет мест с правом. 404 — модуль " +
      "выключен во всех регионах назначений.",
  })
  @ApiOkResponse({ type: PartnerReviewListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "RATE_LIMITED")
  list(@Query() q: PartnerReviewsQueryDto, @Req() req: RbacRequest): Promise<PartnerReviewListDto> {
    return this.reviews.partnerList(userOf(req), q.placeId);
  }

  @Put(":id/response")
  @ApiOperation({
    operationId: "putPartnerReviewResponse",
    summary: "Ответ заведения на отзыв: создать или изменить (один на отзыв, публикуется сразу)",
    description:
      "Ссылки, телефоны, e-mail, мат — 422 errors.review.responseRejected (details.flags). Отзыв не опубликован — 409 " +
      "errors.review.notPublished. 403 — роль без review.respond; 404 — отзыв не своего заведения. AuditLog.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerReviewDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "UNPROCESSABLE",
    "RATE_LIMITED",
  )
  respond(
    @Param("id", uuid) id: string,
    @Body() body: PutReviewResponseDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerReviewDto> {
    return this.reviews.putResponse(userOf(req), id, body.text, auditFromRequest(req));
  }
}

const ADMIN_ERRORS = ["VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT"] as const;

@ApiTags("admin")
@Controller("admin/reviews")
@RequireAuth()
@WithoutTenantContext()
// Право review.moderate / appeal.decide — по назначениям MODERATOR/REGION_ADMIN на регион отзыва (SUPERADMIN —
// везде); флаг module.reviews — по региону отзыва.
export class AdminReviewsController {
  constructor(@Inject(ReviewsService) private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({
    operationId: "listAdminReviews",
    summary: "Очередь модерации отзывов (AD06): автофильтр, открытые жалобы и апелляции (старые сверху)",
    description:
      "status=queue (по умолчанию) — ждут решения (waitingSince); all или статус — журнал. История версий, жалобы, " +
      "апелляция и ответ — в элементе. 403 — нет права review.moderate ни в одном регионе (или в regionId).",
  })
  @ApiOkResponse({ type: AdminReviewListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN")
  list(@Query() q: AdminReviewsQueryDto, @Req() req: RbacRequest): Promise<AdminReviewListDto> {
    return this.reviews.adminList(userOf(req), q);
  }

  @Post(":id/decision")
  @HttpCode(200)
  @ApiOperation({
    operationId: "decideAdminReview",
    summary:
      "Решение модератора: publish — оставить/одобрить/вернуть, hide — скрыть/отклонить (причина обязательна)",
    description:
      "Открытые жалобы закрываются (publish — dismissed, hide — upheld). Решение — AuditLog (review.moderate), " +
      "пересчёт рейтинга. 403 own_organization — у модератора роль в организации места (BR-12); 409 " +
      "errors.review.appealPending — открыта апелляция (решается отдельно), errors.review.nothingToDecide, " +
      "errors.review.invalidDecision (details.currentStatus).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: AdminReviewDto })
  @ApiErrors(...ADMIN_ERRORS)
  decide(
    @Param("id", uuid) id: string,
    @Body() body: ReviewDecisionDto,
    @Req() req: AuthedRequest,
  ): Promise<AdminReviewDto> {
    return this.reviews.decide(userOf(req), id, body, auditFromRequest(req));
  }

  @Post(":id/appeal-decision")
  @HttpCode(200)
  @ApiOperation({
    operationId: "decideReviewAppeal",
    summary: "Решение по апелляции отзыва: grant — отменить решение, deny — оставить (финально)",
    description:
      "Решает модератор, не принимавший обжалуемое решение (D-08): иначе 403 same_moderator " +
      "(errors.review.appealSameModerator). grant: апелляция автора → published, партнёра → hidden. 404 — апелляции " +
      "нет; 409 errors.review.appealDecided. AuditLog (appeal.decide).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: AdminReviewDto })
  @ApiErrors(...ADMIN_ERRORS)
  decideAppeal(
    @Param("id", uuid) id: string,
    @Body() body: AppealDecisionDto,
    @Req() req: AuthedRequest,
  ): Promise<AdminReviewDto> {
    return this.reviews.decideAppeal(userOf(req), id, body, auditFromRequest(req));
  }
}
