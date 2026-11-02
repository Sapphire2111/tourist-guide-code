// Окружение кабинета партнёра: API, регион входа, назначения пользователя (GET /partner/me) и выбранные
// организация/заведение (P13). /partner/me грузится только с сессией и при включённом module.partner_cabinet.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Async } from "../guide/context.js";
import { useLiveAsync } from "../host/context.js";
import type { PartnerApi, PartnerMe, PartnerOrganization, PartnerPlaceSummary } from "./partner-api.js";

export type Selection = { orgId: string | null; placeId: string | null };

export type PartnerEnv = {
  api: PartnerApi;
  regionId: string | null;
  /** Есть сессия и модуль включён: можно звать /partner/*. */
  enabled: boolean;
  me: Async<PartnerMe> | { status: "off" };
  reloadMe: () => void;
  selection: Selection;
  select: (s: Selection) => void;
};

const PartnerContext = createContext<PartnerEnv | null>(null);

export function PartnerProvider({
  api,
  regionId,
  enabled,
  children,
}: {
  api: PartnerApi;
  regionId: string | null;
  enabled: boolean;
  children?: ReactNode;
}) {
  const [me, reload] = useLiveAsync<PartnerMe | null>(
    () => (enabled ? api.me() : Promise.resolve(null)),
    [api, enabled],
  );
  const [selection, setSelection] = useState<Selection>({ orgId: null, placeId: null });
  const select = useCallback((s: Selection) => setSelection(s), []);
  const value = useMemo<PartnerEnv>(
    () => ({
      api,
      regionId,
      enabled,
      me:
        !enabled || (me.status === "ready" && me.data === null)
          ? { status: "off" }
          : (me as Async<PartnerMe>),
      reloadMe: reload,
      selection,
      select,
    }),
    [api, regionId, enabled, me, reload, selection, select],
  );
  return <PartnerContext.Provider value={value}>{children}</PartnerContext.Provider>;
}

export function usePartner(): PartnerEnv {
  const env = useContext(PartnerContext);
  if (!env) throw new Error("PartnerProvider не подключён");
  return env;
}

/** Есть хотя бы одно назначение в организации (показывать переключатель P13). */
export function usePartnerOrgs(): PartnerOrganization[] {
  const { me } = usePartner();
  return me.status === "ready" ? me.data.organizations : [];
}

/** Выбранные организация и заведение: сохранённый выбор, иначе первые доступные. */
export function resolveSelection(
  orgs: readonly PartnerOrganization[],
  s: Selection,
): { org: PartnerOrganization | null; place: PartnerPlaceSummary | null } {
  const org = orgs.find((o) => o.id === s.orgId) ?? orgs[0] ?? null;
  const place = org ? (org.places.find((p) => p.id === s.placeId) ?? org.places[0] ?? null) : null;
  return { org, place };
}

/** Организация заведения из /partner/me. */
export function orgOfPlace(
  orgs: readonly PartnerOrganization[],
  placeId: string,
): PartnerOrganization | null {
  return orgs.find((o) => o.places.some((p) => p.id === placeId)) ?? null;
}

/** Заглушка API для тестов: все методы отклоняются. */
export function noopPartnerApi(): PartnerApi {
  const fail = () => Promise.reject(new Error("no api"));
  return new Proxy({} as PartnerApi, { get: () => fail });
}

/** Перечитать /partner/me при монтировании экрана (статус модерации мог смениться). */
export function useRefreshMe() {
  const { reloadMe, enabled } = usePartner();
  useEffect(() => {
    if (enabled) reloadMe();
  }, [enabled, reloadMe]);
}
