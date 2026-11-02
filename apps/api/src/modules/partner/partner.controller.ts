import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { RequireAuth } from "../auth/index.js";
import { RequireFeature, type FeatureRegionResolver } from "../feature-flags/index.js";
import { Idempotent } from "../idempotency/index.js";
import { MediaUploadDto } from "../media/index.js";
import { RateLimit } from "../rate-limit/index.js";
import type { RbacRequest } from "../rbac/index.js";
import {
  OfferDto,
  OfferListDto,
  PartnerMeDto,
  PartnerOnboardingResultDto,
  PartnerPlaceDto,
  PartnerStaffDto,
  PartnerStaffMemberDto,
  PartnerTemplateListDto,
  StaffInviteAcceptedDto,
  StaffInviteCreatedDto,
  StaffInvitePreviewDto,
  STAFF_INVITE_TTL_HOURS,
} from "./partner.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ChangeStaffRoleDto,
  CreateOfferDto,
  CreateStaffInviteDto,
  OfferListQueryDto,
  PartnerMediaConfirmDto,
  PartnerMediaUploadRequestDto,
  PartnerOnboardingDto,
  PartnerSubmitDto,
  PartnerTemplatesQueryDto,
  UpdateOfferDto,
  UpdatePartnerPlaceDto,
} from "./partner.dto.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PutScheduleDto } from "../catalog/index.js";
import { PartnerService } from "./partner.service.js";

// Блок 6 (ADR-0021): кабинет партнёра в том же Mini App (D-50) — сессия Telegram, как /me. Права — назначения
// ORG_OWNER / ORG_MANAGER / ORG_STAFF на организацию (RBAC на сервере, не из запроса); транзакция — регион
// организации (withTenant в сервисе). Модуль — за флагом module.partner_cabinet: выключен — 404.

/** Онбординг: не больше 5 новых заведений в час на пользователя (S-05: защита от фейковых заявок, BR-14). */
export const ONBOARDING_RATE_LIMIT = { limit: 5, windowSec: 3600 } as const;
/** Приглашения: не больше 30 в час. */
export const INVITE_RATE_LIMIT = { limit: 30, windowSec: 3600 } as const;

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

/** Регион флага: query/body regionId (шаблоны, онбординг); иначе — значение окружения. */
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

const PLACE_ERRORS = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "RATE_LIMITED",
] as const;

@ApiTags("partner")
@Controller("partner")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.partner_cabinet", { region: requestRegion })
export class PartnerController {
  constructor(@Inject(PartnerService) private readonly partner: PartnerService) {}

  // --- онбординг и режим партнёра ---

  @Get("templates")
  @ApiOperation({
    operationId: "listPartnerTemplates",
    summary: "Шаблоны партнёра (P12, D-03): «Готель / садиба», «Заклад харчування», «Чан / сауна»",
    description:
      "Категории шаблона — активные категории справочника региона. 404 — регион не найден/не активен.",
  })
  @ApiOkResponse({ type: PartnerTemplateListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  templates(@Query() q: PartnerTemplatesQueryDto): Promise<PartnerTemplateListDto> {
    return this.partner.templates(q.regionId);
  }

  @Post("onboarding")
  @Idempotent()
  @RateLimit(ONBOARDING_RATE_LIMIT)
  @ApiOperation({
    operationId: "partnerOnboarding",
    summary: "«Стати партнером» (S-05): Organization + Place(draft) + ORG_OWNER по шаблону",
    description:
      "Заведение невидимо туристу до одобрения модератором. 404 — регион не активен; 422 " +
      "errors.partner.templateUnavailable (нет шаблона) или errors.partner.categoryNotInTemplate (категория не из " +
      "шаблона). Назначение ORG_OWNER и создание — в AuditLog.",
  })
  @ApiCreatedResponse({ type: PartnerOnboardingResultDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "UNPROCESSABLE",
    "RATE_LIMITED",
    "IDEMPOTENCY_KEY_REQUIRED",
    "IDEMPOTENCY_IN_PROGRESS",
    "IDEMPOTENCY_KEY_REUSED",
  )
  onboarding(
    @Body() body: PartnerOnboardingDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerOnboardingResultDto> {
    return this.partner.onboard(userOf(req), body, auditFromRequest(req));
  }

  @Get("me")
  @ApiOperation({
    operationId: "getPartnerMe",
    summary: "Режим партнёра (P13, P01): организации, роль, заведения, статус модерации, счётчики",
    description: "Пусто — пользователь не партнёр (показать «Стати партнером»).",
  })
  @ApiOkResponse({ type: PartnerMeDto })
  @ApiErrors("UNAUTHENTICATED", "RATE_LIMITED")
  me(@Req() req: RbacRequest): Promise<PartnerMeDto> {
    return this.partner.me(userOf(req));
  }

  // --- редактор заведения (P06) ---

  @Get("places/:id")
  @ApiOperation({
    operationId: "getPartnerPlace",
    summary:
      "Карточка заведения в редакторе (P06): поля, график, фото, незаполненные поля шаблона, модерация",
    description:
      "403 — нет роли партнёра в организации заведения; 404 — заведения нет (или это не место партнёра).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerPlaceDto })
  @ApiErrors(...PLACE_ERRORS)
  getPlace(@Param("id", uuid) id: string, @Req() req: RbacRequest): Promise<PartnerPlaceDto> {
    return this.partner.getPlace(userOf(req), id);
  }

  @Patch("places/:id")
  @ApiOperation({
    operationId: "updatePartnerPlace",
    summary: "Правка карточки (P06): черновик или живая версия опубликованного (без PlaceRevision, §1.6)",
    description:
      "ORG_OWNER — все поля; ORG_MANAGER — без categoryId, name, address, location (403 " +
      "identity_fields_forbidden); ORG_STAFF — 403. 409 errors.partner.placeNotEditable — на модерации, " +
      "приостановлено или в архиве. Изменение — AuditLog.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerPlaceDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT", "UNPROCESSABLE")
  updatePlace(
    @Param("id", uuid) id: string,
    @Body() body: UpdatePartnerPlaceDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPlaceDto> {
    return this.partner.updatePlace(userOf(req), id, body, auditFromRequest(req));
  }

  @Put("places/:id/schedule")
  @ApiOperation({
    operationId: "putPartnerPlaceSchedule",
    summary: "Заменить график работы (недельные интервалы и исключения)",
    description: "ORG_OWNER, ORG_MANAGER. 422 errors.place.scheduleInvalid (details.problems).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerPlaceDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT", "UNPROCESSABLE")
  putSchedule(
    @Param("id", uuid) id: string,
    @Body() body: PutScheduleDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPlaceDto> {
    return this.partner.putSchedule(userOf(req), id, body, auditFromRequest(req));
  }

  @Post("places/:id/media/uploads")
  @ApiOperation({
    operationId: "createPartnerPlaceMediaUpload",
    summary: "Фото заведения: заявка на загрузку → подписанная ссылка PUT (как POST /media/uploads)",
    description:
      "Дальше: PUT файла по upload.url с upload.headers → POST …/media/{assetId}/confirm. 422 — тип/размер " +
      "не подходят (details.reason).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiCreatedResponse({ type: MediaUploadDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT", "UNPROCESSABLE")
  createUpload(
    @Param("id", uuid) id: string,
    @Body() body: PartnerMediaUploadRequestDto,
    @Req() req: RbacRequest,
  ): Promise<MediaUploadDto> {
    return this.partner.createMediaUpload(userOf(req), id, body);
  }

  @Post("places/:id/media/:assetId/confirm")
  @HttpCode(200)
  @ApiOperation({
    operationId: "confirmPartnerPlaceMedia",
    summary: "Подтвердить загрузку фото и привязать к заведению (обработка вариантов — в фоне)",
    description: "Файл не прошёл проверку — 422 errors.place.mediaInvalid (details.reason = media_rejected).",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "assetId", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerPlaceDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT", "UNPROCESSABLE")
  confirmMedia(
    @Param("id", uuid) id: string,
    @Param("assetId", uuid) assetId: string,
    @Body() body: PartnerMediaConfirmDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPlaceDto> {
    return this.partner.confirmMedia(userOf(req), id, assetId, body, auditFromRequest(req));
  }

  @Delete("places/:id/media/:assetId")
  @HttpCode(204)
  @ApiOperation({ operationId: "deletePartnerPlaceMedia", summary: "Убрать фото из карточки" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "assetId", type: String, format: "uuid" })
  @ApiNoContentResponse({ description: "Убрано" })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT")
  async deleteMedia(
    @Param("id", uuid) id: string,
    @Param("assetId", uuid) assetId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.partner.deleteMedia(userOf(req), id, assetId, auditFromRequest(req));
  }

  @Post("places/:id/submit")
  @HttpCode(200)
  @ApiOperation({
    operationId: "submitPartnerPlace",
    summary: "«Надіслати на модерацію»: draft | changes_requested | rejected → pending_moderation",
    description:
      "Только ORG_OWNER. 422 errors.partner.requiredFieldsMissing (details.fields — незаполненные поля шаблона) " +
      "или errors.place.notPublishable (details.problems); 422 errors.partner.termsRequired — без acceptTerms; " +
      "409 errors.partner.placeNotEditable — уже на модерации/опубликовано. Модераторам региона — уведомление ботом.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerPlaceDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT", "UNPROCESSABLE")
  submit(
    @Param("id", uuid) id: string,
    @Body() body: PartnerSubmitDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerPlaceDto> {
    return this.partner.submit(userOf(req), id, body, auditFromRequest(req));
  }

  // --- акции (P07) ---

  @Get("places/:id/offers")
  @ApiOperation({ operationId: "listPartnerOffers", summary: "Акции заведения (ORG_OWNER, ORG_MANAGER)" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: OfferListDto })
  @ApiErrors(...PLACE_ERRORS)
  listOffers(
    @Param("id", uuid) id: string,
    @Query() q: OfferListQueryDto,
    @Req() req: RbacRequest,
  ): Promise<OfferListDto> {
    return this.partner.listOffers(userOf(req), id, q.status);
  }

  @Post("places/:id/offers")
  @ApiOperation({ operationId: "createPartnerOffer", summary: "Новая акция (status active)" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiCreatedResponse({ type: OfferDto })
  @ApiErrors(...PLACE_ERRORS, "UNPROCESSABLE")
  createOffer(
    @Param("id", uuid) id: string,
    @Body() body: CreateOfferDto,
    @Req() req: AuthedRequest,
  ): Promise<OfferDto> {
    return this.partner.createOffer(userOf(req), id, body, auditFromRequest(req));
  }

  @Patch("places/:id/offers/:offerId")
  @ApiOperation({
    operationId: "updatePartnerOffer",
    summary: "Правка акции; 409 errors.partner.offerArchived — архивная не меняется",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "offerId", type: String, format: "uuid" })
  @ApiOkResponse({ type: OfferDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT", "UNPROCESSABLE")
  updateOffer(
    @Param("id", uuid) id: string,
    @Param("offerId", uuid) offerId: string,
    @Body() body: UpdateOfferDto,
    @Req() req: AuthedRequest,
  ): Promise<OfferDto> {
    return this.partner.updateOffer(userOf(req), id, offerId, body, auditFromRequest(req));
  }

  @Post("places/:id/offers/:offerId/archive")
  @HttpCode(200)
  @ApiOperation({
    operationId: "archivePartnerOffer",
    summary: "В архив (вместо удаления); повтор — без изменений",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiParam({ name: "offerId", type: String, format: "uuid" })
  @ApiOkResponse({ type: OfferDto })
  @ApiErrors(...PLACE_ERRORS)
  archiveOffer(
    @Param("id", uuid) id: string,
    @Param("offerId", uuid) offerId: string,
    @Req() req: AuthedRequest,
  ): Promise<OfferDto> {
    return this.partner.archiveOffer(userOf(req), id, offerId, auditFromRequest(req));
  }

  // --- сотрудники (P09) ---

  @Get("organizations/:orgId/staff")
  @ApiOperation({
    operationId: "listPartnerStaff",
    summary: "Сотрудники организации и приглашения (P09, только ORG_OWNER)",
  })
  @ApiParam({ name: "orgId", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerStaffDto })
  @ApiErrors(...PLACE_ERRORS)
  staff(@Param("orgId", uuid) orgId: string, @Req() req: RbacRequest): Promise<PartnerStaffDto> {
    return this.partner.staff(userOf(req), orgId);
  }

  @Post("organizations/:orgId/staff/invites")
  @RateLimit(INVITE_RATE_LIMIT)
  @ApiOperation({
    operationId: "createStaffInvite",
    summary: `Пригласить сотрудника: одноразовый токен на ${STAFF_INVITE_TTL_HOURS} ч (ORG_MANAGER или ORG_STAFF)`,
    description: "Токен возвращается один раз (в БД — хэш). Создание — AuditLog (без токена).",
  })
  @ApiParam({ name: "orgId", type: String, format: "uuid" })
  @ApiCreatedResponse({ type: StaffInviteCreatedDto })
  @ApiErrors(...PLACE_ERRORS)
  invite(
    @Param("orgId", uuid) orgId: string,
    @Body() body: CreateStaffInviteDto,
    @Req() req: AuthedRequest,
  ): Promise<StaffInviteCreatedDto> {
    return this.partner.createInvite(userOf(req), orgId, body.role, auditFromRequest(req));
  }

  @Delete("organizations/:orgId/staff/invites/:inviteId")
  @HttpCode(204)
  @ApiOperation({
    operationId: "revokeStaffInvite",
    summary: "Отозвать неиспользованное приглашение; 409 — уже принято",
  })
  @ApiParam({ name: "orgId", type: String, format: "uuid" })
  @ApiParam({ name: "inviteId", type: String, format: "uuid" })
  @ApiNoContentResponse({ description: "Отозвано" })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT")
  async revokeInvite(
    @Param("orgId", uuid) orgId: string,
    @Param("inviteId", uuid) inviteId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.partner.revokeInvite(userOf(req), orgId, inviteId, auditFromRequest(req));
  }

  @Patch("organizations/:orgId/staff/:assignmentId")
  @ApiOperation({
    operationId: "changeStaffRole",
    summary: "Сменить роль сотрудника (ORG_MANAGER ↔ ORG_STAFF): отзыв и новое назначение, AuditLog",
    description: "Владельца менять нельзя — 403 details.reason = owner_protected.",
  })
  @ApiParam({ name: "orgId", type: String, format: "uuid" })
  @ApiParam({ name: "assignmentId", type: String, format: "uuid" })
  @ApiOkResponse({ type: PartnerStaffMemberDto })
  @ApiErrors(...PLACE_ERRORS, "CONFLICT")
  changeRole(
    @Param("orgId", uuid) orgId: string,
    @Param("assignmentId", uuid) assignmentId: string,
    @Body() body: ChangeStaffRoleDto,
    @Req() req: AuthedRequest,
  ): Promise<PartnerStaffMemberDto> {
    return this.partner.changeRole(userOf(req), orgId, assignmentId, body.role, auditFromRequest(req));
  }

  @Delete("organizations/:orgId/staff/:assignmentId")
  @HttpCode(204)
  @ApiOperation({
    operationId: "deactivateStaff",
    summary: "Деактивировать сотрудника (отзыв назначения, AuditLog); владельца — 403 owner_protected",
  })
  @ApiParam({ name: "orgId", type: String, format: "uuid" })
  @ApiParam({ name: "assignmentId", type: String, format: "uuid" })
  @ApiNoContentResponse({ description: "Деактивирован" })
  @ApiErrors(...PLACE_ERRORS)
  async deactivate(
    @Param("orgId", uuid) orgId: string,
    @Param("assignmentId", uuid) assignmentId: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.partner.deactivate(userOf(req), orgId, assignmentId, auditFromRequest(req));
  }

  // --- принятие приглашения (P14) ---

  @Get("invites/:token")
  @ApiOperation({
    operationId: "getStaffInvite",
    summary: "Приглашение по токену (P14): «Вас запрошено як <роль> до <Заклад>»",
    description: "404 — токена нет. Истёкшее/принятое/отозванное — state, а не ошибка.",
  })
  @ApiParam({ name: "token", type: String })
  @ApiOkResponse({ type: StaffInvitePreviewDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "RATE_LIMITED")
  previewInvite(@Param("token") token: string, @Req() req: RbacRequest): Promise<StaffInvitePreviewDto> {
    return this.partner.previewInvite(userOf(req), token);
  }

  @Post("invites/:token/accept")
  @HttpCode(200)
  @ApiOperation({
    operationId: "acceptStaffInvite",
    summary: "Принять приглашение: RoleAssignment на организацию, приглашение — использовано (одноразово)",
    description:
      "404 — токена нет; 409 errors.staffInvite.used | expired | revoked (details.reason); 409 " +
      "errors.staffInvite.alreadyMember — уже сотрудник этой организации. Принятие — AuditLog.",
  })
  @ApiParam({ name: "token", type: String })
  @ApiOkResponse({ type: StaffInviteAcceptedDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "NOT_FOUND", "CONFLICT", "RATE_LIMITED")
  acceptInvite(@Param("token") token: string, @Req() req: AuthedRequest): Promise<StaffInviteAcceptedDto> {
    return this.partner.acceptInvite(userOf(req), token, auditFromRequest(req));
  }
}
