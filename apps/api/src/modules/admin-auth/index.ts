// Публичный интерфейс контекста admin-auth (блок 3, ADR-0018): вход админа, учётки, создание из CLI.
export { ADMIN_LOGIN_RATE_LIMIT, AdminAuthController, AdminLoginDto } from "./admin-auth.controller.js";
export { AdminAuthModule } from "./admin-auth.module.js";
export {
  ADMIN_AUTH_AUDIT,
  ADMIN_CREDENTIAL_ENTITY,
  ADMIN_LOCK_MINUTES,
  ADMIN_LOGIN_RE,
  ADMIN_MAX_FAILED_ATTEMPTS,
  AdminAuthService,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILED_ATTEMPTS,
  normalizeLogin,
} from "./admin-auth.service.js";
export {
  AdminCredentialsRepository,
  PAIR_LOCK_MINUTES,
  PAIR_MAX_FAILED_ATTEMPTS,
  type CredentialForLogin,
  type FailureResult,
} from "./admin-credentials.repository.js";
export {
  ADMIN_CLI_ROLES,
  AdminCreateError,
  assertPassword,
  createAdmin,
  parseAdminCreateArgs,
  type AdminCliRole,
  type AdminCreateArgs,
  type AdminCreated,
} from "./admin-create.js";
export {
  DEFAULT_SCRYPT,
  hashPassword,
  isAcceptablePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyDummy,
  verifyPassword,
  warmUpDummy,
  type ScryptParams,
} from "./password-hash.js";
export { hasSupportedMfa, SUPPORTED_MFA_METHODS } from "./mfa.js";
