// Тонкая обёртка над window.Telegram.WebApp (скрипт telegram-web-app.js из index.html) вместо
// @telegram-apps/sdk-react: нужны ready/expand/тема/BackButton — ради них лишняя зависимость не нужна.
// Вне Telegram (обычный браузер) WebApp нет — приложение работает без него.
// initDataUnsafe не проверен — только для UI; проверка initData на сервере — блок 2.
import { applyThemeParams } from "@tg/ui";

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramBackButton = {
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
};

/** Используемая часть API Telegram WebApp. */
export type TelegramWebApp = {
  initData?: string;
  /** "unknown" — скрипт загружен вне Telegram. */
  platform?: string;
  initDataUnsafe?: { user?: TelegramUser; start_param?: string };
  themeParams?: Record<string, string | undefined>;
  ready(): void;
  expand(): void;
  onEvent?(event: string, cb: () => void): void;
  BackButton?: TelegramBackButton;
  /** Bot API 6.9+: разрешение боту писать пользователю (сервисные сообщения). */
  requestWriteAccess?(cb?: (granted: boolean) => void): void;
  /** Открыть ссылку t.me внутри Telegram (Bot API 6.1+). */
  openTelegramLink?(url: string): void;
  /** Открыть внешнюю ссылку во встроенном/внешнем браузере (Bot API 6.1+). */
  openLink?(url: string): void;
};

type TelegramWindow = { Telegram?: { WebApp?: TelegramWebApp } };

/**
 * WebApp, если Mini App открыт в Telegram. Скрипт создаёт объект и в обычном браузере (platform "unknown",
 * пустой initData). Пользователя может не быть (например, запуск из вложения) — это не признак.
 */
export function getWebApp(win: object = window): TelegramWebApp | undefined {
  const webApp = (win as TelegramWindow).Telegram?.WebApp;
  if (!webApp) return undefined;
  return webApp.initData || (webApp.platform && webApp.platform !== "unknown") ? webApp : undefined;
}

/** Старт в Telegram до рендера: тема → CSS-переменные (и при смене темы), expand(). ready() — в App после рендера. */
export function initTelegram(webApp: TelegramWebApp, root: HTMLElement = document.documentElement): void {
  const syncTheme = () => applyThemeParams(webApp.themeParams ?? {}, root);
  syncTheme();
  webApp.onEvent?.("themeChanged", syncTheme);
  webApp.expand();
}
