// Тема оформления: «День» (по умолчанию) и «Ніч». Выбор хранится в localStorage; тему Telegram не наследуем.
// Логика чтения повторена в public/season-boot.js (атрибут data-theme до первого кадра) — менять вместе.
import type { MessageKey } from "@tg/i18n";

export const THEMES = ["day", "night"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_NAMES: Record<Theme, MessageKey> = {
  day: "miniapp.theme.day",
  night: "miniapp.theme.night",
};

export const THEME_STORAGE_KEY = "tg.theme";

/**
 * Цвета окна Telegram для ночи (день — по сезону, season.ts): фон и шапка совпадают с --app-bg / --top-bg темы
 * (#091913, modern.css), чтобы шапка Telegram сливалась с верхней полосой. Те же значения — в public/season-boot.js.
 */
export const NIGHT_WINDOW_COLORS = { bg: "#091913", surface: "#091913" } as const;

export function isTheme(v: unknown): v is Theme {
  return v === "day" || v === "night";
}

/** Сохранённая тема; нет значения, оно повреждено или хранилище недоступно — «День». */
export function readTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : "day";
  } catch {
    // Хранилище недоступно (приватный режим, запрет cookies) — «День».
    return "day";
  }
}

export function saveTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Не сохранилось — выбор действует до закрытия.
  }
}
