import type { InlineKeyboardMarkup } from "./types.js";

export interface SendMessageParams {
  chat_id: number;
  text: string;
  reply_markup?: InlineKeyboardMarkup;
}

/** Ошибка Bot API без токена и тела запроса в тексте. retryable — стоит ли повторять задачу. */
export class BotApiError extends Error {
  override name = "BotApiError";
  constructor(
    readonly method: string,
    readonly status: number,
    readonly errorCode: number | undefined,
    description: string,
    readonly retryable: boolean,
  ) {
    super(`Bot API ${method}: ${status} ${description}`);
  }
}

export interface BotApiClientOptions {
  token: string;
  fetch?: typeof fetch;
  /** Ожидание перед повтором (для тестов). */
  sleep?: (ms: number) => Promise<void>;
  /** Сколько раз повторять при 429 внутри одного вызова. */
  maxRetries?: number;
  /** Верхняя граница retry_after, с: дольше — не держим задачу, отдаём ошибку очереди (её backoff). */
  maxRetryAfterSec?: number;
  baseUrl?: string;
}

interface ApiResponse {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** HTTP-клиент Bot API на fetch. Токен только в URL запроса, в ошибки и логи не попадает. */
export class BotApiClient {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxRetryAfterSec: number;
  private readonly baseUrl: string;

  constructor(private readonly options: BotApiClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxRetryAfterSec = options.maxRetryAfterSec ?? 10;
    this.baseUrl = options.baseUrl ?? "https://api.telegram.org";
  }

  sendMessage(params: SendMessageParams): Promise<unknown> {
    return this.call("sendMessage", params);
  }

  setWebhook(params: {
    url: string;
    secret_token: string;
    allowed_updates: string[];
    drop_pending_updates?: boolean;
  }) {
    return this.call("setWebhook", params);
  }

  async call(method: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/bot${this.options.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        // Сетевая ошибка/таймаут: повтор — на уровне очереди. Текст без URL (в нём токен).
        throw new BotApiError(method, 0, undefined, (err as Error).name, true);
      }
      const data = (await res.json().catch(() => ({}))) as ApiResponse;
      if (res.ok && data.ok) return data.result;
      const description = data.description ?? res.statusText;
      if (res.status === 429) {
        const retryAfter = data.parameters?.retry_after ?? 1;
        if (attempt < this.maxRetries && retryAfter <= this.maxRetryAfterSec) {
          await this.sleep(retryAfter * 1000);
          continue;
        }
        throw new BotApiError(method, res.status, data.error_code, description, true);
      }
      // 4xx (кроме 429) — запрос заведомо не пройдёт (чат заблокирован, неверные данные); 5xx — повторяемо.
      throw new BotApiError(method, res.status, data.error_code, description, res.status >= 500);
    }
  }
}
