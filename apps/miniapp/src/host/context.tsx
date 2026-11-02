// Окружение экранов блока 5: доступ к API заявок/планов, контекст отеля из QR, роль персонала.
import { createContext, useContext, type ReactNode } from "react";
import type { HostApi, RoomContext } from "./types.js";

export type HostEnv = {
  api: HostApi;
  /** Заведение из QR отеля (placeId точки), иначе null — «Про заклад» недоступен. */
  hotelPlaceId: string | null;
  /** Номер комнаты из QR номера (D-49, источник «qr»). */
  qrRoom: string | null;
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
    staffRequests: fail,
    setStatus: fail,
    scenarios: fail,
    scenario: fail,
    plans: fail,
    savePlan: fail,
    updatePlan: fail,
  };
}

export function roomOf(qrRoom: string | null, typed: string): RoomContext | null {
  if (qrRoom) return { value: qrRoom, source: "qr" };
  const v = typed.trim();
  return v ? { value: v, source: "guest" } : null;
}
