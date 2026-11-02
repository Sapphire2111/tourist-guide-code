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

/** Цвета окна Telegram под сезон (Bot API 6.1+; старые клиенты и браузер — без вызова). */
export function syncTelegramColors(webApp: TelegramWebApp | undefined, season: Season): void {
  if (!webApp || (webApp.isVersionAtLeast && !webApp.isVersionAtLeast("6.1"))) return;
  const { bg, surface } = WINDOW_COLORS[season];
  try {
    webApp.setHeaderColor?.(surface);
    webApp.setBackgroundColor?.(bg);
    if (!webApp.isVersionAtLeast || webApp.isVersionAtLeast("7.10")) webApp.setBottomBarColor?.(surface);
  } catch {
    // Клиент отверг цвет — оформление окна останется стандартным.
  }
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
