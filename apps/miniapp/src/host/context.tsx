// Окружение экранов блока 5: доступ к API заявок/планов, контекст отеля из QR, роль персонала.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Async } from "../guide/context.js";
import type { HostApi } from "./types.js";

export type HostEnv = {
  api: HostApi;
  /** Заведение из QR отеля (placeId точки), иначе null — «Про заклад» недоступен. */
  hotelPlaceId: string | null;
  entryContextId: string | null;
  /** Режим персонала (D-50): признак staffMode из /me. */
  staff: StaffRole;
  /** Часовой пояс региона (IANA) — время «буде оброблено з …»; null — устройства. */
  timeZone: string | null;
};

export type StaffRole = "yes" | "no";

const HostContext = createContext<HostEnv | null>(null);

export function HostProvider({ value, children }: { value: HostEnv; children?: ReactNode }) {
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function useHost(): HostEnv {
  const env = useContext(HostContext);
  if (!env) throw new Error("HostProvider не подключён");
  return env;
}

export function noopHostApi(): HostApi {
  const fail = () => Promise.reject(new Error("no api"));
  return {
    hostModule: fail,
    createRequest: fail,
    myRequests: fail,
    cancelRequest: fail,
    staffRequests: fail,
    setStatus: fail,
    scenarios: fail,
    scenario: fail,
    plans: fail,
    plan: fail,
    savePlan: fail,
    updatePlan: fail,
  };
}

/**
 * Загрузка с обновлением «на месте»: смена deps — состояние загрузки; reload() — данные остаются на экране
 * (список не размонтируется, фокус и прокрутка сохраняются), пока не придёт новый ответ.
 */
export function useLiveAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): [Async<T>, () => void] {
  const [state, setState] = useState<Async<T>>({ status: "loading" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef({ n: 0 });
  const run = useCallback((keep: boolean) => {
    const counter = seq.current;
    const id = ++counter.n;
    if (!keep) setState({ status: "loading" });
    loadRef.current().then(
      (data) => id === counter.n && setState({ status: "ready", data }),
      (error: unknown) => id === counter.n && setState({ status: "error", error }),
    );
  }, []);
  useEffect(() => {
    const counter = seq.current;
    run(false);
    return () => {
      counter.n++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const reload = useCallback(() => run(true), [run]);
  return [state, reload];
}
