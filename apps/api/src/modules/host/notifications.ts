import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql } from "kysely";
import { currentDb, InjectDb, regionContext, withTenant, type Db } from "../../db/index.js";

// Уведомления блока 5 (D-55, ADR-0020): outbox в таблице notifications. Строка пишется в транзакции бизнес-изменения
// (новая заявка, смена статуса) только получателю с MessagingConsent (service) и привязкой Telegram; после коммита
// api отправляет pending-строки через Bot API (sendMessage) и отмечает sent/failed/skipped. Очереди и повторов нет
// (упрощение тестового режима): failed остаётся в таблице, заявка видна в списке P10/C22 в любом случае.

export const NOTIFICATION_TEMPLATES = {
  requestCreated: "service_request.created",
  requestStatus: "service_request.status",
} as const;

/** Отправка сообщения в Telegram; ошибка — исключение (текст без токена). */
export interface TelegramSender {
  send(chatId: string, text: string): Promise<void>;
}

/** DI-токен отправителя; null — бот не настроен (TELEGRAM_BOT_TOKEN не задан): уведомления — skipped. */
export const TELEGRAM_SENDER = Symbol("TELEGRAM_SENDER");

/** Bot API sendMessage на fetch (без зависимостей; клиент apps/bot — в другом приложении). */
export class BotApiTelegramSender implements TelegramSender {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = "https://api.telegram.org",
  ) {}

  async send(chatId: string, text: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Текст без URL: в нём токен.
      throw new Error(`Bot API sendMessage: ${(err as Error).name}`);
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok)
      throw new Error(
        `Bot API sendMessage: ${res.status} ${(data.description ?? res.statusText).slice(0, 200)}`,
      );
  }
}

export type NotificationDraft = {
  recipientUserId: string;
  template: string;
  entityType: string;
  entityId: string;
  body: string;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger("Notifications");

  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender | null,
  ) {}

  /**
   * В текущей транзакции региона: строки pending для получателей с согласием на сервисные сообщения и Telegram.
   * Возвращает id созданных строк (для dispatch после коммита).
   */
  async enqueue(drafts: readonly NotificationDraft[]): Promise<string[]> {
    if (drafts.length === 0) return [];
    const q = currentDb(this.db);
    const eligible = await q
      .selectFrom("telegram_accounts as ta")
      .select("ta.user_id")
      .where("ta.user_id", "in", [...new Set(drafts.map((d) => d.recipientUserId))])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("messaging_consents as mc")
            .select("mc.id")
            .whereRef("mc.user_id", "=", "ta.user_id")
            .where("mc.purpose", "=", "service")
            .where("mc.granted", "=", true),
        ),
      )
      .execute();
    const allowed = new Set(eligible.map((r) => r.user_id));
    const rows = drafts
      .filter((d) => allowed.has(d.recipientUserId))
      .map((d) => ({
        recipient_user_id: d.recipientUserId,
        template: d.template,
        entity_type: d.entityType,
        entity_id: d.entityId,
        body: d.body.slice(0, 4000),
      }));
    if (rows.length === 0) return [];
    const inserted = await q.insertInto("notifications").values(rows).returning("id").execute();
    return inserted.map((r) => r.id);
  }

  /** После коммита: отправка pending-строк (ошибки — в строку и лог, не в ответ запроса). */
  async dispatch(regionId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await withTenant(this.db, regionContext(regionId), (trx) =>
      trx
        .selectFrom("notifications as n")
        .innerJoin("telegram_accounts as ta", "ta.user_id", "n.recipient_user_id")
        .select(["n.id", "n.body", "ta.telegram_user_id"])
        .where("n.id", "in", [...ids])
        .where("n.status", "=", "pending")
        .execute(),
    );
    for (const r of rows) {
      let status: "sent" | "failed" | "skipped" = "sent";
      let error: string | null = null;
      if (!this.sender) {
        status = "skipped";
        error = "bot_not_configured";
      } else {
        try {
          await this.sender.send(r.telegram_user_id, r.body);
        } catch (err) {
          status = "failed";
          error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
          this.logger.warn(`Уведомление ${r.id} не отправлено: ${error}`);
        }
      }
      await withTenant(this.db, regionContext(regionId), (trx) =>
        trx
          .updateTable("notifications")
          .set({
            status,
            last_error: error,
            attempts: sql<number>`attempts + 1`,
            sent_at: status === "sent" ? new Date() : null,
          })
          .where("id", "=", r.id)
          .where("status", "=", "pending")
          .execute(),
      );
    }
  }

  /** Отправка в фоне: ответ запроса не ждёт Bot API. */
  dispatchInBackground(regionId: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    void this.dispatch(regionId, ids).catch((err: unknown) =>
      this.logger.warn(`Отправка уведомлений: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}
