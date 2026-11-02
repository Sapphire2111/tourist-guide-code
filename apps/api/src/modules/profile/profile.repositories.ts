import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  InjectDb,
  type Consent,
  type ConsentChannel,
  type ConsentKind,
  type Db,
  type MessagingConsent,
  type MessagingConsentSource,
  type MessagingPurpose,
  type PrivacyRequest,
  type PrivacyRequestKind,
} from "../../db/index.js";

// Доступ к таблицам профиля (global, миграция 0010). Запросы — через currentDb(): внутри withTenant() это транзакция.

/** consents: append-only, отзыв — withdrawn_at (триггер не даёт менять остальное и отменять отзыв). */
@Injectable()
export class ConsentsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Действующие согласия пользователя (новые первыми). */
  listActive(userId: string): Promise<Consent[]> {
    return currentDb(this.db)
      .selectFrom("consents")
      .selectAll()
      .where("user_id", "=", userId)
      .where("withdrawn_at", "is", null)
      .orderBy("granted_at", "desc")
      .orderBy("id", "desc")
      .execute();
  }

  /** Последняя запись вида и версии (действующая или отозванная). */
  findLatest(userId: string, kind: ConsentKind, version: string): Promise<Consent | undefined> {
    return currentDb(this.db)
      .selectFrom("consents")
      .selectAll()
      .where("user_id", "=", userId)
      .where("kind", "=", kind)
      .where("document_version", "=", version)
      .orderBy("granted_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
  }

  /** Принятие; уже есть действующее той же версии (гонка) — undefined (уникальный частичный индекс). */
  grant(input: {
    userId: string;
    kind: ConsentKind;
    version: string;
    channel: ConsentChannel;
  }): Promise<Consent | undefined> {
    return currentDb(this.db)
      .insertInto("consents")
      .values({
        user_id: input.userId,
        kind: input.kind,
        document_version: input.version,
        channel: input.channel,
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "kind", "document_version"]).where("withdrawn_at", "is", null).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
  }

  /** Отзыв действующего; уже отозванное — undefined. */
  withdraw(id: string): Promise<Consent | undefined> {
    return currentDb(this.db)
      .updateTable("consents")
      .set({ withdrawn_at: sql<Date>`now()` })
      .where("id", "=", id)
      .where("withdrawn_at", "is", null)
      .returningAll()
      .executeTakeFirst();
  }
}

/** messaging_consents: текущее состояние на (пользователь, канал, назначение); история — аудит. */
@Injectable()
export class MessagingConsentsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  list(userId: string): Promise<MessagingConsent[]> {
    return currentDb(this.db)
      .selectFrom("messaging_consents")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("purpose")
      .execute();
  }

  find(userId: string, purpose: MessagingPurpose): Promise<MessagingConsent | undefined> {
    return currentDb(this.db)
      .selectFrom("messaging_consents")
      .selectAll()
      .where("user_id", "=", userId)
      .where("channel", "=", "telegram_bot")
      .where("purpose", "=", purpose)
      .executeTakeFirst();
  }

  /** Установить состояние: granted_at — момент последнего разрешения, withdrawn_at — последнего отзыва. */
  set(input: {
    userId: string;
    purpose: MessagingPurpose;
    granted: boolean;
    source: MessagingConsentSource;
  }): Promise<MessagingConsent> {
    const now = sql<Date>`now()`;
    return currentDb(this.db)
      .insertInto("messaging_consents")
      .values({
        user_id: input.userId,
        purpose: input.purpose,
        granted: input.granted,
        source: input.source,
        granted_at: input.granted ? now : null,
        withdrawn_at: input.granted ? null : now,
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "channel", "purpose"]).doUpdateSet((eb) => ({
          granted: eb.ref("excluded.granted"),
          source: eb.ref("excluded.source"),
          granted_at: input.granted ? now : eb.ref("messaging_consents.granted_at"),
          withdrawn_at: input.granted ? null : now,
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}

/** privacy_requests: каркас (D-48) — создание и чтение открытых; обработка — блок 8. */
@Injectable()
export class PrivacyRequestsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  listOpen(userId: string): Promise<PrivacyRequest[]> {
    return currentDb(this.db)
      .selectFrom("privacy_requests")
      .selectAll()
      .where("user_id", "=", userId)
      .where("status", "in", ["received", "in_progress"])
      .orderBy("created_at", "desc")
      .execute();
  }

  findOpen(userId: string, kind: PrivacyRequestKind): Promise<PrivacyRequest | undefined> {
    return currentDb(this.db)
      .selectFrom("privacy_requests")
      .selectAll()
      .where("user_id", "=", userId)
      .where("kind", "=", kind)
      .where("status", "in", ["received", "in_progress"])
      .executeTakeFirst();
  }

  /** Новый запрос со статусом received; открытый того же вида уже есть (гонка) — undefined. */
  create(userId: string, kind: PrivacyRequestKind): Promise<PrivacyRequest | undefined> {
    return currentDb(this.db)
      .insertInto("privacy_requests")
      .values({ user_id: userId, kind })
      .onConflict((oc) =>
        // Предикат литералом (не параметрами): по нему PostgreSQL выбирает частичный индекс privacy_requests_open_key.
        oc
          .columns(["user_id", "kind"])
          .where(sql<boolean>`status IN ('received', 'in_progress')`)
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
  }
}
