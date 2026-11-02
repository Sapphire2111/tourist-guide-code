import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { AppEnv } from "@tg/server-config";
import { AuditModule } from "../audit/index.js";
import { AUTHENTICATION_PRINCIPAL_SOURCE, RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import { UsersModule } from "../users/index.js";
import { AuthController } from "./auth.controller.js";
import { DevAuthController } from "./dev-auth.controller.js";
import { RiskFlagsRepository } from "./risk-flags.repository.js";
import { SessionPrincipalSource } from "./session-principal.source.js";
import { DEFAULT_SESSION_TTL_HOURS, SESSION_TTL_SECONDS, SessionService } from "./session.service.js";
import { SessionsRepository } from "./sessions.repository.js";
import { TelegramAuthController } from "./telegram-auth.controller.js";
import { TELEGRAM_AUTH_OPTIONS, TelegramAuthService } from "./telegram-auth.service.js";
import { DEFAULT_INIT_DATA_MAX_AGE_HOURS } from "./telegram-init-data.js";

export type AuthModuleOptions = {
  /** Окружение (APP_ENV); по умолчанию local. */
  appEnv?: AppEnv;
  /** Dev-вход `POST /auth/dev/sessions` — только при appEnv=local, иначе ошибка при сборке модуля. */
  devLogin?: boolean;
  /** Срок жизни сессии, часов (AUTH_SESSION_TTL_HOURS); по умолчанию DEFAULT_SESSION_TTL_HOURS. */
  sessionTtlHours?: number;
  /** Токен бота (TELEGRAM_BOT_TOKEN) для проверки initData; не задан — POST /auth/telegram отвечает 503. */
  telegramBotToken?: string;
  /** Максимальный возраст initData, часов (TELEGRAM_INIT_DATA_MAX_AGE_HOURS); по умолчанию 24. */
  initDataMaxAgeHours?: number;
};

/**
 * Аутентификация (T1-26, ADR-0009): сессии с непрозрачным токеном (Bearer), источник принципала для RBAC
 * (AUTHENTICATION_PRINCIPAL_SOURCE → PRINCIPAL_SOURCE в RbacModule), API текущей сессии, вход через Telegram
 * (POST /auth/telegram, блок 2), dev-вход для local.
 * Глобальный: RbacModule берёт источник принципала необязательной зависимостью, не импортируя этот модуль.
 * Подключается один раз в AppModule; нужен DatabaseModule (глобальный).
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(opts: AuthModuleOptions = {}): DynamicModule {
    const appEnv = opts.appEnv ?? "local";
    if (opts.devLogin && appEnv !== "local")
      throw new Error(`Dev-вход разрешён только при APP_ENV=local, сейчас APP_ENV=${appEnv}`);
    const ttlHours = opts.sessionTtlHours ?? DEFAULT_SESSION_TTL_HOURS;
    return {
      module: AuthModule,
      global: true,
      imports: [RbacModule, AuditModule, UsersModule, RegionsModule],
      controllers: opts.devLogin
        ? [AuthController, TelegramAuthController, DevAuthController]
        : [AuthController, TelegramAuthController],
      providers: [
        SessionsRepository,
        SessionService,
        SessionPrincipalSource,
        RiskFlagsRepository,
        TelegramAuthService,
        {
          provide: TELEGRAM_AUTH_OPTIONS,
          useValue: {
            botToken: opts.telegramBotToken || undefined,
            maxAgeSec: Math.round((opts.initDataMaxAgeHours ?? DEFAULT_INIT_DATA_MAX_AGE_HOURS) * 3600),
          },
        },
        { provide: AUTHENTICATION_PRINCIPAL_SOURCE, useExisting: SessionPrincipalSource },
        { provide: SESSION_TTL_SECONDS, useValue: Math.round(ttlHours * 3600) },
      ],
      exports: [AUTHENTICATION_PRINCIPAL_SOURCE, SessionService, SessionsRepository],
    };
  }
}
