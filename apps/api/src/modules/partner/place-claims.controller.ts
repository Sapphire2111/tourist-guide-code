import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { RequireAuth } from "../auth/index.js";
import { RequireFeature, type FeatureRegionResolver } from "../feature-flags/index.js";
import { Idempotent } from "../idempotency/index.js";
import { RateLimit } from "../rate-limit/index.js";
import type { RbacRequest } from "../rbac/index.js";
import {
  PlaceClaimDetailDto,
  PlaceClaimDto,
  PlaceClaimListDto,
  PlaceClaimQueueDto,
  PlaceClaimSummaryDto,
} from "./place-claims.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ApprovePlaceClaimDto,
  CreatePlaceClaimDto,
  PlaceClaimQueueQueryDto,
  PlaceClaimsQueryDto,
  RejectPlaceClaimDto,
} from "./place-claims.dto.js";
import { PlaceClaimsService } from "./place-claims.service.js";

/** Заявки «Це мій заклад»: не больше 5 в час на пользователя (защита от массовых заявок, BR-14). */
export const CLAIM_RATE_LIMIT = { limit: 5, windowSec: 3600 } as const;

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

/**
 * «Це мій заклад» для заявителя (Mini App, сессия Telegram): подача из карточки места и статус в кабинете партнёра.
 * Модуль — за флагом module.partner_cabinet: выключен — 404.
 */
@ApiTags("partner")
@Controller("partner/claims")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.partner_cabinet", { region: requestRegion })
export class PlaceClaimsController {
  constructor(@Inject(PlaceClaimsService) private readonly claims: PlaceClaimsService) {}

  @Get()
  @ApiOperation({
    operationId: "listMyPlaceClaims",
    summary: "Мои заявки «Це мій заклад» в регионе (новые сверху): статус и комментарий модератора",
  })
  @ApiOkResponse({ type: PlaceClaimListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  mine(@Query() q: PlaceClaimsQueryDto, @Req() req: RbacRequest): Promise<PlaceClaimListDto> {
    return this.claims.mine(userOf(req), q.regionId);
  }

  @Post()
  @Idempotent()
  @RateLimit(CLAIM_RATE_LIMIT)
  @ApiOperation({
    operationId: "createPlaceClaim",
    summary:
      "«Це мій заклад»: заявка на опубликованное место без организации → pending (проверяет модератор)",
    description:
      "Организация — своя (organizationId, где пользователь ORG_OWNER) или новая (organizationName) — ровно одно, " +
      "иначе 400. 403 not_org_owner — чужая организация; 404 — места нет или оно не опубликовано; 409 " +
      "errors.placeClaim.alreadyClaimed — у места уже есть организация; 409 errors.placeClaim.duplicate — уже есть " +
      "ваша заявка на рассмотрении. Создание — в AuditLog; модераторам региона — уведомление ботом.",
  })
  @ApiCreatedResponse({ type: PlaceClaimDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "RATE_LIMITED")
  create(@Body() body: CreatePlaceClaimDto, @Req() req: AuthedRequest): Promise<PlaceClaimDto> {
    return this.claims.create(userOf(req), body, auditFromRequest(req));
  }

  @Post(":id/withdraw")
  @HttpCode(200)
  @ApiOperation({
    operationId: "withdrawPlaceClaim",
    summary: "Отозвать свою заявку на рассмотрении → withdrawn",
    description: "404 — заявки нет или она чужая; 409 errors.placeClaim.alreadyDecided — уже решена.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PlaceClaimDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "CONFLICT", "RATE_LIMITED")
  withdraw(@Param("id", uuid) id: string, @Req() req: AuthedRequest): Promise<PlaceClaimDto> {
    return this.claims.withdraw(userOf(req), id, auditFromRequest(req));
  }
}

const ERRORS = ["VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"] as const;

/**
 * Заявки «Це мій заклад» в модерации (AD02, вкладка «Заявки на заклад»): право place_claim.decide на регион заявки
 * (MODERATOR и REGION_ADMIN своего региона, SUPERADMIN — везде).
 */
@ApiTags("admin")
@Controller("admin/moderation/claims")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.partner_cabinet")
export class PlaceClaimsModerationController {
  constructor(@Inject(PlaceClaimsService) private readonly claims: PlaceClaimsService) {}

  @Get()
  @ApiOperation({
    operationId: "listPlaceClaims",
    summary: "Очередь заявок «Це мій заклад» (pending — старые сверху; decided — решённые)",
    description: "403 — нет права place_claim.decide ни в одном регионе (или в regionId).",
  })
  @ApiOkResponse({ type: PlaceClaimQueueDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN")
  list(@Query() q: PlaceClaimQueueQueryDto, @Req() req: RbacRequest): Promise<PlaceClaimQueueDto> {
    return this.claims.queue(userOf(req), { status: q.status ?? "pending", regionId: q.regionId });
  }

  @Get(":id")
  @ApiOperation({
    operationId: "getPlaceClaim",
    summary:
      "Заявка: место (телефон и сайт Google, Google Maps), заявитель (телефон, роль, комментарий), другие заявки",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PlaceClaimDetailDto })
  @ApiErrors(...ERRORS)
  get(@Param("id", uuid) id: string, @Req() req: RbacRequest): Promise<PlaceClaimDetailDto> {
    return this.claims.get(userOf(req), id);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "approvePlaceClaim",
    summary: "«Схвалити»: место → организация заявителя (ORG_OWNER), остальные заявки места — отказ",
    description:
      "Место остаётся published, source не меняется. 409 errors.placeClaim.alreadyDecided — уже решено; 409 " +
      "errors.placeClaim.alreadyClaimed — у места уже есть организация; 409 errors.placeClaim.claimantNotOwner — " +
      "заявитель больше не владелец выбранной организации; 403 own_claim / own_organization (BR-12). AuditLog; " +
      "заявителям — уведомление ботом.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PlaceClaimSummaryDto })
  @ApiErrors(...ERRORS, "CONFLICT")
  approve(
    @Param("id", uuid) id: string,
    @Body() body: ApprovePlaceClaimDto,
    @Req() req: AuthedRequest,
  ): Promise<PlaceClaimSummaryDto> {
    return this.claims.decide(userOf(req), id, "approve", body.comment, auditFromRequest(req));
  }

  @Post(":id/reject")
  @HttpCode(200)
  @ApiOperation({
    operationId: "rejectPlaceClaim",
    summary: "«Відхилити» (причина обязательна, видна заявителю)",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PlaceClaimSummaryDto })
  @ApiErrors(...ERRORS, "CONFLICT")
  reject(
    @Param("id", uuid) id: string,
    @Body() body: RejectPlaceClaimDto,
    @Req() req: AuthedRequest,
  ): Promise<PlaceClaimSummaryDto> {
    return this.claims.decide(userOf(req), id, "reject", body.reason, auditFromRequest(req));
  }

  @Post(":id/revoke")
  @HttpCode(200)
  @ApiOperation({
    operationId: "revokePlaceClaim",
    summary: "Скасувати схвалення: место без организации, заявка → revoked (причина обязательна)",
    description:
      "Организация снимается, только если место всё ещё за организацией заявки; ORG_OWNER заявителя отзывается, " +
      "только если организацию создала эта заявка и других мест у неё нет. 409 — заявка не одобрена. AuditLog; " +
      "заявителю — уведомление ботом.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PlaceClaimSummaryDto })
  @ApiErrors(...ERRORS, "CONFLICT")
  revoke(
    @Param("id", uuid) id: string,
    @Body() body: RejectPlaceClaimDto,
    @Req() req: AuthedRequest,
  ): Promise<PlaceClaimSummaryDto> {
    return this.claims.revoke(userOf(req), id, body.reason, auditFromRequest(req));
  }
}
