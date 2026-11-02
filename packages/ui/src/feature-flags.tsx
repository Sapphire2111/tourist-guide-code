import { createContext, useContext, type ReactNode } from "react";

/**
 * Эффективные значения фича-флагов (T1-22): ключ флага → включён. Источник — GET /feature-flags API (тип ключа —
 * FeatureFlagKey из @tg/api-client). Скрытие в UI — удобство, не защита: доступ закрывает API (404).
 */
export type FeatureFlags = Readonly<Record<string, boolean>>;

const FeatureFlagsContext = createContext<FeatureFlags | undefined>(undefined);

/**
 * Флаги для поддерева. `flags` undefined — ещё не загружены: всё за флагами скрыто, пока не придёт ответ
 * (выключенный модуль не мелькает). Без провайдера — то же.
 */
export function FeatureFlagsProvider({
  flags,
  children,
}: {
  flags: FeatureFlags | undefined;
  children?: ReactNode;
}) {
  return <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>;
}

/** Включён ли флаг; неизвестный ключ, флаги не загружены — false. */
export function useFeatureFlag(key: string): boolean {
  const flags = useContext(FeatureFlagsContext);
  return flags !== undefined && Object.hasOwn(flags, key) && flags[key] === true;
}

/** Показывает детей, только если флаг включён; иначе — fallback (по умолчанию ничего). */
export function Feature({
  flag,
  fallback = null,
  children,
}: {
  flag: string;
  fallback?: ReactNode;
  children?: ReactNode;
}) {
  return <>{useFeatureFlag(flag) ? children : fallback}</>;
}
