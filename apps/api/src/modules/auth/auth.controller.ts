import { Body, Controller, Delete, Get, HttpCode, Inject, Put, Req } from "@nestjs/common";
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { ErrorCode } from "@tg/shared";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import type { Principal } from "../rbac/index.js";
import { SessionDto, toSessionDto } from "./auth.dto.js";
// SelectRegionDto нужен в рантайме: emitDecoratorMetadata передаёт класс в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SelectRegionDto } from "./auth.dto.js";
import { requestMeta, type AuthRequest } from "./request-meta.js";
import { RequireAuth } from "./require-auth.guard.js";
import { SessionError, SessionService } from "./session.service.js";

/**
 * Текущая сессия (T1-26): кто я и какие роли, выход, выбор региона режима партнёра/админа. Без tenant-контекста
 * (@WithoutTenantContext): выход и смена региона должны работать, даже когда выбранный регион больше не разрешён
 * (иначе — 403 на любом запросе).
 */
@ApiTags("auth")
@Controller("auth/session")
@RequireAuth()
@WithoutTenantContext()
export class AuthController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  @Get()
  @ApiOperation({ operationId: "getSession", summary: "Текущая сессия и роли пользователя" })
  @ApiOkResponse({ type: SessionDto })
  @ApiErrors("UNAUTHENTICATED")
  async get(@Req() req: AuthRequest): Promise<SessionDto> {
    const principal = principalOf(req);
    const session = await this.sessions.find(principal.sessionId, principal.userId);
    if (!session) throw new ApiError("UNAUTHENTICATED");
    return toSessionDto(session, await this.sessions.grantsOf(principal.userId));
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ operationId: "deleteSession", summary: "Выход: отзыв текущей сессии" })
  @ApiNoContentResponse({ description: "Сессия отозвана" })
  @ApiErrors("UNAUTHENTICATED")
  async delete(@Req() req: AuthRequest): Promise<void> {
    const principal = principalOf(req);
    await this.sessions.revoke({
      sessionId: principal.sessionId,
      userId: principal.userId,
      meta: requestMeta(req),
    });
  }

  @Put("region")
  @ApiOperation({
    operationId: "selectSessionRegion",
    summary: "Выбор региона режима партнёра/админа (только регион с назначением роли или PLATFORM)",
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND")
  async selectRegion(@Req() req: AuthRequest, @Body() body: SelectRegionDto): Promise<SessionDto> {
    const principal = principalOf(req);
    try {
      const session = await this.sessions.selectRegion({
        sessionId: principal.sessionId,
        userId: principal.userId,
        regionId: body.regionId,
      });
      return toSessionDto(session, await this.sessions.grantsOf(principal.userId));
    } catch (err) {
      if (err instanceof SessionError) throw new ApiError(SELECT_REGION_ERRORS[err.reason], { cause: err });
      throw err;
    }
  }
}

/** Код ошибки смены региона: нет права — 403, нет региона — 404, сессии нет (отозвана в гонке) — 401. */
const SELECT_REGION_ERRORS = {
  region_not_allowed: "FORBIDDEN",
  region_not_found: "NOT_FOUND",
  not_found: "UNAUTHENTICATED",
  user_not_active: "UNAUTHENTICATED",
} as const satisfies Record<SessionError["reason"], ErrorCode>;

/** Принципал из сессии (RequireAuth гарантирует его наличие; sessionId есть у принципала SessionPrincipalSource). */
function principalOf(req: AuthRequest): Principal & { sessionId: string } {
  const principal = req.principal;
  if (!principal?.sessionId) throw new ApiError("UNAUTHENTICATED");
  return { ...principal, sessionId: principal.sessionId };
}
