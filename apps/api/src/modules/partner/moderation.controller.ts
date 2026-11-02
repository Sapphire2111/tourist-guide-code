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
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { auditFromRequest, type AuditableRequest } from "../audit/index.js";
import { RequireAuth } from "../auth/index.js";
import { RequireFeature } from "../feature-flags/index.js";
import type { RbacRequest } from "../rbac/index.js";
import { ModerationCaseDetailDto, ModerationCaseDto, ModerationCaseListDto } from "./partner.dto.js";
// Классы DTO запросов нужны в рантайме: emitDecoratorMetadata передаёт их в ValidationPipe.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ApproveModerationDto, ModerationCasesQueryDto, ModerationReasonDto } from "./partner.dto.js";
import { ModerationService } from "./moderation.service.js";

const uuid = new ParseUUIDPipe({
  exceptionFactory: () => new ApiError("VALIDATION_FAILED", { details: { reason: "invalid_id" } }),
});

type AuthedRequest = RbacRequest & AuditableRequest;

function userOf(req: RbacRequest): string {
  const userId = req.principal?.userId;
  if (!userId) throw new ApiError("UNAUTHENTICATED");
  return userId;
}

const ERRORS = ["VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"] as const;

/**
 * Модерация партнёров (AD02, S-05; C-15: MODERATOR и REGION_ADMIN своего региона, SUPERADMIN — везде). Право
 * place.moderate проверяет сервис по назначениям пользователя на регион заявки (как экран персонала, ADR-0020):
 * транзакция — регион заявки, уведомление партнёру ботом — после коммита.
 */
@ApiTags("admin")
@Controller("admin/moderation/cases")
@RequireAuth()
@WithoutTenantContext()
@RequireFeature("module.partner_cabinet")
export class ModerationController {
  constructor(@Inject(ModerationService) private readonly moderation: ModerationService) {}

  @Get()
  @ApiOperation({
    operationId: "listModerationCases",
    summary: "Очередь модерации регионов модератора (старые сверху), фильтр статуса (по умолчанию open)",
    description: "403 — нет права place.moderate ни в одном регионе (или в regionId).",
  })
  @ApiOkResponse({ type: ModerationCaseListDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN")
  list(@Query() q: ModerationCasesQueryDto, @Req() req: RbacRequest): Promise<ModerationCaseListDto> {
    return this.moderation.list(userOf(req), {
      status: q.status ?? "open",
      regionId: q.regionId,
      placeId: q.placeId,
    });
  }

  @Get(":id")
  @ApiOperation({
    operationId: "getModerationCase",
    summary: "Заявка: снимок карточки, владельцы (для подтверждения права, D-47), история заявок места",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: ModerationCaseDetailDto })
  @ApiErrors(...ERRORS)
  get(@Param("id", uuid) id: string, @Req() req: RbacRequest): Promise<ModerationCaseDetailDto> {
    return this.moderation.get(userOf(req), id);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiOperation({
    operationId: "approveModerationCase",
    summary: "«Схвалити» → place published (виден туристу); способ проверки права обязателен (D-47 А)",
    description:
      "409 errors.moderation.alreadyDecided — уже решено (details.decidedBy); 422 errors.place.notPublishable — " +
      "карточка не готова (details.problems); 403 own_organization — модератор связан с организацией (BR-12). " +
      "Решение — AuditLog; партнёру — уведомление ботом.",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: ModerationCaseDto })
  @ApiErrors(...ERRORS, "CONFLICT", "UNPROCESSABLE")
  approve(
    @Param("id", uuid) id: string,
    @Body() body: ApproveModerationDto,
    @Req() req: AuthedRequest,
  ): Promise<ModerationCaseDto> {
    return this.moderation.decide(userOf(req), id, { decision: "approve", ...body }, auditFromRequest(req));
  }

  @Post(":id/reject")
  @HttpCode(200)
  @ApiOperation({
    operationId: "rejectModerationCase",
    summary: "«Відхилити» → place rejected (причина обязательна, видна партнёру)",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: ModerationCaseDto })
  @ApiErrors(...ERRORS, "CONFLICT")
  reject(
    @Param("id", uuid) id: string,
    @Body() body: ModerationReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<ModerationCaseDto> {
    return this.moderation.decide(
      userOf(req),
      id,
      { decision: "reject", comment: body.reason },
      auditFromRequest(req),
    );
  }

  @Post(":id/return")
  @HttpCode(200)
  @ApiOperation({
    operationId: "returnModerationCase",
    summary: "«Повернути на доопрацювання» → place changes_requested (комментарий обязателен)",
  })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: ModerationCaseDto })
  @ApiErrors(...ERRORS, "CONFLICT")
  returnForChanges(
    @Param("id", uuid) id: string,
    @Body() body: ModerationReasonDto,
    @Req() req: AuthedRequest,
  ): Promise<ModerationCaseDto> {
    return this.moderation.decide(
      userOf(req),
      id,
      { decision: "changes_requested", comment: body.reason },
      auditFromRequest(req),
    );
  }
}
