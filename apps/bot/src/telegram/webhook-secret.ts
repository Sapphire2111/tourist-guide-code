import { createHash, timingSafeEqual } from "node:crypto";

/** Заголовок, в котором Telegram передаёт secret_token из setWebhook. */
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();

/**
 * Сверка секрета webhook за постоянное время: сравниваются SHA-256 (одинаковая длина),
 * поэтому длина ожидаемого секрета не утекает через время ответа.
 */
export function isValidWebhookSecret(received: unknown, expected: string | undefined): boolean {
  if (!expected || typeof received !== "string" || received === "") return false;
  return timingSafeEqual(digest(received), digest(expected));
}
