// Сроки броней (блок 7): только вызовы функций БД из миграций api 0022 и 0023 — они сами выставляют
// app.actor = 'system' (RLS), пишут историю брони, аналитику и строки outbox notifications (уведомления переходов и
// напоминания — в той же транзакции, что и переход/отметка, поэтому повтор задачи их не дублирует). Строки outbox
// шаблонов воркера отправляет сам воркер через Bot API (api отправляет только свои строки сразу после коммита).
// В пакете (а не в apps/worker): тот же код запускает и api на staging (WORKER_IN_PROCESS) — app→app запрещено.

/** Итог задачи сроков броней: числа броней и строк outbox, отправленных воркером. */
export type BookingsDueResult = {
  expired: number;
  completed: number;
  /** Поставленные отметки напоминаний (туристу и партнёру). */
  reminded: number;
  notifications: { sent: number; failed: number; skipped: number };
};

/**
 * Сроки броней (функции БД bookings_expire_due, bookings_auto_complete — миграция api 0022; напоминания и отправка
 * outbox воркера — 0023).
 */
export interface BookingsDueProcessor {
  /** expired по SLA ответа (D-43, D-66), автозавершение (C-27), напоминания и отправка их уведомлений. */
  processDue(): Promise<BookingsDueResult>;
}

/** Броней за один вызов функции (одна короткая транзакция). */
export const BOOKINGS_DUE_BATCH = 500;
/**
 * Автозавершение confirmed через столько часов после окончания, если партнёр не отметил no_show (C-27 (а), принята
 * рекомендация; значение — параметр тестового режима).
 */
export const DEFAULT_BOOKING_AUTO_COMPLETE_HOURS = 24;
/**
 * Напоминания (ТЗ §10.4, states-and-rules §3.4; значения — параметры тестового режима): туристу — за столько минут до
 * начала подтверждённой брони (каждое — один раз; окна не пересекаются); партнёру — за столько минут до срока ответа
 * по неподтверждённой брони (D-43).
 */
export const DEFAULT_BOOKING_REMINDERS = {
  userBeforeMin: [24 * 60, 2 * 60],
  partnerBeforeDueMin: 15,
} as const;
/** Шаблоны outbox, строки которых пишут функции БД воркера (миграция api 0023) и отправляет воркер. */
export const WORKER_NOTIFICATION_TEMPLATES = [
  "booking.expired",
  "booking.auto_completed",
  "booking.reminder",
  "booking.partner_reminder",
] as const;
/** Строк outbox за один вызов функции. */
const DISPATCH_BATCH = 100;
/** Предел вызовов за задачу: остаток обработает следующий тик. */
const MAX_BATCHES = 20;

/** Исполнитель запроса (pg.Pool подходит); тесты подставляют свой. */
export interface RowsQueryable {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Отправка сообщения в Telegram (Bot API sendMessage); ошибка — исключение без токена в тексте. */
export interface TelegramSender {
  send(chatId: string, text: string): Promise<void>;
}

/** Bot API sendMessage на fetch — как BotApiTelegramSender в api (worker от api не зависит). */
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

export type BookingsDueOptions = {
  autoCompleteHours?: number;
  batch?: number;
  reminders?: { userBeforeMin: readonly number[]; partnerBeforeDueMin: number };
  /** null/undefined — бот не настроен (TELEGRAM_BOT_TOKEN): строки outbox воркера помечаются skipped. */
  sender?: TelegramSender | null;
};

async function drain(db: RowsQueryable, text: string, values: unknown[], batch: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { rows } = await db.query(text, values);
    const n = Number(rows[0]?.n ?? 0);
    total += n;
    if (n < batch) break;
  }
  return total;
}

type Claimed = { id: string; chat_id: string; body: string };

/** Отправка строк outbox шаблонов воркера: взять (один раз — attempts), отправить, отметить итог. */
async function dispatch(db: RowsQueryable, sender: TelegramSender | null) {
  const result = { sent: 0, failed: 0, skipped: 0 };
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { rows } = await db.query("SELECT id, chat_id, body FROM notifications_claim_pending($1, $2)", [
      WORKER_NOTIFICATION_TEMPLATES,
      DISPATCH_BATCH,
    ]);
    for (const row of rows as Claimed[]) {
      let status: "sent" | "failed" | "skipped" = "sent";
      let error: string | null = null;
      if (!sender) {
        status = "skipped";
        error = "bot_not_configured";
      } else {
        try {
          await sender.send(row.chat_id, row.body);
        } catch (err) {
          status = "failed";
          error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        }
      }
      await db.query("SELECT notifications_mark_dispatched($1, $2, $3) AS ok", [row.id, status, error]);
      result[status] += 1;
    }
    if (rows.length < DISPATCH_BATCH) break;
  }
  return result;
}

export function bookingsDueProcessor(
  db: RowsQueryable,
  options: BookingsDueOptions = {},
): BookingsDueProcessor {
  const autoCompleteHours = options.autoCompleteHours ?? DEFAULT_BOOKING_AUTO_COMPLETE_HOURS;
  const batch = options.batch ?? BOOKINGS_DUE_BATCH;
  const reminders = options.reminders ?? DEFAULT_BOOKING_REMINDERS;
  const sender = options.sender ?? null;
  if (!Number.isInteger(autoCompleteHours) || autoCompleteHours < 1)
    throw new Error(`Автозавершение броней — целое число часов ≥ 1, получено ${autoCompleteHours}`);
  if (
    reminders.userBeforeMin.some((m) => !Number.isInteger(m) || m < 1 || m > 99_999) ||
    !Number.isInteger(reminders.partnerBeforeDueMin) ||
    reminders.partnerBeforeDueMin < 0
  )
    throw new Error("Напоминания броней: минуты туристу — целые 1…99999, партнёру — целое ≥ 0");
  return {
    async processDue(): Promise<BookingsDueResult> {
      const expired = await drain(db, "SELECT bookings_expire_due($1) AS n", [batch], batch);
      const completed = await drain(
        db,
        "SELECT bookings_auto_complete($1, $2) AS n",
        [autoCompleteHours, batch],
        batch,
      );
      const reminded = await drain(
        db,
        "SELECT bookings_send_reminders($1, $2, $3) AS n",
        [[...reminders.userBeforeMin], reminders.partnerBeforeDueMin, batch],
        batch,
      );
      const notifications = await dispatch(db, sender);
      return { expired, completed, reminded, notifications };
    },
  };
}
