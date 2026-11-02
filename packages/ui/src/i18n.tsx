import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createTranslator, DEFAULT_LOCALE, type Locale, type Translator } from "@tg/i18n";

const I18nContext = createContext<Translator>(createTranslator(DEFAULT_LOCALE));

/** Задаёт локаль для поддерева; без провайдера работает uk. */
export function I18nProvider({ locale, children }: { locale: Locale; children?: ReactNode }) {
  const translator = useMemo(() => createTranslator(locale), [locale]);
  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

/** Переводчик текущей локали: `const { t } = useT();`. */
export function useT(): Translator {
  return useContext(I18nContext);
}
