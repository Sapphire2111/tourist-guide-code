import { createHmac } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import {
  InjectDb,
  setLocalLockTimeout,
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
  type JsonObject,
} from "../../db/index.js";
import { AuditService } from "../audit/index.js";
import { SessionError, SessionService, type IssuedSession, type RequestMeta } from "../auth/index.js";
import { clientIpKey } from "../rate-limit/index.js";
import {
  AdminCredentialsRepository,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILED_ATTEMPTS,
  PAIR_LOCK_MINUTES,
  PAIR_MAX_FAILED_ATTEMPTS,
  type CredentialForLogin,
} from "./admin-credentials.repository.js";
import { verifyDummy, verifyPassword, warmUpDummy } from "./password-hash.js";

/** Неудач подряд с одного адреса до блокировки пары и её срок (ADR-0018). */
export const ADMIN_MAX_FAILED_ATTEMPTS = PAIR_MAX_FAILED_ATTEMPTS;
export const ADMIN_LOCK_MINUTES = PAIR_LOCK_MINUTES;
export { LOGIN_LOCK_MINUTES, LOGIN_MAX_FAILED_ATTEMPTS };

/** Сколько короткая транзакция записи счётчиков ждёт чужую блокировку строки. */
const LOCK_TIMEOUT_MS = 2000;

/** Коды действий аудита входа админа. */
export const ADMIN_AUTH_AUDIT = {
  login: "auth.admin.login",
  failed: "auth.admin.login_failed",
  locked: "auth.admin.locked",
} as const;
export const ADMIN_CREDENTIAL_ENTITY = "admin_credential";

/** Логин: нижний регистр, без пробелов по краям (как CHECK admin_credentials_login_format). */
export const ADMIN_LOGIN_RE = /^[a-z0-9][a-z0-9._@+-]{2,253}$/;

export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** Ключ HMAC псевдонимов для local/test (в staging/prod конфиг требует ADMIN_LOGIN_HMAC_SECRET). */
export const DEV_LOGIN_HMAC_SECRET = "local-dev-admin-login-hmac-secret-not-for-prod";

export type AdminAuthOptions = { readonly loginHmacSecret: string };
export const ADMIN_AUTH_OPTIONS = Symbol("ADMIN_AUTH_OPTIONS");

type FailureReason = "unknown_login" | "invalid_password" | "locked" | "user_inactive" | "mfa_not_supported";
type Attempt = { ok: true; credential: CredentialForLogin } | { ok: false; reason: FailureReason };

/**
 * Вход в админку по логину и паролю (блок 3, ADR-0018) → сессия channel=admin_web через SessionService.
 * Ответ на «нет логина», «неверный пароль», «заблокировано» и «пользователь не активен» одинаковый
 * (401 errors.auth.invalidCredentials); scrypt выполняется всегда, вне транзакции. Блокировка: 5 неудач за 15 минут
 * по паре «логин + адрес клиента» — на 15 минут; 50 неудач за час по логину со всех адресов — блокировка учётки на
 * 15 минут. Счётчики меняются атомарно в короткой транзакции с lock_timeout. Каждая попытка — запись аудита (без
 * пароля и логина; ПДн-часть — IP и user agent со сроком D-73). 2FA (D-52) отложена: учётка с mfa_method не входит.
 */
@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger("AdminAuth");

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(AdminCredentialsRepository) private readonly credentials: AdminCredentialsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ADMIN_AUTH_OPTIONS) private readonly options: AdminAuthOptions,
  ) {}

  /** Псевдоним (HMAC-SHA256 с серверным ключом): без ключа по таблице не перебрать логины и адреса. */
  private pseudonym(kind: "login" | "client", value: string): Buffer {
    return createHmac("sha256", this.options.loginHmacSecret).update(`${kind}:${value}`, "utf8").digest();
  }

  /** Фиктивный хэш — при старте: первая попытка с несуществующим логином не дольше остальных. */
  async onModuleInit(): Promise<void> {
    await warmUpDummy();
  }

  async login(input: { login: string; password: string; meta?: RequestMeta }): Promise<IssuedSession> {
    const attempt = await this.attempt(normalizeLogin(input.login), input.password, input.meta);
    if (!attempt.ok) {
      // Любой отказ — один ответ (в том числе 2FA, которой ещё нет): причина — только в аудите и логе.
      this.logger.warn(`Вход админа отклонён: reason=${attempt.reason}`);
      throw invalidCredentials();
    }
    try {
      const issued = await this.sessions.issue({
        userId: attempt.credential.user_id,
        channel: "admin_web",
        meta: input.meta,
      });
      this.logger.log(`Вход админа: user=${attempt.credential.user_id} session=${issued.session.id}`);
      return issued;
    } catch (err) {
      // Пользователя заблокировали между проверкой и выдачей сессии — тот же ответ, что на неверный пароль.
      if (err instanceof SessionError && err.reason === "user_not_active") throw invalidCredentials(err);
      throw err;
    }
  }

  private async attempt(login: string, password: string, meta: RequestMeta | undefined): Promise<Attempt> {
    const loginHash = this.pseudonym("login", login);
    const clientHash = this.pseudonym("client", clientIpKey(meta?.ip ?? undefined));
    // Чтение без блокировки и без транзакции: scrypt ниже не держит соединение пула.
    const { credential: cred, pair } = await this.credentials.lookup(login, loginHash, clientHash);
    const now = new Date();
    const lockedUntil = [pair?.locked_until, cred?.locked_until].find((d) => d && d > now);
    if (lockedUntil) {
      await verifyDummy(password);
      // Попытка в блокировке не считается (иначе один адрес набрал бы глобальный порог чужой учётки).
      return this.write((trx) => this.failed(trx, "locked", cred, meta, {}));
    }
    const valid = cred ? await verifyPassword(password, cred.password_hash) : await verifyDummy(password);
    if (!cred || !valid) {
      const reason = cred ? "invalid_password" : "unknown_login";
      const result = await this.write(async (trx) => {
        const res = await this.credentials.recordFailure(login, loginHash, clientHash);
        if (res.pairLocked) await this.locked(trx, cred, meta, "login_client", PAIR_LOCK_MINUTES);
        if (res.loginLocked) await this.locked(trx, cred, meta, "login", LOGIN_LOCK_MINUTES);
        return this.failed(trx, reason, cred, meta, { failedAttempts: res.pairAttempts });
      });
      await this.purgeStale();
      return result;
    }
    // Пароль верный, но пользователь не активен: тот же 401, без записи успешного входа.
    if (cred.user_status !== "active")
      return this.write((trx) => this.failed(trx, "user_inactive", cred, meta, {}));
    if (cred.mfa_method !== null)
      return this.write((trx) =>
        this.failed(trx, "mfa_not_supported", cred, meta, { mfaMethod: cred.mfa_method }),
      );
    return this.write(async (trx) => {
      // Блокировка могла сработать между чтением и scrypt (параллельная неудача) — проверка заново, под блокировкой строк.
      if (!(await this.credentials.recordSuccess(cred.id, loginHash, clientHash)))
        return this.failed(trx, "locked", cred, meta, {});
      await this.audit.record(trx, {
        actor: { type: "user", userId: cred.user_id },
        action: ADMIN_AUTH_AUDIT.login,
        entityType: ADMIN_CREDENTIAL_ENTITY,
        entityId: cred.id,
        newValues: { channel: "admin_web" },
        requestId: meta?.requestId ?? null,
        pii: { ip: meta?.ip, userAgent: meta?.userAgent },
      });
      return { ok: true, credential: cred };
    });
  }

  /**
   * Очистка устаревших счётчиков пар — отдельным оператором после транзакции попытки, не больше 100 строк, занятые
   * строки пропускаются. Сбой очистки вход не ломает.
   */
  private async purgeStale(): Promise<void> {
    try {
      await this.credentials.purgeStaleFailures(100);
    } catch (err) {
      this.logger.warn(`Очистка admin_login_failures не удалась: ${(err as Error).message}`);
    }
  }

  /** Короткая транзакция SYSTEM с lock_timeout: счётчики и аудит; коммитится и при отказе во входе. */
  private write(fn: (trx: Db) => Promise<Attempt>): Promise<Attempt> {
    return withTenant(this.db, SYSTEM_CONTEXT, async (trx) => {
      await setLocalLockTimeout(trx, LOCK_TIMEOUT_MS);
      return fn(trx);
    });
  }

  private async failed(
    trx: Db,
    reason: FailureReason,
    cred: CredentialForLogin | undefined,
    meta: RequestMeta | undefined,
    extra: JsonObject,
  ): Promise<Attempt> {
    await this.audit.record(trx, {
      actor: { type: "system" },
      action: ADMIN_AUTH_AUDIT.failed,
      entityType: ADMIN_CREDENTIAL_ENTITY,
      entityId: cred?.id ?? null,
      newValues: { reason, ...extra },
      requestId: meta?.requestId ?? null,
      pii: { ip: meta?.ip, userAgent: meta?.userAgent },
    });
    return { ok: false, reason };
  }

  /** scope: login_client — пара «логин + адрес», login — учётка целиком. Для несуществующего логина entityId null. */
  private async locked(
    trx: Db,
    cred: CredentialForLogin | undefined,
    meta: RequestMeta | undefined,
    scope: "login_client" | "login",
    minutes: number,
  ): Promise<void> {
    await this.audit.record(trx, {
      actor: { type: "system" },
      action: ADMIN_AUTH_AUDIT.locked,
      entityType: ADMIN_CREDENTIAL_ENTITY,
      entityId: cred?.id ?? null,
      newValues: { scope, minutes },
      requestId: meta?.requestId ?? null,
      pii: { ip: meta?.ip, userAgent: meta?.userAgent },
    });
    this.logger.warn(
      `Вход админа заблокирован на ${minutes} мин: scope=${scope} credential=${cred?.id ?? "-"}`,
    );
  }
}

function invalidCredentials(cause?: unknown): ApiError {
  return new ApiError("UNAUTHENTICATED", { messageKey: "errors.auth.invalidCredentials", cause });
}
