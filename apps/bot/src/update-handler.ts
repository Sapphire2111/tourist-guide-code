import { createTranslator, resolveLocale } from "@tg/i18n";
import { replyJobId } from "./queue/contract.js";
import type { Outbox } from "./queue/outbox.js";
import type { StartContextSink } from "./start-context.js";
import { miniappUrl, parseStart } from "./telegram/start.js";
import { updateKind, type InlineKeyboardMarkup, type TgUpdate } from "./telegram/types.js";

export interface UpdateHandlerDeps {
  outbox: Outbox;
  startSink: StartContextSink;
  /** PUBLIC_MINIAPP_URL: web_app-кнопка (только https). */
  miniappBaseUrl: string | undefined;
  /** TELEGRAM_MINIAPP_LINK: если задана — url-кнопка на неё (подписанный start_param). */
  miniappLink: string | undefined;
  /** id бота из токена — часть jobId. */
  botId: string;
  logger: { log(message: string): void; warn(message: string): void };
}

/**
 * Обработка апдейта. Логи — только update_id и тип (без текста, имён, chat_id). Ответ пользователю —
 * задача в очереди, не прямой вызов Bot API.
 */
export async function handleUpdate(update: TgUpdate, deps: UpdateHandlerDeps): Promise<void> {
  const message = update.message;
  const start = parseStart(message?.text);
  // Отвечаем только в личных чатах: в группах /start не адресован боту лично.
  if (!message || !start || message.chat.type !== "private") {
    deps.logger.log(`update_id=${update.update_id} type=${updateKind(update)}: пропущен`);
    return;
  }
  const payloadState = start.payload !== null ? "valid" : start.invalidPayload ? "invalid" : "none";
  deps.logger.log(`update_id=${update.update_id} type=start payload=${payloadState}`);

  if (start.payload !== null && message.from) {
    try {
      await deps.startSink.record({
        telegramUserId: message.from.id,
        payload: start.payload,
        updateId: update.update_id,
      });
    } catch (err) {
      // Сбой передачи контекста не лишает пользователя ответа.
      deps.logger.warn(`update_id=${update.update_id}: start-контекст не передан: ${(err as Error).name}`);
    }
  }

  // Пока включён только uk (ENABLED_LOCALES); язык Telegram учтётся, когда включат другие локали.
  const { t } = createTranslator(resolveLocale(message.from?.language_code));
  const reply_markup = openButton(t("bot.start.openButton"), start.payload, deps);
  await deps.outbox.sendMessage(
    { chat_id: message.chat.id, text: t("bot.start.welcome"), ...(reply_markup ? { reply_markup } : {}) },
    replyJobId(deps.botId, update.update_id),
  );
}

/**
 * Кнопка открытия Mini App. Приоритет — прямая ссылка Mini App (url-кнопка): startapp попадает в
 * подписанный start_param initData. Иначе web_app-кнопка на PUBLIC_MINIAPP_URL (Telegram требует https):
 * её query — неподписанная подсказка; доверенный канал контекста — StartContextSink → api.
 * Нет подходящего адреса — без кнопки, только текст.
 */
function openButton(
  text: string,
  payload: string | null,
  deps: Pick<UpdateHandlerDeps, "miniappBaseUrl" | "miniappLink">,
): InlineKeyboardMarkup | undefined {
  if (deps.miniappLink) return { inline_keyboard: [[{ text, url: miniappUrl(deps.miniappLink, payload) }]] };
  if (deps.miniappBaseUrl?.startsWith("https://")) {
    return { inline_keyboard: [[{ text, web_app: { url: miniappUrl(deps.miniappBaseUrl, payload) } }]] };
  }
  return undefined;
}
