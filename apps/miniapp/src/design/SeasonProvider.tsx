// Текущий сезон темы: старт — атрибут data-season, который ставит public/season-boot.js до загрузки бандла
// (иначе — по дате и сохранённому выбору); смена — ручной переключатель. Цвета окна Telegram — по теме приложения,
// как у картинки фона; тему Telegram не наследуем (решение владельца по дизайну).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { TelegramWebApp } from "../telegram.js";
import { useTheme } from "./ThemeProvider.js";
import { WINDOW_COLORS, type Theme } from "./theme.js";
import { isSeason, readSeason, saveSeason, type Season } from "./season.js";

type SeasonState = { season: Season; setSeason: (s: Season) => void };

const SeasonContext = createContext<SeasonState>({ season: "summer", setSeason: () => undefined });

function initialSeason(): Season {
  const attr = document.documentElement.getAttribute("data-season");
  return isSeason(attr) ? attr : readSeason();
}

/** Вызов метода Telegram без падения: отказ клиента не мешает остальным вызовам. */
function safe(call: () => void): void {
  try {
    call();
  } catch {
    // Клиент отверг цвет — эта часть окна останется стандартной.
  }
}

/**
 * Цвета окна Telegram под тему. Фон — Bot API 6.1+; шапка цветом #RRGGBB — 6.9+ (до 6.9 принимает только
 * ключи bg_color/secondary_bg_color и бросает исключение); нижняя панель — 7.10+. Браузер — без вызовов.
 */
export function syncTelegramColors(webApp: TelegramWebApp | undefined, theme: Theme = "day"): void {
  if (!webApp) return;
  const at = (v: string) => !webApp.isVersionAtLeast || webApp.isVersionAtLeast(v);
  const { header, bottom } = WINDOW_COLORS[theme];
  if (at("6.1")) safe(() => webApp.setBackgroundColor?.(bottom));
  if (at("6.9")) safe(() => webApp.setHeaderColor?.(header));
  if (at("7.10")) safe(() => webApp.setBottomBarColor?.(bottom));
}

export function SeasonProvider({ webApp, children }: { webApp?: TelegramWebApp; children?: ReactNode }) {
  const [season, setState] = useState<Season>(initialSeason);
  const { theme } = useTheme();
  useEffect(() => {
    document.documentElement.setAttribute("data-season", season);
  }, [season]);
  useEffect(() => {
    syncTelegramColors(webApp, theme);
    // Клиент Telegram сам перекрашивает окно при смене своей темы и режима (полный экран, возврат в приложение) —
    // цвета темы приложения возвращаем.
    if (!webApp?.onEvent) return;
    const reapply = () => syncTelegramColors(webApp, theme);
    const events = ["themeChanged", "fullscreenChanged", "activated"];
    events.forEach((e) => webApp.onEvent?.(e, reapply));
    return () => events.forEach((e) => webApp.offEvent?.(e, reapply));
  }, [theme, webApp]);
  const setSeason = useCallback((s: Season) => {
    saveSeason(s);
    setState(s);
  }, []);
  const value = useMemo(() => ({ season, setSeason }), [season, setSeason]);
  return <SeasonContext.Provider value={value}>{children}</SeasonContext.Provider>;
}

export function useSeason(): SeasonState {
  return useContext(SeasonContext);
}
