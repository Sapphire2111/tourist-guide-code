// Текущий сезон темы: старт — атрибут data-season, который ставит public/season-boot.js до загрузки бандла
// (иначе — по дате и сохранённому выбору); смена — ручной переключатель. Цвета окна Telegram — под сезон,
// светлая палитра и в тёмной теме Telegram (решение владельца по дизайну): без тёмной полосы шапки.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { TelegramWebApp } from "../telegram.js";
import { isSeason, readSeason, saveSeason, WINDOW_COLORS, type Season } from "./season.js";

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
 * Цвета окна Telegram под сезон. Фон — Bot API 6.1+; шапка цветом #RRGGBB — 6.9+ (до 6.9 принимает только
 * ключи bg_color/secondary_bg_color и бросает исключение); нижняя панель — 7.10+. Браузер — без вызовов.
 */
export function syncTelegramColors(webApp: TelegramWebApp | undefined, season: Season): void {
  if (!webApp) return;
  const at = (v: string) => !webApp.isVersionAtLeast || webApp.isVersionAtLeast(v);
  const { bg, surface } = WINDOW_COLORS[season];
  if (at("6.1")) safe(() => webApp.setBackgroundColor?.(bg));
  if (at("6.9")) safe(() => webApp.setHeaderColor?.(surface));
  if (at("7.10")) safe(() => webApp.setBottomBarColor?.(surface));
}

export function SeasonProvider({ webApp, children }: { webApp?: TelegramWebApp; children?: ReactNode }) {
  const [season, setState] = useState<Season>(initialSeason);
  useEffect(() => {
    document.documentElement.setAttribute("data-season", season);
    syncTelegramColors(webApp, season);
  }, [season, webApp]);
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
