import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";
import { ApiError, ApiErrors } from "../../common/http/index.js";
import { WithoutTenantContext } from "../../common/tenancy/index.js";
import {
  IssuedSessionDto,
  RequireAuth,
  requestMeta,
  SessionService,
  toSessionDto,
  type AuthRequest,
} from "../auth/index.js";
import { RateLimit } from "../rate-limit/index.js";
import { PASSWORD_MAX_LENGTH } from "./password-hash.js";
import { AdminAuthService } from "./admin-auth.service.js";

/**
 * Лимит входа на IP (без сессии): вместе с блокировкой пары «логин + адрес» после 5 неудач — защита от перебора паролей и
 * от перебора логинов по многим учёткам.
 */
export const ADMIN_LOGIN_RATE_LIMIT = { limit: 10, windowSec: 60 } as const;

export class AdminLoginDto {
  @ApiProperty({ type: String, minLength: 3, maxLength: 254, example: "admin@example.com" })
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  login!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: PASSWORD_MAX_LENGTH, format: "password" })
  @IsString()
  @MinLength(1)
  // Верхняя граница — чтобы длинная строка не стоила лишнего scrypt.
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

/**
 * Вход в веб-админку (блок 3, ADR-0018): логин + пароль → сессия channel=admin_web (Bearer, как у Mini App).
 * Без tenant-контекста: вход не принадлежит региону; регион режима выбирается потом `PUT /auth/session/region`.
 * 2FA (D-52) отложена тестовым режимом — ADR-0018.
 */
@ApiTags("auth")
@Controller("auth/admin")
@WithoutTenantContext()
export class AdminAuthController {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Post("login")
  @RateLimit(ADMIN_LOGIN_RATE_LIMIT)
  @ApiOperation({
    operationId: "loginAdmin",
    summary: "Вход админа по логину и паролю: новая сессия admin_web",
    description:
      "Неизвестный логин, неверный пароль, блокировка и неактивный пользователь — одинаковый 401 " +
      "(errors.auth.invalidCredentials). 5 неудач за 15 минут с одного адреса — вход с него закрыт на 15 минут; " +
      "50 неудач за час со всех адресов — учётка заперта на 15 минут. " +
      `Rate limit ${ADMIN_LOGIN_RATE_LIMIT.limit}/мин на IP. Учётка с 2FA (D-52 ещё не реализована) — тоже 401.`,
  })
  @ApiCreatedResponse({ type: IssuedSessionDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHENTICATED", "RATE_LIMITED")
  async login(@Req() req: AuthRequest, @Body() body: AdminLoginDto): Promise<IssuedSessionDto> {
    const { token, session } = await this.auth.login({
      login: body.login,
      password: body.password,
      meta: requestMeta(req),
    });
    return { token, session: toSessionDto(session, await this.sessions.grantsOf(session.user_id)) };
  }

  @Post("logout")
  @HttpCode(204)
  @RequireAuth()
  @ApiOperation({ operationId: "logoutAdmin", summary: "Выход админа: отзыв текущей сессии" })
  @ApiNoContentResponse({ description: "Сессия отозвана" })
  @ApiErrors("UNAUTHENTICATED")
  async logout(@Req() req: AuthRequest): Promise<void> {
    const principal = req.principal;
    if (!principal?.sessionId) throw new ApiError("UNAUTHENTICATED");
    await this.sessions.revoke({
      sessionId: principal.sessionId,
      userId: principal.userId,
      meta: requestMeta(req),
    });
  }
}
