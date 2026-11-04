// Эмуляция окружения Telegram WebApp для браузерных тестов Mini App.
// Страница miniapp подключает telegram-web-app.js; в тестах он блокируется (см. fixtures.ts), а
// window.Telegram.WebApp подкладывается до загрузки страницы (page.addInitScript).
// Вызовы методов пишутся в window.__telegramCalls.
import { createHmac } from "node:crypto";
import type { Page } from "@playwright/test";

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramWebAppOptions = {
  user?: TelegramUser;
  startParam?: string;
  colorScheme?: "light" | "dark";
  themeParams?: Record<string, string>;
  platform?: string;
  /** Если задан — initData подписывается как настоящая (HMAC по токену бота) для будущих тестов с API. */
  botToken?: string;
};

export const DEFAULT_TELEGRAM_USER: TelegramUser = {
  id: 100_000_001,
  first_name: "Тарас",
  last_name: "Тестовий",
  username: "e2e_tester",
  language_code: "uk",
};

const LIGHT_THEME = {
  bg_color: "#ffffff",
  text_color: "#000000",
  hint_color: "#707579",
  link_color: "#3390ec",
  button_color: "#3390ec",
  button_text_color: "#ffffff",
  secondary_bg_color: "#f4f4f5",
};

/** Тёмная тема Telegram Desktop/Web (night). */
const DARK_THEME = {
  bg_color: "#17212b",
  text_color: "#f5f5f5",
  hint_color: "#9aa3ad",
  link_color: "#6ab3f3",
  button_color: "#2f6ea5",
  button_text_color: "#ffffff",
  secondary_bg_color: "#232e3c",
};

/**
 * Строка initData в формате Telegram. Подпись — по алгоритму из документации Telegram:
 * secret = HMAC_SHA256(key="WebAppData", token), hash = hex(HMAC_SHA256(secret, data_check_string)).
 * Без токена hash — заведомо невалидная заглушка.
 */
export function buildInitData(params: Record<string, string>, botToken?: string): string {
  const dataCheckString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("\n");
  const hash = botToken
    ? createHmac("sha256", createHmac("sha256", "WebAppData").update(botToken).digest())
        .update(dataCheckString)
        .digest("hex")
    : "e2e-unsigned";
  // Кодирование как у Telegram: encodeURIComponent (пробел → %20, не «+»).
  return Object.entries({ ...params, hash })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

type InitScriptConfig = {
  initData: string;
  initDataUnsafe: Record<string, unknown>;
  colorScheme: "light" | "dark";
  themeParams: Record<string, string>;
  platform: string;
};

/** Выполняется в браузере: самодостаточна, без внешних ссылок (Playwright сериализует её текст). */
function telegramInitScript(cfg: InitScriptConfig): void {
  const calls: string[] = [];
  const stub =
    (name: string, effect: () => void = () => {}) =>
    () => {
      calls.push(name);
      effect();
    };
  const pressHandlers: Record<string, (() => void)[]> = {};
  const button = (prefix: string) => {
    const state: Record<string, unknown> = {
      text: "",
      isVisible: false,
      isActive: true,
      isProgressVisible: false,
    };
    return Object.assign(state, {
      setText(text: string) {
        calls.push(`${prefix}.setText`);
        state.text = text;
        return state;
      },
      setParams(params: Record<string, unknown>) {
        calls.push(`${prefix}.setParams`);
        Object.assign(state, params);
        return state;
      },
      show: stub(`${prefix}.show`, () => (state.isVisible = true)),
      hide: stub(`${prefix}.hide`, () => (state.isVisible = false)),
      enable: stub(`${prefix}.enable`, () => (state.isActive = true)),
      disable: stub(`${prefix}.disable`, () => (state.isActive = false)),
      showProgress: stub(`${prefix}.showProgress`, () => (state.isProgressVisible = true)),
      hideProgress: stub(`${prefix}.hideProgress`, () => (state.isProgressVisible = false)),
      // Обработчики хранятся: тест нажимает кнопку через __telegramPress("BackButton").
      onClick(cb: () => void) {
        calls.push(`${prefix}.onClick`);
        (pressHandlers[prefix] ??= []).push(cb);
      },
      offClick(cb: () => void) {
        calls.push(`${prefix}.offClick`);
        pressHandlers[prefix] = (pressHandlers[prefix] ?? []).filter((h) => h !== cb);
      },
    });
  };
  const handlers: Record<string, ((payload?: unknown) => void)[]> = {};
  const webApp = {
    initData: cfg.initData,
    initDataUnsafe: cfg.initDataUnsafe,
    version: "8.0",
    platform: cfg.platform,
    colorScheme: cfg.colorScheme,
    themeParams: cfg.themeParams,
    isExpanded: false,
    viewportHeight: window.innerHeight,
    viewportStableHeight: window.innerHeight,
    ready: stub("ready"),
    expand: stub("expand", () => (webApp.isExpanded = true)),
    disableVerticalSwipes: stub("disableVerticalSwipes"),
    close: stub("close"),
    isVersionAtLeast: (v: string) => Number.parseFloat(v) <= 8.0,
    onEvent(event: string, cb: (payload?: unknown) => void) {
      calls.push("onEvent");
      (handlers[event] ??= []).push(cb);
    },
    offEvent(event: string, cb: (payload?: unknown) => void) {
      calls.push("offEvent");
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== cb);
    },
    // Сканер QR (Bot API 6.4+): окно «открывается» записью в вызовы; текст подаёт тест через __telegramEmit.
    showScanQrPopup: stub("showScanQrPopup"),
    closeScanQrPopup: stub("closeScanQrPopup"),
    sendData: stub("sendData"),
    // Пользователь соглашается: колбэк с true (как после нажатия «Разрешить» в Telegram).
    requestWriteAccess(cb?: (granted: boolean) => void) {
      calls.push("requestWriteAccess");
      cb?.(true);
    },
    MainButton: button("MainButton"),
    BackButton: button("BackButton"),
  };
  Object.assign(window, {
    Telegram: { WebApp: webApp },
    __telegramCalls: calls,
    __telegramEmit: (event: string, payload?: unknown) =>
      (handlers[event] ?? []).slice().forEach((h) => h(payload)),
    __telegramPress: (button: string) => (pressHandlers[button] ?? []).slice().forEach((h) => h()),
  });
}

/** Установить эмуляцию Telegram WebApp на страницу (вызывать до page.goto). */
export async function installTelegramWebApp(page: Page, options: TelegramWebAppOptions = {}): Promise<void> {
  const user = options.user ?? DEFAULT_TELEGRAM_USER;
  const authDate = String(Math.floor(Date.now() / 1000));
  const params: Record<string, string> = {
    query_id: "AAE2E",
    user: JSON.stringify(user),
    auth_date: authDate,
  };
  if (options.startParam) params.start_param = options.startParam;
  const initData = buildInitData(params, options.botToken);
  await page.addInitScript(telegramInitScript, {
    initData,
    initDataUnsafe: {
      query_id: params.query_id,
      user,
      auth_date: Number(authDate),
      start_param: options.startParam,
      hash: new URLSearchParams(initData).get("hash"),
    },
    colorScheme: options.colorScheme ?? "light",
    themeParams: options.themeParams ?? (options.colorScheme === "dark" ? DARK_THEME : LIGHT_THEME),
    platform: options.platform ?? "android",
  });
}

/** Какие методы WebApp вызвало приложение (в порядке вызова). */
export function telegramCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __telegramCalls?: string[] }).__telegramCalls ?? []);
}

/** Подать событие Telegram в приложение (например, qrTextReceived с распознанным текстом). */
export function emitTelegramEvent(page: Page, event: string, payload?: unknown): Promise<void> {
  return page.evaluate(
    ([e, p]) =>
      (window as unknown as { __telegramEmit(e: string, p?: unknown): void }).__telegramEmit(e as string, p),
    [event, payload] as const,
  );
}
