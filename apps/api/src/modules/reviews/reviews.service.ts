import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ANALYTICS_SCHEMA_VERSION, type AnalyticsEvent } from "@tg/shared";
import { uuidv7 } from "@tg/media";
import { ApiError } from "../../common/http/index.js";
import {
  currentDb,
  currentTenant,
  InjectDb,
  PLATFORM_CONTEXT,
  regionContext,
  withTenant,
  type Db,
  type JsonObject,
  type PlaceReviewRating,
  type Region,
  type Review,
  type ReviewAppeal,
  type ReviewComplaint,
  type ReviewResponse,
  type ReviewStatus,
} from "../../db/index.js";
import { AnalyticsService } from "../analytics/index.js";
import { AuditService, type AuditEntry } from "../audit/index.js";
import { FeatureFlagsService } from "../feature-flags/index.js";
import {
  findGrant,
  isGrantActive,
  PLATFORM_SCOPE,
  RbacService,
  regionScope,
  roleHasPermission,
  scope,
  type Grant,
  type PermissionCode,
  type ScopeChain,
} from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import {
  appealAllowed,
  appealGrantedStatus,
  autoFlags,
  awaitsModerator,
  categoryPrior,
  complaintOutcome,
  computeRating,
  decisionTarget,
  editAllowed,
  effectiveEligibilityStatus,
  eligibilityExpiresAt,
  ratingStale,
  RATING_PARAMS,
  REVIEW_PARAMS,
  statusAfterSubmit,
} from "./review-rules.js";
import type {
  AdminReviewDto,
  AdminReviewFilter,
  AdminReviewListDto,
  AppealDecisionDto,
  AppealDto,
  ComplaintDto,
  CreateAppealDto,
  CreateComplaintDto,
  MyReviewDto,
  PartnerReviewDto,
  PartnerReviewListDto,
  PlaceRatingDto,
  PlaceRatingListDto,
  PlaceReviewsDto,
  PublicReviewDto,
  ReviewDecisionDto,
  ReviewEligibilityListDto,
  ReviewResponseDto,
  SubmitReviewDto,
} from "./reviews.dto.js";
import { ReviewsRepository, type PlaceRef } from "./reviews.repository.js";

export type ReviewAuditMeta = Pick<AuditEntry, "actor" | "roleAssignmentId" | "requestId" | "pii">;

export const REVIEW_ENTITY = "review";
export const REVIEW_AUDIT = {
  submit: "review.submit",
  respond: "review.respond",
  complain: "review.complain",
  appeal: "review.appeal",
  moderate: "review.moderate",
  appealDecide: "appeal.decide",
} as const;
/** Флаг модуля: эндпоинты без regionId (партнёр, модератор) проверяют его по региону отзыва/назначений. */
const REVIEWS_FLAG = "module.reviews";

/** Место партнёра: организация и регион — из БД. */
type PartnerPlace = { placeId: string; organizationId: string; regionId: string };
/** Где пользователь модерирует отзывы: вся платформа (SUPERADMIN) или набор регионов (MODERATOR, REGION_ADMIN). */
type ModerationScope = { platform: boolean; regions: Set<string>; grants: Grant[] };

const notFound = () => new ApiError("NOT_FOUND");
const forbidden = (reason: string, messageKey?: string) =>
  new ApiError("FORBIDDEN", { messageKey, details: { reason } });
const conflict = (messageKey: string, reason: string, extra: JsonObject = {}) =>
  new ApiError("CONFLICT", { messageKey, details: { reason, ...extra } });
const unprocessable = (messageKey: string, reason: string, extra: JsonObject = {}) =>
  new ApiError("UNPROCESSABLE", { messageKey, details: { reason, ...extra } });

/**
 * Подтверждённые отзывы (блок 10; ТЗ §9, §16.2; states-and-rules §6). Право на отзыв — только eligibility из
 * завершённой брони (триггер БД 0028): без активного права своего пользователя — 403, истёкшее/отозванное — 422.
 * Публикация сразу с автофильтром (ссылки, телефоны, e-mail, мат → очередь модерации), постмодерация по жалобе (D-08).
 * Партнёр отвечает и жалуется, скрыть не может; модератор решает «оставить / скрыть / вернуть» (AuditLog);
 * апелляцию решает другой модератор. Рейтинг — кэш place_review_ratings (D-37 В, версия формулы).
 */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger("Reviews");

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(ReviewsRepository) private readonly repo: ReviewsRepository,
    @Inject(RegionsRepository) private readonly regions: RegionsRepository,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FeatureFlagsService) private readonly flags: Pick<FeatureFlagsService, "isEnabled">,
    @Optional() @Inject(AnalyticsService) private readonly analytics?: AnalyticsService,
  ) {}

  /** Часы сервиса (подменяется в тестах). */
  now: () => Date = () => new Date();

  // --- турист ---

  /** Права на отзыв пользователя в регионе (новые сверху) с его отзывом; истёкшие окна помечаются expired. */
  async myEligibility(regionId: string, userId: string): Promise<ReviewEligibilityListDto> {
    return this.inRegion(regionId, async () => {
      const now = this.now();
      const rows = await this.repo.eligibilitiesOfUser(userId);
      const stale = rows.filter(
        (e) => e.status === "active" && effectiveEligibilityStatus(e, now) === "expired",
      );
      await this.repo.expireEligibilities(stale.map((e) => e.id));
      const reviews = await this.repo.reviewsByEligibilities(rows.map((e) => e.id));
      const mine = await this.myDtos([...reviews.values()]);
      const names = await this.repo.placeNames(rows.map((e) => e.place_id));
      return {
        items: rows.map((e) => {
          const review = reviews.get(e.id);
          return {
            id: e.id,
            placeId: e.place_id,
            placeName: names.get(e.place_id) ?? { uk: "" },
            bookingId: e.booking_id,
            level: e.level,
            status: effectiveEligibilityStatus(e, now),
            issuedAt: e.issued_at.toISOString(),
            expiresAt: eligibilityExpiresAt(e.source_ended_at).toISOString(),
            review: review ? (mine.get(review.id) ?? null) : null,
          };
        }),
      };
    });
  }

  /**
   * Отзыв по праву (states-and-rules §6.2 «— → submitted»): eligibility своего пользователя, active — новый отзыв
   * (eligibility → consumed), consumed — новая версия того же отзыва (история хранится, показывается последняя).
   * Автофильтр сработал — pending_moderation, иначе published. Правка скрытого/отклонённого — снова к модератору.
   * Автор с ролью в организации места (BR-12) — 403. Правка — в окне editWindowDays после первой отправки; повтор
   * без изменений (та же оценка и текст) версию не создаёт.
   *
   * Упрощение облегчённой версии: правка опубликованного отзыва, на которой сработал автофильтр, снимает с публикации
   * весь отзыв (status pending_moderation до решения модератора), а не оставляет видимой прежнюю версию, как в
   * states-and-rules §6.2 (PlaceRevision-подобная схема — позже).
   */
  async submit(userId: string, input: SubmitReviewDto, meta: ReviewAuditMeta): Promise<MyReviewDto> {
    const text = input.text.trim();
    if (!text)
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          fields: [{ field: "text", constraint: "minLength", messageKey: "errors.validation.minLength" }],
        },
      });
    const grants = await this.activeGrants(userId);
    const result = await this.inRegion(input.regionId, async () => {
      const now = this.now();
      const e = await this.repo.findEligibility(input.eligibilityId.toLowerCase(), true);
      if (e?.user_id !== userId) throw forbidden("not_eligible", "errors.review.notEligible");
      // BR-12: сотрудник/владелец организации места отзыв о своём заведении не пишет.
      if (relatedTo(grants, e, now)) throw forbidden("own_organization", "errors.review.ownOrganization");
      const status = effectiveEligibilityStatus(e, now);
      if (status === "expired")
        throw unprocessable("errors.review.eligibilityExpired", "eligibility_expired");
      if (status === "revoked")
        throw unprocessable("errors.review.eligibilityRevoked", "eligibility_revoked");
      const flags = autoFlags(text);
      let review: Review;
      let previous: ReviewStatus | null = null;
      if (status === "active") {
        if (!(await this.repo.consumeEligibility(e.id, now)))
          throw conflict("errors.review.eligibilityChanged", "eligibility_changed");
        const target = statusAfterSubmit(flags);
        review = await this.repo.insertReview({
          place_id: e.place_id,
          organization_id: e.organization_id,
          author_user_id: userId,
          eligibility_id: e.id,
          rating: input.rating,
          text,
          auto_flags: flags,
          status: target,
          published_at: target === "published" ? now : null,
        });
      } else {
        const row = await this.repo.reviewByEligibility(e.id, true);
        if (!row) throw conflict("errors.review.eligibilityChanged", "eligibility_changed");
        // Повтор без изменений — без новой версии, аудита и события.
        if (row.rating === input.rating && row.text === text)
          return { dto: (await this.myDtos([row])).get(row.id)!, review: row, changed: false };
        if (!editAllowed(row.created_at, now))
          throw unprocessable("errors.review.editWindowClosed", "edit_window_closed");
        previous = row.status;
        // Скрытый или отклонённый модератором отзыв правкой не возвращается в публикацию — только через модератора
        // (и повторной правкой тоже: awaitsModerator по hidden_reason).
        const target = awaitsModerator(row) ? "pending_moderation" : statusAfterSubmit(flags);
        const updated = await this.repo.updateReview(row.id, {
          rating: input.rating,
          text,
          current_version: row.current_version + 1,
          auto_flags: flags,
          status: target,
          published_at: target === "published" ? (row.published_at ?? now) : row.published_at,
        });
        if (!updated) throw notFound();
        review = updated;
      }
      await this.repo.insertRevision({
        review_id: review.id,
        version_no: review.current_version,
        rating: review.rating,
        text: review.text,
        auto_flags: flags,
      });
      await this.audit.record(currentDb(this.db), {
        ...meta,
        action: REVIEW_AUDIT.submit,
        entityType: REVIEW_ENTITY,
        entityId: review.id,
        oldValues: previous ? { status: previous } : null,
        newValues: {
          status: review.status,
          version: review.current_version,
          rating: review.rating,
          autoFlags: flags,
        },
        regionId: review.region_id,
      });
      if (previous === "published" || review.status === "published")
        await this.refreshRating(review.place_id);
      return { dto: (await this.myDtos([review])).get(review.id)!, review, changed: true };
    });
    if (result.changed)
      await this.emit("review_submitted", result.review, userId, { reviewId: result.review.id });
    return result.dto;
  }

  // --- публичное ---

  /** Опубликованные отзывы места и рейтинг (только проверенные, published). */
  async placeReviews(regionId: string, placeId: string): Promise<PlaceReviewsDto> {
    return this.inRegion(regionId, async () => {
      const place = await this.repo.findPlace(placeId.toLowerCase());
      if (place?.status !== "published") throw notFound();
      const rows = await this.repo.publishedOfPlace(place.id, REVIEW_PARAMS.publicListMax);
      const [responses, users] = await Promise.all([
        this.repo.responses(rows.map((r) => r.id)),
        this.repo.users(rows.map((r) => r.author_user_id)),
      ]);
      const rating = await this.publicRatingOf(place);
      return {
        rating,
        items: rows.map(
          (r): PublicReviewDto => ({
            id: r.id,
            placeId: r.place_id,
            rating: r.rating,
            text: r.text,
            version: r.current_version,
            verificationLevel: r.verification_level,
            authorName: firstName(users.get(r.author_user_id)?.display_name),
            publishedAt: (r.published_at ?? r.created_at).toISOString(),
            updatedAt: r.updated_at.toISOString(),
            response: publicResponse(responses.get(r.id)),
          }),
        ),
      };
    });
  }

  /** Рейтинги мест (для списков и карточек): только опубликованные места региона. */
  async placeRatings(regionId: string, placeIds: string): Promise<PlaceRatingListDto> {
    const ids = [...new Set(placeIds.toLowerCase().split(","))];
    return this.inRegion(regionId, async () => {
      // Пачка — два запроса (места и кэш), без пересчёта и записи на публичном GET: кэш обновляется при изменениях
      // отзывов места; устаревший по давности кэш отдаётся как есть (computedAt в ответе).
      const [published, cached] = await Promise.all([
        this.repo.publishedPlaceIds(ids),
        this.repo.ratings(ids),
      ]);
      const now = this.now();
      return {
        items: ids
          .filter((id) => published.has(id))
          .map((id) => {
            const row = cached.get(id);
            return row ? toRatingDto(row) : emptyRating(id, now);
          }),
      };
    });
  }

  // --- жалоба и апелляция ---

  /**
   * Жалоба на опубликованный отзыв (states-and-rules §6.4): партнёр места (право review.complain) или любой
   * пользователь, кроме автора. Отзыв остаётся опубликованным до решения модератора (постмодерация).
   */
  async complain(
    userId: string,
    reviewId: string,
    input: CreateComplaintDto,
    meta: ReviewAuditMeta,
  ): Promise<ComplaintDto> {
    const grants = await this.activeGrants(userId);
    return this.inRegion(input.regionId, async () => {
      const review = await this.repo.findReview(reviewId.toLowerCase());
      if (!review) throw notFound();
      if (review.author_user_id === userId) throw forbidden("own_review");
      if (review.status !== "published")
        throw conflict("errors.review.notPublished", "not_published", { currentStatus: review.status });
      const grant = findGrant(grants, "review.complain", reviewChain(review), this.now());
      const row = await this.repo
        .insertComplaint({
          review_id: review.id,
          complainant_user_id: userId,
          complainant_kind: grant ? "partner" : "user",
          reason_code: input.reasonCode,
          text: input.text?.trim() || null,
        })
        .catch(
          rethrowUnique("review_complaints_open_key", "errors.review.complaintExists", "complaint_exists"),
        );
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant?.id ?? null,
        action: REVIEW_AUDIT.complain,
        entityType: REVIEW_ENTITY,
        entityId: review.id,
        newValues: { complaintId: row.id, kind: row.complainant_kind, reasonCode: row.reason_code },
        regionId: review.region_id,
      });
      return toComplaintDto(row);
    });
  }

  /**
   * Апелляция (states-and-rules §6.4): автор — на hidden/rejected; партнёр-владелец (review.appeal) — на решение
   * «оставить» по его жалобе. Одна на отзыв; решает модератор, не принимавший обжалуемое решение.
   */
  async appeal(userId: string, input: CreateAppealDto, meta: ReviewAuditMeta): Promise<AppealDto> {
    const text = input.text.trim();
    if (!text)
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          fields: [{ field: "text", constraint: "minLength", messageKey: "errors.validation.minLength" }],
        },
      });
    const grants = await this.activeGrants(userId);
    return this.inRegion(input.regionId, async () => {
      const review = await this.repo.findReview(input.reviewId.toLowerCase(), true);
      if (!review) throw notFound();
      const isAuthor = review.author_user_id === userId;
      const grant = isAuthor
        ? undefined
        : findGrant(grants, "review.appeal", reviewChain(review), this.now());
      if (!isAuthor && !grant) throw notFound();
      if (await this.repo.appealOf(review.id)) throw conflict("errors.review.appealExists", "appeal_exists");
      const kind = isAuthor ? "author" : "partner";
      const dismissed = isAuthor
        ? false
        : ((await this.repo.complaints([review.id])).get(review.id) ?? []).some((c) =>
            ownDismissed(c, userId),
          );
      if (!appealAllowed(kind, review, dismissed) || !review.last_decision_by)
        throw unprocessable("errors.review.appealNotAllowed", "appeal_not_allowed", {
          currentStatus: review.status,
        });
      const row = await this.repo
        .insertAppeal({
          review_id: review.id,
          appellant_user_id: userId,
          appellant_kind: kind,
          text,
          appealed_decision_by: review.last_decision_by,
          appealed_review_status: review.status,
        })
        .catch(rethrowUnique("review_appeals_review_key", "errors.review.appealExists", "appeal_exists"));
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant?.id ?? null,
        action: REVIEW_AUDIT.appeal,
        entityType: REVIEW_ENTITY,
        entityId: review.id,
        newValues: { appealId: row.id, kind, reviewStatus: review.status },
        regionId: review.region_id,
      });
      return toAppealDto(row);
    });
  }

  // --- партнёр (P07) ---

  /** Отзывы о заведениях партнёра (published и hidden; новые сверху). */
  async partnerList(userId: string, placeId?: string): Promise<PartnerReviewListDto> {
    const grants = await this.partnerGrants(userId);
    let places = await this.partnerPlaces(grants, "review.respond");
    if (placeId) places = places.filter((p) => p.placeId === placeId.toLowerCase());
    if (places.length === 0) throw forbidden("not_partner");
    const items: PartnerReviewDto[] = [];
    for (const [regionId, list] of groupBy(places, (p) => p.regionId))
      await withTenant(this.db, regionContext(regionId), async () => {
        const rows = (
          await this.repo.reviewsOfPlaces(
            list.map((p) => p.placeId),
            REVIEW_PARAMS.partnerListMax,
          )
        ).filter((r) => r.status === "published" || r.status === "hidden");
        items.push(...(await this.partnerDtos(rows, grants, userId)));
      });
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { items: items.slice(0, REVIEW_PARAMS.partnerListMax) };
  }

  /**
   * Ответ партнёра (states-and-rules §6.3): один на отзыв, публикуется сразу (D-68), правка — того же ответа. Тот же
   * автофильтр: ссылки, телефоны, e-mail, мат — 422 (ответ партнёра модерацией не проходит).
   */
  async putResponse(
    userId: string,
    reviewId: string,
    textInput: string,
    meta: ReviewAuditMeta,
  ): Promise<PartnerReviewDto> {
    const grants = await this.partnerGrants(userId);
    const text = textInput.trim();
    if (!text)
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          fields: [{ field: "text", constraint: "minLength", messageKey: "errors.validation.minLength" }],
        },
      });
    const regionId = await this.repo.reviewRegion(reviewId.toLowerCase());
    if (!regionId) throw notFound();
    return withTenant(this.db, regionContext(regionId), async () => {
      const review = await this.repo.findReview(reviewId.toLowerCase(), true);
      if (!review) throw notFound();
      const chain = reviewChain(review);
      const now = this.now();
      const grant = findGrant(grants, "review.respond", chain, now);
      if (!grant) {
        if (relatedTo(grants, review, now)) throw forbidden("role_forbidden");
        throw notFound();
      }
      if (review.status !== "published")
        throw conflict("errors.review.notPublished", "not_published", { currentStatus: review.status });
      const flags = autoFlags(text);
      if (flags.length > 0)
        throw unprocessable("errors.review.responseRejected", "response_rejected", { flags });
      const existing = await this.repo.findResponse(review.id);
      const saved = existing
        ? await this.repo.updateResponse(existing.id, { author_user_id: userId, text })
        : await this.repo
            .insertResponse({ review_id: review.id, author_user_id: userId, text })
            .catch(
              rethrowUnique(
                "review_responses_review_key",
                "errors.review.responseChanged",
                "response_exists",
              ),
            );
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant.id,
        action: REVIEW_AUDIT.respond,
        entityType: REVIEW_ENTITY,
        entityId: review.id,
        oldValues: existing ? { responseVersion: existing.version } : null,
        newValues: { responseId: saved.id, responseVersion: saved.version },
        regionId: review.region_id,
      });
      return (await this.partnerDtos([review], grants, userId))[0]!;
    });
  }

  // --- модерация (AD06) ---

  async adminList(
    userId: string,
    q: { regionId?: string; status?: AdminReviewFilter },
  ): Promise<AdminReviewListDto> {
    const s = await this.moderationScope(userId);
    const regionId = q.regionId?.toLowerCase();
    if (regionId && !s.platform && !s.regions.has(regionId)) throw forbidden("region_forbidden");
    const filter = q.status ?? "queue";
    const load = async (): Promise<AdminReviewDto[]> => {
      const rows =
        filter === "queue"
          ? await this.repo.reviewsByIds(await this.repo.queueIds(REVIEW_PARAMS.queueMax))
          : await this.repo.reviewsByStatus(filter === "all" ? undefined : filter, REVIEW_PARAMS.queueMax);
      const enabled = new Map<string, boolean>();
      const visible: Review[] = [];
      for (const r of rows) {
        if (!enabled.has(r.region_id))
          enabled.set(r.region_id, await this.flags.isEnabled(REVIEWS_FLAG, r.region_id));
        if (enabled.get(r.region_id)) visible.push(r);
      }
      return this.adminDtos(visible, s.grants, userId);
    };
    let items: AdminReviewDto[];
    if (regionId) items = await withTenant(this.db, regionContext(regionId), load);
    else if (s.platform) items = await withTenant(this.db, PLATFORM_CONTEXT, load);
    else {
      items = [];
      for (const r of s.regions) items.push(...(await withTenant(this.db, regionContext(r), load)));
    }
    items.sort((a, b) =>
      filter === "queue"
        ? a.waitingSince.localeCompare(b.waitingSince)
        : b.createdAt.localeCompare(a.createdAt),
    );
    return { items: items.slice(0, REVIEW_PARAMS.queueMax) };
  }

  /**
   * Решение модератора (states-and-rules §6.2): publish — одобрить отфильтрованный, оставить по жалобе, вернуть
   * скрытый/отклонённый; hide — скрыть опубликованный (жалоба удовлетворена) или отклонить отфильтрованный. Открытые
   * жалобы отзыва закрываются решением. Модератор с ролью в организации места (BR-12) — 403. AuditLog.
   */
  async decide(
    userId: string,
    reviewId: string,
    input: ReviewDecisionDto,
    meta: ReviewAuditMeta,
  ): Promise<AdminReviewDto> {
    const reason = input.reason?.trim() || null;
    if (input.decision === "hide" && !reason)
      throw new ApiError("VALIDATION_FAILED", {
        details: {
          fields: [{ field: "reason", constraint: "isDefined", messageKey: "errors.validation.isDefined" }],
        },
      });
    const { regionId, grant, grants } = await this.reviewAccess(userId, reviewId, "review.moderate");
    const result = await withTenant(this.db, regionContext(regionId), async () => {
      const now = this.now();
      const review = await this.repo.findReview(reviewId.toLowerCase(), true);
      if (!review) throw notFound();
      if (relatedTo(grants, review, now)) throw forbidden("own_organization");
      const appeal = await this.repo.appealOf(review.id);
      if (appeal?.status === "open") throw conflict("errors.review.appealPending", "appeal_pending");
      // Решение по апелляции финально: модератор, чьё решение обжаловали, не переигрывает его своим новым решением.
      if (appeal && appeal.appealed_decision_by === userId)
        throw forbidden("appeal_final", "errors.review.appealFinal");
      const target = decisionTarget(review.status, input.decision);
      if (!target)
        throw conflict("errors.review.invalidDecision", "invalid_decision", { currentStatus: review.status });
      const open = ((await this.repo.complaints([review.id])).get(review.id) ?? []).filter(
        (c) => c.status === "open",
      );
      if (target === review.status && open.length === 0)
        throw conflict("errors.review.nothingToDecide", "nothing_to_decide", {
          currentStatus: review.status,
        });
      const updated = await this.applyDecision(review, target, reason, userId, now);
      const closed = await this.repo.closeComplaints(
        review.id,
        complaintOutcome(input.decision),
        userId,
        now,
      );
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant.id,
        action: REVIEW_AUDIT.moderate,
        entityType: REVIEW_ENTITY,
        entityId: review.id,
        oldValues: { status: review.status },
        newValues: {
          status: target,
          decision: input.decision,
          complaints: closed.map((c) => c.id),
          complaintStatus: complaintOutcome(input.decision),
        },
        reason,
        regionId,
      });
      return {
        dto: (await this.adminDtos([updated], grants, userId))[0]!,
        review: updated,
        changed: target !== review.status,
      };
    });
    if (result.changed) await this.emitModerated(result.review, userId);
    return result.dto;
  }

  /**
   * Решение по апелляции (states-and-rules §6.4): решает модератор, не принимавший обжалуемое решение (D-08), иначе
   * 403 same_moderator. grant — отмена решения: апелляция автора → published, партнёра → hidden. Финально. AuditLog.
   */
  async decideAppeal(
    userId: string,
    reviewId: string,
    input: AppealDecisionDto,
    meta: ReviewAuditMeta,
  ): Promise<AdminReviewDto> {
    const note = input.reason?.trim() || null;
    const { regionId, grant, grants } = await this.reviewAccess(userId, reviewId, "appeal.decide");
    const result = await withTenant(this.db, regionContext(regionId), async () => {
      const now = this.now();
      const review = await this.repo.findReview(reviewId.toLowerCase(), true);
      if (!review) throw notFound();
      const appeal = await this.repo.appealOf(review.id, true);
      if (!appeal) throw notFound();
      if (appeal.status !== "open")
        throw conflict("errors.review.appealDecided", "appeal_decided", { currentStatus: appeal.status });
      if (appeal.appealed_decision_by === userId)
        throw forbidden("same_moderator", "errors.review.appealSameModerator");
      if (relatedTo(grants, review, now)) throw forbidden("own_organization");
      const decided = await this.repo.decideAppeal(appeal.id, {
        status: input.decision === "grant" ? "granted" : "denied",
        decided_by: userId,
        decided_at: now,
        decision_note: note,
      });
      if (!decided) throw conflict("errors.review.appealDecided", "appeal_decided");
      const target = input.decision === "grant" ? appealGrantedStatus(appeal.appellant_kind) : review.status;
      const updated =
        target !== review.status
          ? await this.applyDecision(review, target, note ?? "appeal", userId, now)
          : review;
      await this.audit.record(currentDb(this.db), {
        ...meta,
        roleAssignmentId: grant.id,
        action: REVIEW_AUDIT.appealDecide,
        entityType: REVIEW_ENTITY,
        entityId: review.id,
        oldValues: { status: review.status, appealStatus: "open" },
        newValues: { status: target, appealId: appeal.id, appealStatus: decided.status },
        reason: note,
        regionId,
      });
      return {
        dto: (await this.adminDtos([updated], grants, userId))[0]!,
        review: updated,
        changed: target !== review.status,
      };
    });
    if (result.changed) await this.emitModerated(result.review, userId);
    return result.dto;
  }

  // --- внутреннее ---

  private async applyDecision(
    review: Review,
    target: ReviewStatus,
    reason: string | null,
    userId: string,
    now: Date,
  ): Promise<Review> {
    const updated = await this.repo.updateReview(review.id, {
      status: target,
      published_at: target === "published" ? (review.published_at ?? now) : review.published_at,
      hidden_reason: target === "hidden" || target === "rejected" ? reason : null,
      last_decision_by: userId,
      last_decision_at: now,
    });
    if (!updated) throw notFound();
    if (review.status === "published" || target === "published") await this.refreshRating(review.place_id);
    return updated;
  }

  /** Пересчёт кэша рейтинга места (в транзакции изменения). */
  private async refreshRating(placeId: string): Promise<PlaceReviewRating | undefined> {
    const place = await this.repo.findPlace(placeId);
    if (!place) return undefined;
    return this.computeAndStore(place);
  }

  private async computeAndStore(place: PlaceRef): Promise<PlaceReviewRating> {
    // Параллельные изменения отзывов места пересчитывают кэш по очереди (иначе поздний пересчёт со старыми данными
    // мог бы перезаписать свежий): блокировка до конца транзакции, затем чтение.
    await this.repo.lockRating(place.id);
    const now = this.now();
    const [inputs, stats] = await Promise.all([
      this.repo.ratingInputs(place.id),
      this.repo.categoryStats(place.category_id),
    ]);
    const result = computeRating(inputs, categoryPrior(stats.count, stats.sum), now);
    return this.repo.upsertRating(place.id, result, now);
  }

  /**
   * Рейтинг для публичного GET без записи: свежий кэш текущей версии формулы — как есть; нет кэша или он устарел
   * (затухание по давности, другая версия формулы) — расчёт в памяти, кэш обновится при следующем изменении отзывов.
   */
  private async publicRatingOf(place: PlaceRef): Promise<PlaceRatingDto> {
    const now = this.now();
    const row = (await this.repo.ratings([place.id])).get(place.id);
    if (row && !ratingStale(row, now)) return toRatingDto(row);
    const [inputs, stats] = await Promise.all([
      this.repo.ratingInputs(place.id),
      this.repo.categoryStats(place.category_id),
    ]);
    const r = computeRating(inputs, categoryPrior(stats.count, stats.sum), now);
    return toRatingDto({
      id: row?.id ?? place.id,
      region_id: row?.region_id ?? "",
      place_id: place.id,
      formula_version: r.formulaVersion,
      review_count: r.reviewCount,
      average: r.average === null ? null : String(r.average),
      score: r.score === null ? null : String(r.score),
      computed_at: now,
    });
  }

  private async myDtos(rows: readonly Review[]): Promise<Map<string, MyReviewDto>> {
    const ids = rows.map((r) => r.id);
    const [responses, appeals] = await Promise.all([this.repo.responses(ids), this.repo.appeals(ids)]);
    return new Map(
      rows.map((r) => {
        const appeal = appeals.get(r.id);
        return [
          r.id,
          {
            id: r.id,
            placeId: r.place_id,
            status: r.status,
            rating: r.rating,
            text: r.text,
            version: r.current_version,
            autoFlags: r.auto_flags,
            hiddenReason: r.hidden_reason,
            publishedAt: r.published_at?.toISOString() ?? null,
            createdAt: r.created_at.toISOString(),
            updatedAt: r.updated_at.toISOString(),
            response: publicResponse(responses.get(r.id)),
            appeal: appeal ? toAppealDto(appeal) : null,
            canAppeal: !appeal && appealAllowed("author", r, false),
          },
        ];
      }),
    );
  }

  private async partnerDtos(rows: readonly Review[], grants: readonly Grant[], userId: string) {
    const ids = rows.map((r) => r.id);
    const [responses, complaints, appeals, names, users] = await Promise.all([
      this.repo.responses(ids),
      this.repo.complaints(ids),
      this.repo.appeals(ids),
      this.repo.placeNames(rows.map((r) => r.place_id)),
      this.repo.users(rows.map((r) => r.author_user_id)),
    ]);
    const now = this.now();
    return rows.map((r): PartnerReviewDto => {
      const mine = (complaints.get(r.id) ?? []).filter((c) => c.complainant_user_id === userId);
      const appeal = appeals.get(r.id);
      const chain = reviewChain(r);
      return {
        id: r.id,
        regionId: r.region_id,
        placeId: r.place_id,
        placeName: names.get(r.place_id) ?? { uk: "" },
        status: r.status,
        rating: r.rating,
        text: r.text,
        version: r.current_version,
        authorName: firstName(users.get(r.author_user_id)?.display_name),
        publishedAt: r.published_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        response: publicResponse(responses.get(r.id), true),
        myComplaints: mine.map(toComplaintDto),
        appeal: appeal ? toAppealDto(appeal) : null,
        canRespond: r.status === "published" && !!findGrant(grants, "review.respond", chain, now),
        canAppeal:
          !appeal &&
          !!findGrant(grants, "review.appeal", chain, now) &&
          appealAllowed(
            "partner",
            r,
            (complaints.get(r.id) ?? []).some((c) => ownDismissed(c, userId)),
          ),
      };
    });
  }

  private async adminDtos(rows: readonly Review[], grants: readonly Grant[], userId: string) {
    const ids = rows.map((r) => r.id);
    const [revisions, complaints, appeals, responses, names, users] = await Promise.all([
      this.repo.revisions(ids),
      this.repo.complaints(ids),
      this.repo.appeals(ids),
      this.repo.responses(ids),
      this.repo.placeNames(rows.map((r) => r.place_id)),
      this.repo.users(rows.map((r) => r.author_user_id)),
    ]);
    const now = this.now();
    return rows.map((r): AdminReviewDto => {
      const list = complaints.get(r.id) ?? [];
      const appeal = appeals.get(r.id);
      return {
        id: r.id,
        regionId: r.region_id,
        placeId: r.place_id,
        placeName: names.get(r.place_id) ?? { uk: "" },
        organizationId: r.organization_id,
        authorUserId: r.author_user_id,
        authorName: users.get(r.author_user_id)?.display_name ?? null,
        status: r.status,
        rating: r.rating,
        text: r.text,
        version: r.current_version,
        autoFlags: r.auto_flags,
        hiddenReason: r.hidden_reason,
        publishedAt: r.published_at?.toISOString() ?? null,
        lastDecisionBy: r.last_decision_by,
        lastDecisionAt: r.last_decision_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        revisions: (revisions.get(r.id) ?? []).map((v) => ({
          version: v.version_no,
          rating: v.rating,
          text: v.text,
          autoFlags: v.auto_flags,
          createdAt: v.created_at.toISOString(),
        })),
        complaints: list.map(toComplaintDto),
        appeal: appeal ? toAppealDto(appeal) : null,
        response: publicResponse(responses.get(r.id), true),
        ownOrganization: relatedTo(grants, r, now),
        canDecideAppeal: appeal?.status === "open" && appeal.appealed_decision_by !== userId,
        waitingSince: waitingSince(r, list, appeal).toISOString(),
      };
    });
  }

  private async activeGrants(userId: string): Promise<Grant[]> {
    const now = this.now();
    return (await this.rbac.grantsOf(userId)).filter((g) => isGrantActive(g, now));
  }

  /**
   * Назначения партнёра для /partner/* (regionId в запросе нет): флаг module.reviews — по регионам назначений
   * (как бронирования): выключен во всех — 404; назначения регионов с выключенным флагом отбрасываются.
   */
  private async partnerGrants(userId: string): Promise<Grant[]> {
    const grants = await this.activeGrants(userId);
    const regions = [...new Set(grants.flatMap((g) => (g.regionId ? [g.regionId.toLowerCase()] : [])))];
    if (regions.length === 0) {
      if (!(await this.flags.isEnabled(REVIEWS_FLAG, null))) throw notFound();
      return grants;
    }
    const enabled = new Set<string>();
    for (const regionId of regions)
      if (await this.flags.isEnabled(REVIEWS_FLAG, regionId)) enabled.add(regionId);
    if (enabled.size === 0) throw notFound();
    return grants.filter((g) => !g.regionId || enabled.has(g.regionId.toLowerCase()));
  }

  /** Места партнёра с правом: назначения PLACE и ORGANIZATION (все места организации). */
  private async partnerPlaces(grants: readonly Grant[], permission: PermissionCode): Promise<PartnerPlace[]> {
    const usable = grants.filter(
      (g) =>
        (g.scopeType === "ORGANIZATION" || g.scopeType === "PLACE") &&
        g.scopeId &&
        g.regionId &&
        roleHasPermission(g.role, permission),
    );
    const out = new Map<string, PartnerPlace>();
    for (const [regionId, list] of groupBy(usable, (g) => g.regionId!.toLowerCase()))
      await withTenant(this.db, regionContext(regionId), async () => {
        const orgIds = list
          .filter((g) => g.scopeType === "ORGANIZATION")
          .map((g) => g.scopeId!.toLowerCase());
        for (const p of await this.repo.placesOfOrganizations(orgIds))
          out.set(p.id, { placeId: p.id, organizationId: p.organization_id, regionId });
        for (const g of list.filter((x) => x.scopeType === "PLACE")) {
          const placeId = g.scopeId!.toLowerCase();
          if (out.has(placeId)) continue;
          const place = await this.repo.findPlace(placeId);
          if (place?.organization_id)
            out.set(placeId, { placeId, organizationId: place.organization_id, regionId });
        }
      });
    return [...out.values()];
  }

  private async moderationScope(userId: string): Promise<ModerationScope> {
    const grants = await this.rbac.grantsOf(userId);
    const now = this.now();
    const s: ModerationScope = { platform: false, regions: new Set(), grants };
    for (const g of grants) {
      if (!isGrantActive(g, now) || !roleHasPermission(g.role, "review.moderate")) continue;
      if (g.scopeType === "PLATFORM") s.platform = true;
      else if (g.scopeType === "REGION" && g.scopeId) s.regions.add(g.scopeId.toLowerCase());
    }
    if (!s.platform && s.regions.size === 0) throw forbidden("not_moderator");
    return s;
  }

  /** Регион отзыва (из БД), флаг модуля в нём и назначение с правом на регион; нет — 404, чужой регион — 403. */
  private async reviewAccess(
    userId: string,
    reviewId: string,
    permission: PermissionCode,
  ): Promise<{ regionId: string; grant: Grant; grants: Grant[] }> {
    const grants = await this.rbac.grantsOf(userId);
    const regionId = await this.repo.reviewRegion(reviewId.toLowerCase());
    if (!regionId || !(await this.flags.isEnabled(REVIEWS_FLAG, regionId))) throw notFound();
    const auth = await this.rbac.authorize(grants, permission, regionScope(regionId), this.now());
    if (!auth) throw forbidden("region_forbidden");
    return { regionId, grant: auth.grant, grants };
  }

  /** Активный регион или 404; fn — в транзакции с контекстом региона. */
  private async inRegion<T>(regionId: string, fn: (region: Region) => Promise<T>): Promise<T> {
    const region = await this.regions.findById(regionId.toLowerCase());
    if (region?.status !== "active") throw notFound();
    const tenant = currentTenant();
    if (tenant?.kind === "region" && tenant.regionId === region.id) return fn(region);
    return withTenant(this.db, regionContext(region.id), () => fn(region));
  }

  private async emitModerated(review: Review, actorUserId: string): Promise<void> {
    const decision =
      review.status === "published" ? "published" : review.status === "hidden" ? "hidden" : "rejected";
    await this.emit("review_moderated", review, actorUserId, { reviewId: review.id, decision });
  }

  /** Событие review_* после коммита (ошибка аналитики не ломает операцию). Псевдоним — автора отзыва. */
  private async emit(
    event: "review_submitted" | "review_moderated",
    review: Review,
    actorUserId: string,
    props: JsonObject,
  ): Promise<void> {
    if (!this.analytics) return;
    try {
      const user = await withTenant(this.db, regionContext(review.region_id), async () =>
        (await this.repo.users([review.author_user_id])).get(review.author_user_id),
      );
      if (!user) return;
      await this.analytics.emit({
        eventId: uuidv7(),
        schemaVersion: ANALYTICS_SCHEMA_VERSION,
        occurredAt: this.now().toISOString(),
        pseudonymousUserId: user.analytics_id,
        regionId: review.region_id,
        source: event === "review_submitted" ? "direct" : "system",
        entryContextId: null,
        placeId: review.place_id,
        event,
        props: { ...props, placeId: review.place_id },
      } as AnalyticsEvent);
    } catch (err) {
      this.logger.warn(
        `Событие ${event} (${actorUserId}) не записано: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// --- преобразования и помощники ---

function reviewChain(r: Pick<Review, "place_id" | "organization_id" | "region_id">): ScopeChain {
  return [
    scope("PLACE", r.place_id),
    ...(r.organization_id ? [scope("ORGANIZATION", r.organization_id)] : []),
    regionScope(r.region_id),
    PLATFORM_SCOPE,
  ];
}

/** Есть ли у пользователя действующая роль в организации или на месте отзыва (BR-12, партнёр без права). */
function relatedTo(
  grants: readonly Grant[],
  r: Pick<Review, "place_id" | "organization_id">,
  now: Date,
): boolean {
  const ids = new Set([
    r.place_id.toLowerCase(),
    ...(r.organization_id ? [r.organization_id.toLowerCase()] : []),
  ]);
  return grants.some(
    (g) =>
      isGrantActive(g, now) &&
      (g.scopeType === "ORGANIZATION" || g.scopeType === "PLACE") &&
      !!g.scopeId &&
      ids.has(g.scopeId.toLowerCase()),
  );
}

/** Жалоба этого партнёра, которую модератор отклонил («оставить») — основание его апелляции. */
function ownDismissed(c: ReviewComplaint, userId: string): boolean {
  return c.complainant_kind === "partner" && c.status === "dismissed" && c.complainant_user_id === userId;
}

/** Нет кэша — нет опубликованных отзывов: «Мало відгуків». */
function emptyRating(placeId: string, now: Date): PlaceRatingDto {
  return {
    placeId,
    reviewCount: 0,
    fewReviews: true,
    score: null,
    minReviews: RATING_PARAMS.minReviews,
    formulaVersion: RATING_PARAMS.formulaVersion,
    computedAt: now.toISOString(),
  };
}

function waitingSince(
  r: Review,
  complaints: readonly ReviewComplaint[],
  appeal: ReviewAppeal | undefined,
): Date {
  const times: number[] = [];
  if (r.status === "pending_moderation") times.push(r.updated_at.getTime());
  for (const c of complaints) if (c.status === "open") times.push(c.created_at.getTime());
  if (appeal?.status === "open") times.push(appeal.created_at.getTime());
  return new Date(times.length > 0 ? Math.min(...times) : r.updated_at.getTime());
}

/** Имя автора для публики — первое слово профиля (без фамилии). */
function firstName(displayName: string | null | undefined): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first || null;
}

function publicResponse(r: ReviewResponse | undefined, includeHidden = false): ReviewResponseDto | null {
  if (!r || (!includeHidden && r.status !== "published")) return null;
  return {
    id: r.id,
    text: r.text,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function toRatingDto(r: PlaceReviewRating): PlaceRatingDto {
  const score = r.score === null ? null : Math.round(Number(r.score) * 10) / 10;
  return {
    placeId: r.place_id,
    reviewCount: r.review_count,
    fewReviews: score === null,
    score,
    minReviews: RATING_PARAMS.minReviews,
    formulaVersion: r.formula_version,
    computedAt: r.computed_at.toISOString(),
  };
}

function toComplaintDto(c: ReviewComplaint): ComplaintDto {
  return {
    id: c.id,
    reviewId: c.review_id,
    kind: c.complainant_kind,
    reasonCode: c.reason_code,
    text: c.text,
    status: c.status,
    createdAt: c.created_at.toISOString(),
    decidedAt: c.decided_at?.toISOString() ?? null,
  };
}

function toAppealDto(a: ReviewAppeal): AppealDto {
  return {
    id: a.id,
    reviewId: a.review_id,
    kind: a.appellant_kind,
    text: a.text,
    status: a.status,
    decisionNote: a.decision_note,
    createdAt: a.created_at.toISOString(),
    decidedAt: a.decided_at?.toISOString() ?? null,
  };
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

/** Нарушение уникальности (23505) по ограничению — 409 с messageKey, иначе ошибка как есть. */
function rethrowUnique(constraint: string, messageKey: string, reason: string) {
  return (e: unknown): never => {
    const err = (e ?? {}) as { code?: unknown; constraint?: unknown };
    if (err.code === "23505" && err.constraint === constraint) throw conflict(messageKey, reason);
    throw e;
  };
}
