// Минимальные типы Telegram Bot API (только используемые поля).

export interface TgUser {
  id: number;
  language_code?: string;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TgUser;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  [kind: string]: unknown;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: { text: string; web_app?: { url: string }; url?: string }[][];
}

/** Тип апдейта для логов: первый ключ, кроме update_id (message, callback_query, …). */
export function updateKind(update: TgUpdate): string {
  return Object.keys(update).find((k) => k !== "update_id") ?? "unknown";
}

/** Проверка формы апдейта из тела запроса. */
export function isTgUpdate(value: unknown): value is TgUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as Record<string, unknown>).update_id)
  );
}
