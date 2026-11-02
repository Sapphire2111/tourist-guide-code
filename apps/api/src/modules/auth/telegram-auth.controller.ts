import { Body, Controller, Inject, Post, Req } from "@nestjs/common";
import { ApiCreatedResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import { RateLimit } from "../rate-limit/index.js";
import { TelegramLoginResponseDto, toSessionDto } from "./auth.dto.js";
// TelegramLoginDto нужен в рантайме: emitDecoratorMetadata передаёт класс в ValidationPipe (import type сломает валидацию).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TelegramLoginDto } from "./auth.dto.js";
import { requestMeta, type AuthRequest } from "./request-meta.js";
import { SessionService } from "./session.service.js";
import { TelegramAuthService } from "./telegram-auth.service.js";

/** Лимит входа на IP (без сессии): перебор initData и засорение risk_flags; запас на общий Wi-Fi отеля. */
export const TELEGRAM_LOGIN_RATE_LIMIT = { limit: 30, windowSec: 60 } as const;

/**
 * Вход через Telegram (блок 2, ADR-0015): Mini App при каждом запуске передаёт initData и получает новую сессию.
 * Без tenant-контекста: вход не принадлежит региону (сессия, пользователь — global).
 */
@ApiTags("auth")
@Controller("auth/telegram")
@WithoutTenantContext()
export class TelegramAuthController {
  constructor(
    @Inject(TelegramAuthService) private readonly telegram: TelegramAuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Post()
  @RateLimit(TELEGRAM_LOGIN_RATE_LIMIT)
  @ApiOperation({
    operationId: "loginTelegram",
    summary: "Вход по initData Telegram Mini App: проверка подписи и срока, пользователь, новая сессия",
  })
  @ApiCreatedResponse({ type: TelegramLoginResponseDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED", "SERVICE_UNAVAILABLE")
  async login(@Req() req: AuthRequest, @Body() body: TelegramLoginDto): Promise<TelegramLoginResponseDto> {
    const result = await this.telegram.login({
      initData: body.initData,
      platform: body.platform,
      meta: requestMeta(req),
    });
    return {
      token: result.token,
      session: toSessionDto(result.session, await this.sessions.grantsOf(result.user.id)),
      isNewUser: result.isNewUser,
      startParam: result.startParam,
    };
  }
}
