import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createTranslator,
  DEFAULT_LOCALE,
  isLocaleLoaded,
  loadLocale,
  type Locale,
  type Translator,
} from "@tg/i18n";

const I18nContext = createContext<Translator>(createTranslator(DEFAULT_LOCALE));

/**
 * Задаёт локаль для поддерева; без провайдера работает uk. Словарь не-uk локали грузится лениво:
 * до загрузки тексты берутся из uk (не сырые ключи), после — переводчик пересоздаётся.
 */
export function I18nProvider({ locale, children }: { locale: Locale; children?: ReactNode }) {
  const ready = isLocaleLoaded(locale);
  const [, setLoadedTick] = useState(0);
  useEffect(() => {
    if (ready) return;
    let alive = true;
    loadLocale(locale)
      .then(() => alive && setLoadedTick((n) => n + 1))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [locale, ready]);
  // ready в зависимостях: после загрузки словаря — новый объект, чтобы контекст обновил поддерево.
  const translator = useMemo(() => {
    void ready;
    return createTranslator(locale);
  }, [locale, ready]);
  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

/** Переводчик текущей локали: `const { t } = useT();`. */
export function useT(): Translator {
  return useContext(I18nContext);
}
