/**
 * Контракт очереди исходящих сообщений бота. Очередь своя (не system из worker): продюсер и обработчик —
 * сам bot, поэтому контракт живёт здесь. Опции совпадают по смыслу с DEFAULT_JOB_OPTIONS worker;
 * при выносе контракта очередей в пакет (ADR-0008) перенести вместе с ним.
 */
import type { JobsOptions } from "bullmq";
import type { SendMessageParams } from "../telegram/bot-api.js";

export const BOT_QUEUE = "bot-outbox";

export const BOT_JOBS = {
  /** Отправить сообщение в чат через Bot API sendMessage. */
  sendMessage: "telegram.sendMessage",
} as const;

/** Payload задачи — параметры sendMessage (JSON). Текст — наш шаблон, не ввод пользователя. */
export type SendMessageJob = SendMessageParams;

/**
 * 5 попыток с экспоненциальной задержкой 1 → 2 → 4 → 8 с; хранение как в worker.
 * Dead-letter у bot-outbox нет: окончательно упавшая задача остаётся только в failed (7 дней) и в логе.
 */
export const BOT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const satisfies JobsOptions;

/** id бота — часть токена до «:» (update_id уникален только в пределах бота). Нет токена → "0". */
export function botIdFromToken(token: string | undefined): string {
  const id = token?.split(":")[0];
  return id && /^\d+$/.test(id) ? id : "0";
}

/**
 * jobId `<задача>__<bot id>-<update_id>`: повторная доставка того же апдейта (Telegram ретраит webhook)
 * не создаёт второе сообщение, пока задача хранится в Redis. «:» в пользовательском jobId BullMQ запрещён
 * (разделитель ключей Redis), поэтому bot id и update_id разделены «-».
 */
export function replyJobId(botId: string, updateId: number): string {
  return `${BOT_JOBS.sendMessage}__${botId}-${updateId}`;
}
