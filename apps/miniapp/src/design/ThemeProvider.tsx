// Текущая тема («День» / «Ніч»): старт — атрибут data-theme, который ставит public/season-boot.js до загрузки бандла
// (иначе — из localStorage); смена — переключатель в меню. Цвета окна Telegram под тему — SeasonProvider.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isTheme, readTheme, saveTheme, type Theme } from "./theme.js";

type ThemeState = { theme: Theme; setTheme: (t: Theme) => void };

const ThemeContext = createContext<ThemeState>({ theme: "day", setTheme: () => undefined });

function initialTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return isTheme(attr) ? attr : readTheme();
}

export function ThemeProvider({ children }: { children?: ReactNode }) {
  const [theme, setState] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const setTheme = useCallback((t: Theme) => {
    saveTheme(t);
    setState(t);
  }, []);
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  return useContext(ThemeContext);
}
