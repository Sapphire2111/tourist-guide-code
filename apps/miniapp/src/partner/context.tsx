// Окружение кабинета партнёра: API, регион входа, назначения пользователя (GET /partner/me) и выбранные
// организация/заведение (P13). /partner/me грузится только с сессией и при включённом module.partner_cabinet.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Async } from "../guide/context.js";
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
  /** Сообщение для кабинета после перехода (например, «Ви вже працюєте…» из P14). */
  notice: string | null;
  setNotice: (text: string | null) => void;
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
  const [me, reload] = useKeptAsync<PartnerMe | null>(
    () => (enabled ? api.me() : Promise.resolve(null)),
    [api, enabled],
  );
  const [selection, setSelection] = useState<Selection>({ orgId: null, placeId: null });
  const select = useCallback((s: Selection) => setSelection(s), []);
  const [notice, setNotice] = useState<string | null>(null);
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
      notice,
      setNotice,
    }),
    [api, regionId, enabled, me, reload, selection, select, notice],
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

/**
 * Перечитать /partner/me при открытии экрана (статус модерации мог смениться). Первая загрузка провайдера ещё
 * идёт — второй запрос не нужен.
 */
export function useRefreshMe() {
  const { reloadMe, enabled, me } = usePartner();
  const loadedAtMount = useRef(me.status === "ready");
  useEffect(() => {
    if (enabled && loadedAtMount.current) reloadMe();
  }, [enabled, reloadMe]);
}

/**
 * Загрузка с обновлением «на месте» (как useLiveAsync блока 5), но неудачное перечитывание не стирает данные:
 * состояние остаётся ready, ошибка — в refreshError (показать рядом). Смена deps — заново с загрузкой.
 */
export function useKeptAsync<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): [Async<T>, () => void, unknown] {
  const [state, setState] = useState<Async<T>>({ status: "loading" });
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef({ n: 0 });
  // Последнее состояние — для решения «оставить данные или показать ошибку» без побочных эффектов в updater.
  const stateRef = useRef(state);
  stateRef.current = state;
  const run = useCallback((keep: boolean) => {
    const counter = seq.current;
    const id = ++counter.n;
    // Повтор из ошибки (данных нет) — снова загрузка; при данных — обновление на месте.
    const inPlace = keep && stateRef.current.status === "ready";
    if (!inPlace) setState({ status: "loading" });
    setRefreshError(null);
    loadRef.current().then(
      (data) => id === counter.n && setState({ status: "ready", data }),
      (error: unknown) => {
        if (id !== counter.n) return;
        if (inPlace) setRefreshError(error);
        else setState({ status: "error", error });
      },
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
  return [state, reload, refreshError];
}
