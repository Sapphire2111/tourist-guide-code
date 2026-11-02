// Тема: дизайн-токены как CSS-переменные. В Mini App значения берутся из themeParams Telegram
// (переменные --tg-theme-*), вне Telegram — значения по умолчанию ниже.

/** Токены и их источник: переменная Telegram + запасное значение. */
const TOKENS = {
  "--color-bg": ["bg_color", "#ffffff"],
  "--color-text": ["text_color", "#111111"],
  "--color-hint": ["hint_color", "#5f6368"],
  "--color-link": ["link_color", "#1558b0"],
  "--color-button": ["button_color", "#1558b0"],
  "--color-button-text": ["button_text_color", "#ffffff"],
  "--color-surface": ["secondary_bg_color", "#f1f3f4"],
} as const;

/** Имя CSS-переменной Telegram для ключа themeParams: `bg_color` → `--tg-theme-bg-color`. */
export function telegramThemeVar(key: string): string {
  return `--tg-theme-${key.replace(/_/g, "-")}`;
}

const tokenRules = Object.entries(TOKENS)
  .map(([token, [key, fallback]]) => `${token}: var(${telegramThemeVar(key)}, ${fallback});`)
  .join("");

/** Базовые стили: токены, сброс отступов, системный шрифт. */
export const THEME_CSS =
  `:root{${tokenRules}--space:8px;--radius:10px;color-scheme:light;}` +
  `*{box-sizing:border-box;}` +
  `body{margin:0;background:var(--color-bg);color:var(--color-text);` +
  `font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}` +
  `a{color:var(--color-link);}` +
  `:focus-visible{outline:2px solid var(--color-link);outline-offset:2px;}`;

/** Подключает THEME_CSS (один раз в корне приложения). */
export function ThemeStyle() {
  return <style>{THEME_CSS}</style>;
}

/**
 * Записывает themeParams Telegram в CSS-переменные --tg-theme-* элемента (обычно documentElement).
 * telegram-web-app.js ставит их сам; наш вызов — страховка (старые клиенты) и для мока в тестах.
 */
export function applyThemeParams(params: Record<string, string | undefined>, el: HTMLElement): void {
  for (const [key, value] of Object.entries(params)) {
    if (value) el.style.setProperty(telegramThemeVar(key), value);
  }
}
