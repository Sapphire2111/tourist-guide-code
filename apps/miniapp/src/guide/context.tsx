// Общее для экранов гида: доступ к данным, аналитика, базовая точка из контекста входа (QR), Telegram.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useT } from "@tg/ui";
import { currentEntryKey, deleteMemo, readMemo, writeMemo } from "../back.js";
import type { TelegramWebApp } from "../telegram.js";
import { noopAnalytics, type Analytics } from "./analytics.js";
import type { LatLng } from "./geo.js";
import type { GuideApi } from "./types.js";

export type GuideEnv = {
  api: GuideApi;
  analytics: Analytics;
  webApp?: TelegramWebApp;
  /** Базовая точка «Що поруч» (заведение/точка QR), если известна. */
  base: { name: string; point: LatLng | null; /** Точка ещё загружается. */ pending?: boolean } | null;
  /** Регион гида из контекста входа; null — каталог недоступен (кроме 112 в «Халепа?»). */
  regionId: string | null;
  /** Есть сессия (вход через Telegram) — избранное доступно. */
  signedIn: boolean;
};

const GuideContext = createContext<GuideEnv | null>(null);

export function GuideProvider({ value, children }: { value: GuideEnv; children?: ReactNode }) {
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}

export function useGuide(): GuideEnv {
  const env = useContext(GuideContext);
  if (!env) throw new Error("GuideProvider не подключён");
  return env;
}

/** Как useGuide, но без провайдера — null (общие элементы, которые встречаются и вне гида). */
export function useMaybeGuide(): GuideEnv | null {
  return useContext(GuideContext);
}

export function noopGuideApi(): GuideApi {
  const fail = () => Promise.reject(new Error("no api"));
  return {
    categories: fail,
    localities: fail,
    search: fail,
    place: fail,
    favorites: fail,
    addFavorite: fail,
    removeFavorite: fail,
    emergencyContacts: fail,
  };
}

export const defaultAnalytics = noopAnalytics;

/** Экран каталога без региона — понятное сообщение вместо ошибки запроса. */
export function RequireRegion({ children }: { children: ReactNode }) {
  const { regionId } = useGuide();
  const { t } = useT();
  if (!regionId) return <p data-testid="no-region">{t("miniapp.guide.noRegion")}</p>;
  return <>{children}</>;
}

export type Async<T> =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; data: T };

/**
 * Загрузка данных с повтором: `const [state, retry] = useAsync(() => api.x(), [deps])`.
 * `memo` — данные запоминаются за записью истории: возврат «Назад» с теми же параметрами (`memo.key`) показывает
 * их сразу, без запроса и мигания (back.ts). Новый заход на экран — новая запись, данные свежие.
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  memo?: { slot: string; key: string },
): [Async<T>, () => void] {
  const [entry] = useState(() => (memo ? currentEntryKey() : ""));
  const [state, setState] = useState<Async<T>>(() => {
    const hit = memo && readMemo<T>(entry, memo.slot, memo.key);
    return hit ? { status: "ready", data: hit.data } : { status: "loading" };
  });
  const [attempt, setAttempt] = useState(0);
  const memoSlot = memo?.slot;
  useEffect(() => {
    if (!memoSlot) return;
    return () => {
      if (currentEntryKey() === entry) deleteMemo(entry, memoSlot);
    };
  }, [entry, memoSlot]);
  useEffect(() => {
    const hit = memo && attempt === 0 ? readMemo<T>(entry, memo.slot, memo.key) : undefined;
    if (hit) {
      setState((s) =>
        s.status === "ready" && s.data === hit.data ? s : { status: "ready", data: hit.data },
      );
      return;
    }
    let alive = true;
    // Смена зависимостей отменяет прежнюю загрузку (догрузка страниц «Де жити» не продолжается впустую).
    const abort = new AbortController();
    setState({ status: "loading" });
    load(abort.signal).then(
      (data) => {
        if (!alive) return;
        if (memo) writeMemo(entry, memo.slot, memo.key, data);
        setState({ status: "ready", data });
      },
      (error: unknown) => alive && setState({ status: "error", error }),
    );
    return () => {
      alive = false;
      abort.abort();
    };
    // load меняется на каждый рендер — зависимости передаёт вызывающий.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [state, retry];
}
