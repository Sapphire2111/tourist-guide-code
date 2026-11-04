import { createTranslator, resolveLocale } from "@tg/i18n";

/** Запрос Bot API: метод и тело. */
export interface BotApiRequest {
  method: string;
  body: Record<string, unknown>;
}

/**
 * Кнопка меню чата (web_app) и команды бота. Кнопку Telegram рисует сам, без запроса к нашему серверу, —
 * вход в Mini App работает сразу, даже пока api на Render просыпается. Методы идемпотентны: повторный
 * вызов перезаписывает то же значение. Без https-адреса Mini App кнопку не ставим (Telegram требует https).
 */
export function menuRequests(miniappUrl: string | undefined): BotApiRequest[] {
  if (!miniappUrl?.startsWith("https://")) {
    throw new Error("PUBLIC_MINIAPP_URL должен быть https-адресом");
  }
  const { t } = createTranslator(resolveLocale(undefined));
  return [
    {
      method: "setChatMenuButton",
      body: {
        menu_button: { type: "web_app", text: t("bot.menu.openButton"), web_app: { url: miniappUrl } },
      },
    },
    {
      method: "setMyCommands",
      body: { commands: [{ command: "start", description: t("bot.menu.startCommand") }] },
    },
  ];
}
