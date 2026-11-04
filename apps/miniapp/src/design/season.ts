// Сезоны дизайн-системы «Сучасна Косівщина»: определение по месяцу, ручной выбор, палитра окна Telegram.
// Токены CSS — в index.html (критичный стиль, до загрузки бандла); здесь только то, что нужно в JS.
// Логика выбора повторена в public/season-boot.js (до загрузки бандла) — менять вместе, тест следит за палитрой.
import type { MessageKey } from "@tg/i18n";

export const SEASONS = ["winter", "spring", "summer", "autumn"] as const;
export type Season = (typeof SEASONS)[number];

/** Месяц (0–11) → сезон: 11, 0, 1 — зима; 2–4 — весна; 5–7 — лето; 8–10 — осень. */
export function seasonOfMonth(month: number): Season {
  if (month === 11 || month < 2) return "winter";
  if (month < 5) return "spring";
  if (month < 8) return "summer";
  return "autumn";
}

export function isSeason(v: unknown): v is Season {
  return typeof v === "string" && (SEASONS as readonly string[]).includes(v);
}

/** Ключ localStorage ручного выбора: { season, auto } — действует, пока не сменился настоящий сезон. */
export const SEASON_STORAGE_KEY = "tg.season";

export function readSeason(now: Date = new Date()): Season {
  const auto = seasonOfMonth(now.getMonth());
  try {
    const raw = window.localStorage.getItem(SEASON_STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as { season?: unknown; auto?: unknown }) : null;
    if (saved && saved.auto === auto && isSeason(saved.season)) return saved.season;
  } catch {
    // Хранилище недоступно (приватный режим, запрет cookies) — сезон по дате.
  }
  return auto;
}

export function saveSeason(season: Season, now: Date = new Date()): void {
  const auto = seasonOfMonth(now.getMonth());
  try {
    if (season === auto) window.localStorage.removeItem(SEASON_STORAGE_KEY);
    else window.localStorage.setItem(SEASON_STORAGE_KEY, JSON.stringify({ season, auto }));
  } catch {
    // Не сохранилось — выбор действует до закрытия.
  }
}

export type SeasonConfig = {
  name: MessageKey;
  icon: string;
  badge: MessageKey;
  title: MessageKey;
  quote: MessageKey;
};

export const SEASON_CONFIG: Record<Season, SeasonConfig> = {
  winter: {
    name: "miniapp.season.winter",
    icon: "❄️",
    badge: "miniapp.season.winter.badge",
    title: "miniapp.season.winter.title",
    quote: "miniapp.season.winter.quote",
  },
  spring: {
    name: "miniapp.season.spring",
    icon: "🌱",
    badge: "miniapp.season.spring.badge",
    title: "miniapp.season.spring.title",
    quote: "miniapp.season.spring.quote",
  },
  summer: {
    name: "miniapp.season.summer",
    icon: "☀️",
    badge: "miniapp.season.summer.badge",
    title: "miniapp.season.summer.title",
    quote: "miniapp.season.summer.quote",
  },
  autumn: {
    name: "miniapp.season.autumn",
    icon: "🍂",
    badge: "miniapp.season.autumn.badge",
    title: "miniapp.season.autumn.title",
    quote: "miniapp.season.autumn.quote",
  },
};
