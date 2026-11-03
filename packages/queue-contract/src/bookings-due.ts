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
  /** retried — повторяемая ошибка (429 Telegram, 5xx, сеть): строка осталась pending, повтор — следующим тиком. */
  notifications: { sent: number; failed: number; skipped: number; retried: number };
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
/** Ожидание ответа Bot API на одну отправку, мс. */
const SEND_TIMEOUT_MS = 10_000;
/** Строк outbox за один вызов функции (с SEND_TIMEOUT_MS и повтором 429 в вызове пачка укладывается в аренду). */
const DISPATCH_BATCH = 50;
/**
 * Попыток отправки строки outbox воркера (взятие = попытка; 429 попытку не тратит): после стольких — failed
 * (max_attempts). Аренда взятой строки, с: дольше худшего времени пачки (50 × до 25 с), чтобы её не взял второй
 * воркер, пока первый отправляет; воркер упал между взятием и отметкой — строку возьмут снова после аренды (0024).
 */
export const NOTIFICATION_MAX_ATTEMPTS = 5;
export const NOTIFICATION_LEASE_SEC = 1800;
/** Пауза перед повтором при повторяемой ошибке без retry_after, с: 60, 120, 240… не больше часа. */
export function notificationBackoffSec(attempt: number): number {
  return Math.min(3600, 60 * 2 ** Math.max(0, attempt - 1));
}
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

/**
 * Ошибка отправки: retryable — запрос заведомо не доставлен или Telegram просит повторить (429, 5xx, отказ соединения
 * до отправки); retryAfterSec — сколько ждать по ответу 429 (parameters.retry_after). Таймаут и обрыв после отправки
 * — не retryable: сообщение могло дойти, повтор дал бы дубль (не больше одного раза). Прочие 4xx — не повторяются.
 */
export class TelegramSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = "TelegramSendError";
  }
}

/** Ошибки соединения, при которых запрос до Telegram не дошёл (DNS, отказ, нет маршрута) — повтор безопасен. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Код системной ошибки fetch (undici: TypeError «fetch failed» с cause.code). */
function errorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

export type BotApiSenderOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Ожидание перед повтором (для тестов). */
  sleep?: (ms: number) => Promise<void>;
  /** Повторов при 429 внутри одного вызова (короткий retry_after). */
  maxRetries?: number;
  /** Дольше этого retry_after, с, не ждём в вызове — ошибка retryable, строку повторит следующий тик. */
  maxWaitSec?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bot API sendMessage на fetch — как BotApiTelegramSender в api (worker от api не зависит). */
export class BotApiTelegramSender implements TelegramSender {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxWaitSec: number;

  constructor(
    private readonly token: string,
    options: BotApiSenderOptions | typeof fetch = {},
  ) {
    const o = typeof options === "function" ? { fetch: options } : options;
    this.fetchFn = o.fetch ?? fetch;
    this.baseUrl = o.baseUrl ?? "https://api.telegram.org";
    this.sleep = o.sleep ?? defaultSleep;
    this.maxRetries = o.maxRetries ?? 1;
    this.maxWaitSec = o.maxWaitSec ?? 5;
  }

  async send(chatId: string, text: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/bot${this.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        // Текст без URL: в нём токен. Повтор — только если запрос точно не ушёл.
        const code = errorCode(err);
        throw new TelegramSendError(
          `Bot API sendMessage: ${(err as Error).name}${code ? ` ${code}` : ""}`,
          code !== undefined && NOT_SENT_CODES.has(code),
        );
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (res.ok && data.ok) return;
      const message = `Bot API sendMessage: ${res.status} ${(data.description ?? res.statusText).slice(0, 200)}`;
      if (res.status === 429) {
        const retryAfter = Math.max(1, Math.ceil(Number(data.parameters?.retry_after ?? 1) || 1));
        if (attempt < this.maxRetries && retryAfter <= this.maxWaitSec) {
          await this.sleep(retryAfter * 1000);
          continue;
        }
        throw new TelegramSendError(message, true, retryAfter);
      }
      throw new TelegramSendError(message, res.status >= 500);
    }
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

type Claimed = { id: string; chat_id: string; body: string; attempts: number | string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Отправка строк outbox шаблонов воркера: взять (attempts — номер взятия, аренда — next_attempt_at), отправить,
 * отметить итог этим номером (истёкшую аренду уже взял другой — чужое взятие не отмечается). Повторяемая ошибка —
 * строка возвращается в очередь (notifications_release) и пачка прерывается: остальные взятые строки возвращаются без
 * траты попытки (Telegram или сеть недоступны — не тратим на них время аренды). 429 попытку не тратит (лимит бота, не
 * сбой строки) — и на последней попытке; 5xx и отказ соединения — тратят, после последней — failed.
 */
async function dispatch(db: RowsQueryable, sender: TelegramSender | null) {
  const result = { sent: 0, failed: 0, skipped: 0, retried: 0 };
  const release = async (row: Claimed, delaySec: number, error: string, refund: boolean) => {
    await db.query("SELECT notifications_release($1, $2, $3, $4, $5) AS ok", [
      row.id,
      delaySec,
      error,
      Number(row.attempts),
      refund,
    ]);
    result.retried += 1;
  };
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { rows } = await db.query(
      "SELECT id, chat_id, body, attempts FROM notifications_claim_pending($1, $2, $3, $4)",
      [WORKER_NOTIFICATION_TEMPLATES, DISPATCH_BATCH, NOTIFICATION_MAX_ATTEMPTS, NOTIFICATION_LEASE_SEC],
    );
    const claimed = rows as Claimed[];
    let stop: { delaySec: number; error: string } | null = null;
    for (const row of claimed) {
      if (stop) {
        await release(row, stop.delaySec, stop.error, true);
        continue;
      }
      let status: "sent" | "failed" | "skipped" = "sent";
      let error: string | null = null;
      if (!sender) {
        status = "skipped";
        error = "bot_not_configured";
      } else {
        try {
          await sender.send(row.chat_id, row.body);
        } catch (err) {
          error = errorText(err);
          if (err instanceof TelegramSendError && err.retryable) {
            const attempt = Number(row.attempts) || NOTIFICATION_MAX_ATTEMPTS;
            const throttled = err.retryAfterSec !== null;
            stop = { delaySec: err.retryAfterSec ?? notificationBackoffSec(attempt), error };
            if (throttled || attempt < NOTIFICATION_MAX_ATTEMPTS) {
              await release(row, stop.delaySec, error, throttled);
              continue;
            }
          }
          status = "failed";
        }
      }
      await db.query("SELECT notifications_mark_dispatched($1, $2, $3, $4) AS ok", [
        row.id,
        status,
        error,
        Number(row.attempts),
      ]);
      result[status] += 1;
    }
    if (stop || claimed.length < DISPATCH_BATCH) break;
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
