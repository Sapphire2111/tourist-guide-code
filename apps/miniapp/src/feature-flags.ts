import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "@tg/api-client";
import type { FeatureFlags } from "@tg/ui";

/** Задержки повторных попыток загрузки флагов после ошибки, мс. */
export const FLAG_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

/**
 * Эффективные фича-флаги из API (GET /feature-flags, T1-22): undefined — пока загружаются или не загрузились (всё
 * за флагами скрыто). После ошибки — повтор с задержками `retryDelaysMs`; при возврате на вкладку (visibilitychange)
 * флаги загружаются заново. Регион туриста появится в блоке 2 (контекст QR) — тогда передаётся сюда.
 */
export function useFeatureFlags(
  api: ApiClient,
  regionId?: string,
  retryDelaysMs: readonly number[] = FLAG_RETRY_DELAYS_MS,
): FeatureFlags | undefined {
  const [flags, setFlags] = useState<FeatureFlags | undefined>(undefined);
  // В ref, а не в зависимостях эффекта: новый массив при каждом рендере не должен перезапускать загрузку.
  const delays = useRef(retryDelaysMs);
  useEffect(() => {
    delays.current = retryDelaysMs;
  });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number): Promise<void> => {
      let loaded: FeatureFlags | undefined;
      try {
        const { data } = await api.GET("/feature-flags", { params: { query: regionId ? { regionId } : {} } });
        if (data && Array.isArray(data.items))
          loaded = Object.fromEntries(data.items.map((i) => [i.key, i.enabled]));
      } catch {
        // сеть недоступна — повтор ниже
      }
      if (!alive) return;
      if (loaded) {
        setFlags(loaded);
        return;
      }
      const delay = delays.current[attempt];
      if (delay !== undefined) timer = setTimeout(() => void load(attempt + 1), delay);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void load(0);
    };
    void load(0);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [api, regionId]);
  return flags;
}
