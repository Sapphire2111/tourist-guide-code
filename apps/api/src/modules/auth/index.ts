// Публичный интерфейс контекста auth (T1-26): сессии, источник принципала, @RequireAuth.
export { AuthModule, type AuthModuleOptions } from "./auth.module.js";
export { IssuedSessionDto, SessionDto, TelegramLoginResponseDto, toSessionDto } from "./auth.dto.js";
export { RiskFlagsRepository } from "./risk-flags.repository.js";
export {
  CLIENT_PLATFORMS,
  TELEGRAM_AUTH_OPTIONS,
  TelegramAuthService,
  type ClientPlatform,
  type TelegramAuthOptions,
} from "./telegram-auth.service.js";
export {
  DEFAULT_INIT_DATA_MAX_AGE_HOURS,
  InitDataError,
  signInitDataFields,
  validateInitData,
  type InitDataRejection,
  type TelegramInitUser,
  type ValidatedInitData,
} from "./telegram-init-data.js";
export { requestMeta, type AuthRequest } from "./request-meta.js";
export { RequireAuth, RequireAuthGuard } from "./require-auth.guard.js";
export { SessionPrincipalSource } from "./session-principal.source.js";
export { bearerToken, generateSessionToken, hashSessionToken, isSessionToken } from "./session-token.js";
export {
  DEFAULT_SESSION_TTL_HOURS,
  SESSION_TTL_SECONDS,
  SessionError,
  SessionService,
  type IssuedSession,
  type RequestMeta,
} from "./session.service.js";
export { SessionsRepository, type ActiveSession } from "./sessions.repository.js";
