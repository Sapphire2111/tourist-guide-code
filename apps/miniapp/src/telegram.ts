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
  /** Bot API: версия клиента не ниже указанной. */
  isVersionAtLeast?(version: string): boolean;
  /** "unknown" — скрипт загружен вне Telegram. */
  platform?: string;
  initDataUnsafe?: { user?: TelegramUser; start_param?: string };
  themeParams?: Record<string, string | undefined>;
  ready(): void;
  expand(): void;
  onEvent?(event: string, cb: (payload?: { data?: string }) => void): void;
  offEvent?(event: string, cb: (payload?: { data?: string }) => void): void;
  /** Bot API 6.4+: системный сканер QR внутри Telegram; текст приходит событием qrTextReceived. */
  showScanQrPopup?(params: { text?: string }, cb?: (data: string) => boolean | void): void;
  closeScanQrPopup?(): void;
  BackButton?: TelegramBackButton;
  /** Bot API 6.9+: разрешение боту писать пользователю (сервисные сообщения). */
  requestWriteAccess?(cb?: (granted: boolean) => void): void;
  /** Открыть ссылку t.me внутри Telegram (Bot API 6.1+). */
  openTelegramLink?(url: string): void;
  /** Открыть внешнюю ссылку во встроенном/внешнем браузере (Bot API 6.1+). */
  openLink?(url: string): void;
  /** Цвет шапки окна (Bot API 6.1+): «#RRGGBB». */
  setHeaderColor?(color: string): void;
  /** Цвет фона окна (Bot API 6.1+). */
  setBackgroundColor?(color: string): void;
  /** Цвет нижней панели (Bot API 7.10+). */
  setBottomBarColor?(color: string): void;
  /** Bot API 8.0+: геолокация устройства с разрешением в Telegram. */
  LocationManager?: TelegramLocationManager;
};

export type TelegramLocationManager = {
  isInited?: boolean;
  isLocationAvailable?: boolean;
  init?(cb?: () => void): void;
  getLocation?(
    cb: (
      location: { latitude: number; longitude: number; horizontal_accuracy?: number | null } | null,
    ) => void,
  ): void;
  /** Настройки доступа к геолокации бота в Telegram (после отказа). */
  openSettings?(): void;
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

/**
 * Перехват «Назад» (нативная BackButton): открытый поверх экрана слой (полноэкранное фото) закрывается вместо
 * перехода на главную. Последний зарегистрированный — первым; возвращает функцию снятия.
 */
const backInterceptors: (() => void)[] = [];
export function interceptBack(fn: () => void): () => void {
  backInterceptors.push(fn);
  return () => {
    const i = backInterceptors.lastIndexOf(fn);
    if (i >= 0) backInterceptors.splice(i, 1);
  };
}
/** Обработать «Назад» перехватчиком; true — обработано, переход не нужен. */
export function consumeBack(): boolean {
  const fn = backInterceptors.at(-1);
  if (!fn) return false;
  fn();
  return true;
}

/** Сканер QR доступен: Bot API 6.4+ и методы есть (в браузере и старых клиентах кнопку не показываем). */
export function canScanQr(webApp?: TelegramWebApp): boolean {
  return (
    !!webApp &&
    typeof webApp.showScanQrPopup === "function" &&
    typeof webApp.closeScanQrPopup === "function" &&
    typeof webApp.onEvent === "function" &&
    webApp.isVersionAtLeast?.("6.4") === true
  );
}

/**
 * Открыть сканер Telegram и дождаться первого распознанного текста (окно закрывается сразу).
 * null — пользователь закрыл сканер без результата или сканер недоступен.
 */
export function scanQr(webApp: TelegramWebApp | undefined, text: string): Promise<string | null> {
  if (!webApp || !canScanQr(webApp)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      webApp.offEvent?.("qrTextReceived", onText);
      webApp.offEvent?.("scanQrPopupClosed", onClosed);
      resolve(value);
    };
    const onText = (payload?: { data?: string }) => {
      const data = payload?.data;
      if (typeof data !== "string" || data === "") return;
      try {
        webApp.closeScanQrPopup?.();
      } finally {
        finish(data);
      }
    };
    const onClosed = () => finish(null);
    webApp.onEvent?.("qrTextReceived", onText);
    webApp.onEvent?.("scanQrPopupClosed", onClosed);
    try {
      webApp.showScanQrPopup?.({ text });
    } catch {
      finish(null);
    }
  });
}
