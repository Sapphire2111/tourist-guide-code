// Окружение экранов блока 5: доступ к API заявок/планов, контекст отеля из QR, роль персонала.
import { createContext, useContext, type ReactNode } from "react";
import type { HostApi } from "./types.js";

export type HostEnv = {
  api: HostApi;
  /** Заведение из QR отеля (placeId точки), иначе null — «Про заклад» недоступен. */
  hotelPlaceId: string | null;
  entryContextId: string | null;
  /** Роль ORG_STAFF (D-50): режим персонала. */
  staff: boolean;
};

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
    isStaff: async () => false,
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
