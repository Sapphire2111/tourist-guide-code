import { Body, Controller, Inject, Post, Req } from "@nestjs/common";
import { ApiCreatedResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { IssuedSessionDto, toSessionDto } from "./auth.dto.js";
// DevLoginDto нужен в рантайме: emitDecoratorMetadata передаёт класс в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DevLoginDto } from "./auth.dto.js";
import { requestMeta, type AuthRequest } from "./request-meta.js";
import { SessionError, SessionService } from "./session.service.js";

/**
 * Dev-вход (T1-26): сессия существующему активному пользователю без проверки личности — для local, e2e и ручной
 * проверки до входа через Telegram (блок 2). Регистрируется, только если AuthModule.forRoot({ devLogin: true }),
 * а это допускается лишь при APP_ENV=local (проверка конфига и модуля); в OpenAPI-контракт не входит.
 */
@ApiTags("auth-dev")
@Controller("auth/dev/sessions")
@WithoutTenantContext()
export class DevAuthController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  @Post()
  @ApiOperation({ operationId: "devLogin", summary: "Dev-вход: сессия пользователю (только local)" })
  @ApiCreatedResponse({ type: IssuedSessionDto })
  @ApiErrors("VALIDATION_FAILED", "NOT_FOUND", "FORBIDDEN")
  async login(@Req() req: AuthRequest, @Body() body: DevLoginDto): Promise<IssuedSessionDto> {
    try {
      const { token, session } = await this.sessions.issue({
        userId: body.userId,
        channel: "dev",
        activeRegionId: body.regionId ?? null,
        meta: requestMeta(req),
      });
      return { token, session: toSessionDto(session, await this.sessions.grantsOf(session.user_id)) };
    } catch (err) {
      if (err instanceof SessionError)
        // region_not_allowed — 403; нет пользователя/не active или нет региона — 404.
        throw new ApiError(err.reason === "region_not_allowed" ? "FORBIDDEN" : "NOT_FOUND", { cause: err });
      throw err;
    }
  }
}
