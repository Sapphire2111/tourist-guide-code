// i18n-каркас (T1-15, D-05). Изоморфно: без DOM, Node и React.
import { en, uk, type MessageKey, type Messages } from "./messages.js";

export { en, uk };
export type { MessageKey, Messages };

export const SUPPORTED_LOCALES = ["uk", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "uk";
/** Локали, доступные пользователям. Пока только uk: en — тестовая и неполная (до решения D-05). */
export const ENABLED_LOCALES: readonly Locale[] = ["uk"];

/** Словари по локалям; uk полный, остальные частичные. */
export const MESSAGES: Record<Locale, Messages> = { uk, en };

/** Локаль пользователя (`en-US`, `uk_UA`, `EN`) → поддерживаемая, иначе uk. */
export function resolveLocale(
  userLang?: string | null,
  allowed: readonly Locale[] = ENABLED_LOCALES,
): Locale {
  const base = userLang?.trim().toLowerCase().split(/[-_]/)[0];
  return allowed.find((l) => l === base) ?? DEFAULT_LOCALE;
}

export type TranslateParams = Record<string, string | number>;
export type Translator = {
  readonly locale: Locale;
  /** Типизированный ключ: опечатка или ключ вне uk — ошибка компиляции. */
  t(key: MessageKey, params?: TranslateParams): string;
  /** Для ключей из внешних источников (messageKey с сервера): неизвестный ключ возвращается как есть. */
  tDynamic(key: string, params?: TranslateParams): string;
};

function own(dict: object, key: string): string | undefined {
  if (!Object.hasOwn(dict, key)) return undefined;
  const v = (dict as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/{(\w+)}/g, (m, name: string) => {
    if (!Object.hasOwn(params, name)) return m;
    const v = params[name];
    return typeof v === "string" || typeof v === "number" ? String(v) : m;
  });
}

/** Ключ → текст; не найден — откат по точкам к родителю (`errors.validation.isFoo` → `errors.validation`). */
function lookup(dict: object, key: string): string | undefined {
  for (let k = key; k; k = k.slice(0, Math.max(k.lastIndexOf("."), 0))) {
    const v = own(dict, k);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Перевод: локаль → uk → сам ключ (не падает). */
export function createTranslator(locale: Locale = DEFAULT_LOCALE): Translator {
  const tDynamic = (key: string, params?: TranslateParams): string => {
    return interpolate(lookup(MESSAGES[locale], key) ?? lookup(uk, key) ?? key, params);
  };
  return { locale, t: tDynamic, tDynamic };
}

/** Мультиязычное поле контента (в БД — jsonb с обязательным uk). */
export type LocalizedText = { uk: string } & Partial<Record<Locale, string>>;

/** Выбор языка поля: язык пользователя → uk. Пустая строка считается отсутствием перевода. */
export function pickLocalized(text: LocalizedText, locale: Locale): string {
  return text[locale] || text.uk;
}
