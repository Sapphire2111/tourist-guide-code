/** Ограничение Telegram для параметра deep link `?start=` / `startapp`. */
export const START_PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface StartCommand {
  /** Валидный payload или null (нет параметра / невалиден). */
  payload: string | null;
  /** Параметр был, но не прошёл проверку. */
  invalidPayload: boolean;
}

/**
 * Разбор `/start [payload]` (в т.ч. `/start@BotName payload`). Не команда /start → null.
 * Невалидный payload не передаётся дальше: отвечаем как на /start без параметра.
 */
export function parseStart(text: string | undefined): StartCommand | null {
  if (!text) return null;
  const m = /^\/start(?:@\w+)?(?:\s+(\S.*))?$/s.exec(text.trim());
  if (!m) return null;
  const raw = m[1]?.trim();
  if (raw === undefined) return { payload: null, invalidPayload: false };
  return START_PAYLOAD_RE.test(raw)
    ? { payload: raw, invalidPayload: false }
    : { payload: null, invalidPayload: true };
}

/**
 * Ссылка с параметром startapp (валидный payload) или без него. Для прямой ссылки Mini App
 * (`https://t.me/<bot>/<app>`) Telegram кладёт startapp в подписанный start_param initData; у web_app-кнопки
 * с PUBLIC_MINIAPP_URL это просто query страницы — неподписанная подсказка.
 */
export function miniappUrl(base: string, payload: string | null): string {
  const url = new URL(base);
  if (payload !== null) url.searchParams.set("startapp", payload);
  return url.toString();
}
