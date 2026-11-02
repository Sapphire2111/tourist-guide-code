import { Inject, Injectable } from "@nestjs/common";
import type { Locale } from "@tg/i18n";
import { ApiError } from "../../common/http/index.js";
import {
  hasValues,
  InjectDb,
  SYSTEM_CONTEXT,
  withTenant,
  type ConsentKind,
  type Db,
  type MessagingConsent,
  type MessagingPurpose,
  type PrivacyRequest,
  type PrivacyRequestKind,
  type User,
  type Consent,
} from "../../db/index.js";
import { AuditService } from "../audit/index.js";
import type { RequestMeta } from "../auth/index.js";
import { TelegramAccountsRepository, UsersRepository } from "../users/index.js";
import { toMeDto, type MeDto } from "./profile.dto.js";
import {
  ConsentsRepository,
  MessagingConsentsRepository,
  PrivacyRequestsRepository,
} from "./profile.repositories.js";

/** Актор запроса: владелец профиля и данные для аудита. */
export type ProfileActor = {
  readonly userId: string;
  readonly sessionId?: string;
  readonly meta?: RequestMeta;
};

/**
 * Профиль текущего пользователя (C15, блок 2): только свои данные (права `*.own` — у любого вошедшего,
 * roles-and-data §1.1: GUEST/USER — неявные роли). Изменения — в одной транзакции с аудитом
 * (withTenant(SYSTEM_CONTEXT): таблицы global, запись аудита — без региона, как у сессий).
 * В аудит — коды и версии, без значений ПДн (имя отображения — только факт изменения).
 */
@Injectable()
export class ProfileService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(TelegramAccountsRepository) private readonly telegram: TelegramAccountsRepository,
    @Inject(ConsentsRepository) private readonly consents: ConsentsRepository,
    @Inject(MessagingConsentsRepository) private readonly messaging: MessagingConsentsRepository,
    @Inject(PrivacyRequestsRepository) private readonly privacy: PrivacyRequestsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async me(userId: string): Promise<MeDto> {
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError("UNAUTHENTICATED");
    const [telegram, consents, messaging, privacy] = await Promise.all([
      this.telegram.findByUserId(userId),
      this.consents.listActive(userId),
      this.messaging.list(userId),
      this.privacy.listOpen(userId),
    ]);
    return toMeDto({ user, telegram, consents, messaging, privacy });
  }

  async update(
    actor: ProfileActor,
    patch: { language?: Locale; displayName?: string | null },
  ): Promise<MeDto> {
    const set = {
      ...(patch.language !== undefined && { language: patch.language }),
      ...(patch.displayName !== undefined && { display_name: patch.displayName }),
    };
    if (hasValues(set))
      await this.inTransaction(async (trx) => {
        const before = await this.users.findById(actor.userId);
        if (!before) throw new ApiError("UNAUTHENTICATED");
        const oldLanguage = before.language;
        const after = (await this.users.update(actor.userId, set)) as User;
        await this.audit.record(trx, {
          ...this.auditBase(actor),
          action: "profile.edit.own",
          entityType: "user",
          entityId: actor.userId,
          oldValues: { language: oldLanguage },
          newValues: {
            language: after.language,
            ...(patch.displayName !== undefined && {
              displayName: after.display_name ? "changed" : "cleared",
            }),
          },
        });
      });
    return this.me(actor.userId);
  }

  /**
   * Принять или отозвать согласие вида и версии. Повторное принятие действующей версии и повторный отзыв ничего не
   * меняют (без аудита) и возвращают текущее состояние; отзыв никогда не принятого — 404.
   */
  async changeConsent(
    actor: ProfileActor,
    input: { kind: ConsentKind; version: string; action: "accept" | "withdraw" },
  ): Promise<Consent> {
    return this.inTransaction(async (trx) => {
      const latest = await this.consents.findLatest(actor.userId, input.kind, input.version);
      let changed: Consent | undefined;
      if (input.action === "accept") {
        if (latest && !latest.withdrawn_at) return latest;
        changed = await this.consents.grant({
          userId: actor.userId,
          kind: input.kind,
          version: input.version,
          channel: "mini_app",
        });
        // Параллельное принятие той же версии: строка уже есть.
        if (!changed)
          return (await this.consents.findLatest(actor.userId, input.kind, input.version)) as Consent;
      } else {
        if (!latest) throw new ApiError("NOT_FOUND");
        if (latest.withdrawn_at) return latest;
        changed = (await this.consents.withdraw(latest.id)) ?? latest;
      }
      await this.audit.record(trx, {
        ...this.auditBase(actor),
        action: "consent.manage.own",
        entityType: "consent",
        entityId: changed.id,
        newValues: { kind: changed.kind, version: changed.document_version, change: input.action },
      });
      return changed;
    });
  }

  /**
   * Разрешение боту писать (ТЗ §11.2): сервисные и маркетинговые — раздельно. Маркетинговые — только при
   * разрешённых сервисных (без доступа к личке бот не напишет вообще); отзыв сервисных отзывает и маркетинговые.
   * Возвращает состояние обоих назначений. Изменения одного пользователя сериализуются блокировкой строки users.
   */
  async changeMessagingConsent(
    actor: ProfileActor,
    input: { purpose: MessagingPurpose; granted: boolean; source: "request_write_access" | "settings" },
  ): Promise<MessagingConsent[]> {
    return this.inTransaction(async (trx) => {
      // Гонка «разрешить marketing» ∥ «отозвать service»: без блокировки первый видит service = true, второй — ещё не
      // записанный marketing, и в итоге marketing разрешён без service. Любое изменение сначала блокирует строку
      // users (одна блокировка, один порядок во всех путях — без взаимоблокировок; есть, даже если строк
      // messaging_consents ещё нет); чтения ниже (READ COMMITTED) видят уже закоммиченное конкурентом.
      if (!(await this.users.lockForUpdate(actor.userId))) throw new ApiError("UNAUTHENTICATED");
      if (input.purpose === "marketing" && input.granted) {
        const service = await this.messaging.find(actor.userId, "service");
        if (!service?.granted)
          throw new ApiError("UNPROCESSABLE", { messageKey: "errors.messaging.serviceConsentRequired" });
      }
      const targets: MessagingPurpose[] =
        input.purpose === "service" && !input.granted ? ["service", "marketing"] : [input.purpose];
      for (const purpose of targets) {
        const before = await this.messaging.find(actor.userId, purpose);
        // Маркетинговых не было — отзывать нечего.
        if (purpose !== input.purpose && !before) continue;
        if (before && before.granted === input.granted) continue;
        const row = await this.messaging.set({
          userId: actor.userId,
          purpose,
          granted: input.granted,
          source: input.source,
        });
        await this.audit.record(trx, {
          ...this.auditBase(actor),
          action: "messaging_consent.manage.own",
          entityType: "messaging_consent",
          entityId: row.id,
          oldValues: before ? { granted: before.granted } : null,
          newValues: { purpose, granted: row.granted, source: row.source },
        });
      }
      return this.messaging.list(actor.userId);
    });
  }

  /** Запрос экспорта/удаления (каркас D-48): статус received; открытый того же вида уже есть — он же, без аудита. */
  async createPrivacyRequest(actor: ProfileActor, kind: PrivacyRequestKind): Promise<PrivacyRequest> {
    return this.inTransaction(async (trx) => {
      const open = await this.privacy.findOpen(actor.userId, kind);
      if (open) return open;
      const created = await this.privacy.create(actor.userId, kind);
      if (!created) return (await this.privacy.findOpen(actor.userId, kind)) as PrivacyRequest;
      await this.audit.record(trx, {
        ...this.auditBase(actor),
        action: "privacy.request.create.own",
        entityType: "privacy_request",
        entityId: created.id,
        newValues: { kind, status: created.status },
      });
      return created;
    });
  }

  private inTransaction<T>(fn: (trx: Db) => Promise<T>): Promise<T> {
    return withTenant(this.db, SYSTEM_CONTEXT, fn);
  }

  private auditBase(actor: ProfileActor) {
    return {
      actor: { type: "user" as const, userId: actor.userId },
      requestId: actor.meta?.requestId ?? null,
      pii: { ip: actor.meta?.ip, userAgent: actor.meta?.userAgent, sessionId: actor.sessionId },
    };
  }
}
