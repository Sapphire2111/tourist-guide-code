import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ENABLED_LOCALES, resolveLocale } from "@tg/i18n";
import type { AnalyticsEvent, AnalyticsSource } from "@tg/shared";
import { ApiError } from "../../common/http/index.js";
import { InjectDb, SYSTEM_CONTEXT, withTenant, type Db, type Session, type User } from "../../db/index.js";
import { AnalyticsService } from "../analytics/index.js";
import { AuditService } from "../audit/index.js";
import { TelegramAccountsRepository, UsersRepository } from "../users/index.js";
import { RiskFlagsRepository } from "./risk-flags.repository.js";
import { SessionError, SessionService, type RequestMeta } from "./session.service.js";
import {
  InitDataError,
  validateInitData,
  type TelegramInitUser,
  type ValidatedInitData,
} from "./telegram-init-data.js";

/** Настройки входа через Telegram (AuthModule.forRoot). */
export type TelegramAuthOptions = {
  /** TELEGRAM_BOT_TOKEN; не задан — вход отвечает 503 (local без бота). */
  readonly botToken?: string;
  /** Максимальный возраст initData (auth_date), секунд. */
  readonly maxAgeSec: number;
};

export const TELEGRAM_AUTH_OPTIONS = Symbol("TELEGRAM_AUTH_OPTIONS");

export const CLIENT_PLATFORMS = ["ios", "android", "web", "desktop", "unknown"] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

export type TelegramLoginResult = {
  readonly token: string;
  readonly session: Session;
  readonly user: User;
  readonly isNewUser: boolean;
  readonly startParam: string | null;
};

const UNIQUE_VIOLATION = "23505";

/**
 * Вход через Telegram (блок 2, ADR-0015): initData → проверка подписи и срока → User + TelegramAccount (создание при
 * первом входе, обновление полей Telegram при повторном) → сессия channel=mini_app через SessionService.issue().
 * Отказ — 401 UNAUTHENTICATED, RiskFlag и строка лога только с кодом причины (initData — ПДн, не логируется).
 * События: registration_completed (первый вход), app_opened (каждый вход) — сбой аналитики вход не ломает.
 */
@Injectable()
export class TelegramAuthService {
  private readonly logger = new Logger("Auth");

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(TELEGRAM_AUTH_OPTIONS) private readonly options: TelegramAuthOptions,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(TelegramAccountsRepository) private readonly accounts: TelegramAccountsRepository,
    @Inject(RiskFlagsRepository) private readonly riskFlags: RiskFlagsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(AnalyticsService) private readonly analytics?: AnalyticsService,
  ) {
    if (!Number.isInteger(options.maxAgeSec) || options.maxAgeSec < 60)
      throw new Error(`Срок initData — целое число секунд ≥ 60, получено ${options.maxAgeSec}`);
  }

  async login(input: {
    initData: string;
    platform?: ClientPlatform;
    meta?: RequestMeta;
  }): Promise<TelegramLoginResult> {
    const botToken = this.options.botToken;
    if (!botToken) throw new ApiError("SERVICE_UNAVAILABLE");
    let data: ValidatedInitData;
    try {
      data = validateInitData(input.initData, botToken, { maxAgeSec: this.options.maxAgeSec });
    } catch (err) {
      if (err instanceof InitDataError) await this.reject(err, input.meta);
      throw err;
    }

    const { user, created } = await this.upsertUser(data, input.meta);
    let issued;
    try {
      issued = await this.sessions.issue({ userId: user.id, channel: "mini_app", meta: input.meta });
    } catch (err) {
      // Заблокированный (или анонимизированный в гонке) пользователь: личность подтверждена, но вход запрещён.
      if (err instanceof SessionError && err.reason === "user_not_active")
        throw new ApiError("FORBIDDEN", { messageKey: "errors.auth.userBlocked", cause: err });
      throw err;
    }
    if (created) this.logger.log(`Регистрация через Telegram: user=${user.id}`);
    await this.emitEvents({
      user,
      sessionId: issued.session.id,
      created,
      platform: input.platform,
      source: data.startParam ? "deep_link" : "direct",
    });
    return {
      token: issued.token,
      session: issued.session,
      user,
      isNewUser: created,
      startParam: data.startParam,
    };
  }

  /** Пользователь по Telegram id: найти и обновить поля Telegram или создать (с аудитом регистрации). */
  private async upsertUser(
    data: ValidatedInitData,
    meta: RequestMeta | undefined,
    retry = true,
  ): Promise<{ user: User; created: boolean }> {
    try {
      return await withTenant(this.db, SYSTEM_CONTEXT, async (trx) => {
        const tg = data.user;
        const existing = await this.accounts.findByTelegramUserId(tg.id);
        if (existing) {
          await this.accounts.update(existing.id, { ...telegramFields(tg), last_auth_date: data.authDate });
          const user = await this.users.findById(existing.user_id);
          if (!user) throw new Error(`telegram_accounts без users: ${existing.id}`);
          return { user, created: false };
        }
        const user = await this.users.create({
          language: resolveLocale(tg.languageCode, ENABLED_LOCALES),
          display_name: displayNameOf(tg),
        });
        await this.accounts.create({
          user_id: user.id,
          telegram_user_id: tg.id,
          ...telegramFields(tg),
          last_auth_date: data.authDate,
        });
        await this.audit.record(trx, {
          actor: { type: "user", userId: user.id },
          action: "user.register",
          entityType: "user",
          entityId: user.id,
          newValues: { method: "telegram", language: user.language },
          requestId: meta?.requestId ?? null,
          pii: { ip: meta?.ip, userAgent: meta?.userAgent },
        });
        return { user, created: true };
      });
    } catch (err) {
      // Параллельный первый вход того же пользователя: второй запрос упирается в уникальный telegram_user_id —
      // транзакция откатилась (лишнего users нет), повторяем: теперь аккаунт найдётся.
      if (retry && (err as { code?: unknown }).code === UNIQUE_VIOLATION)
        return this.upsertUser(data, meta, false);
      throw err;
    }
  }

  /** Отказ во входе: RiskFlag (без ПДн) и предупреждение в лог; ответ — 401 в едином конверте. */
  private async reject(err: InitDataError, meta: RequestMeta | undefined): Promise<never> {
    const expired = err.reason === "expired" || err.reason === "from_future";
    let flagId: string | undefined;
    try {
      flagId = await withTenant(this.db, SYSTEM_CONTEXT, async () => {
        const account =
          err.telegramUserId !== undefined
            ? await this.accounts.findByTelegramUserId(err.telegramUserId)
            : undefined;
        const flag = await this.riskFlags.create({
          kind: expired ? "expired_init_data" : "invalid_init_data",
          severity: err.reason === "bad_signature" ? "medium" : "low",
          user_id: account?.user_id ?? null,
          details: { reason: err.reason, signatureValid: err.telegramUserId !== undefined },
          request_id: meta?.requestId ?? null,
        });
        return flag.id;
      });
    } catch (e) {
      // Без записи признака вход всё равно отклоняется; в лог — только тип ошибки.
      this.logger.error(`RiskFlag не записан: ${(e as Error).name}`);
    }
    this.logger.warn(
      `Вход Telegram отклонён: reason=${err.reason} riskFlag=${flagId ?? "-"} correlationId=${meta?.requestId ?? "-"}`,
    );
    throw new ApiError("UNAUTHENTICATED", { messageKey: "errors.auth.invalidInitData", cause: err });
  }

  private async emitEvents(e: {
    user: User;
    sessionId: string;
    created: boolean;
    platform?: ClientPlatform;
    source: AnalyticsSource;
  }): Promise<void> {
    if (!this.analytics) return;
    const envelope = {
      schemaVersion: 1 as const,
      occurredAt: new Date().toISOString(),
      pseudonymousUserId: e.user.analytics_id,
      sessionId: e.sessionId,
      regionId: null,
      source: e.source,
    };
    const events: AnalyticsEvent[] = [];
    if (e.created)
      events.push({
        ...envelope,
        eventId: randomUUID(),
        event: "registration_completed",
        props: { method: "telegram" },
      });
    events.push({
      ...envelope,
      eventId: randomUUID(),
      event: "app_opened",
      props: e.platform ? { platform: e.platform } : {},
    });
    for (const event of events) {
      try {
        await this.analytics.emit(event);
      } catch (err) {
        this.logger.warn(`Событие ${event.event} не записано: ${(err as Error).message}`);
      }
    }
  }
}

/** Поля Telegram из initData для telegram_accounts. */
function telegramFields(tg: TelegramInitUser) {
  return {
    username: tg.username,
    first_name: tg.firstName,
    last_name: tg.lastName,
    language_code: tg.languageCode,
    photo_url: tg.photoUrl,
    is_premium: tg.isPremium,
    allows_write_to_pm: tg.allowsWriteToPm,
  };
}

/** Имя отображения из Telegram: «Имя Фамилия», иначе username; до 64 символов (CHECK users_display_name_check). */
export function displayNameOf(
  tg: Pick<TelegramInitUser, "firstName" | "lastName" | "username">,
): string | null {
  const full = [tg.firstName, tg.lastName].filter(Boolean).join(" ").trim() || tg.username || "";
  const cut = [...full].slice(0, 64).join("").trim();
  return cut.length > 0 ? cut : null;
}
