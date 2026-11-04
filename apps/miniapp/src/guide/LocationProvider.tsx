// «Локація»: выбранные туристом населённые пункты региона (GET /localities) фильтруют выдачу главной, каталогов
// разделов и текстового поиска (localityIds в GET /places/search). «Що поруч» выбор не применяет — там выдача от
// позиции туриста. Выбор запоминается на устройстве по региону; пусто — «Усі локації» (весь регион).
import { pickLocalized } from "@tg/i18n";
import { useT } from "@tg/ui";
import {
  createContext,
  useCallback,
  useRef,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMaybeGuide } from "./context.js";
import { distanceMeters, requestLocation, requestLocationIfGranted, type LatLng } from "./geo.js";
import type { GuideApi, PlaceSummary, SearchParams } from "./types.js";
import type { LocalityOption } from "./types.js";

export const LOCATION_STORAGE_KEY = "tg.localities";
/** Больше не принимает api (SEARCH_LOCALITIES_MAX). */
export const LOCATION_MAX = 10;

export type LocationState = {
  /** Пункты региона, где есть места; null — список ещё грузится или недоступен. */
  options: LocalityOption[] | null;
  /** Действующий выбор (id); пусто — весь регион. */
  selected: readonly string[];
  setSelected: (ids: readonly string[]) => void;
  /** Режим «Моє місцезнаходження»: точка устройства; null — режим выключен (выбор пунктов или весь регион). */
  gps: LatLng | null;
  /** Идёт определение точки (выбор пункта «Моє місцезнаходження»). */
  gpsBusy: boolean;
  /** Явный выбор не удался: нет точки/отказ или точка вне региона; выбор откачен на «Усі локації». */
  gpsFailed: "denied" | "outside" | null;
  selectGps: () => void;
  /** Лист «Локація» открыт (из чипа или подсказки «Змінити локацію»). */
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  /** Турист сам выбрал локацию (пункты, «Усі локації» или «Моє місцезнаходження»); иначе — значение по умолчанию. */
  chosen: boolean;
};

/** Радиус выдачи вокруг точки устройства, м; найдено меньше GPS_MIN_PLACES — расширяется до GPS_RADIUS_WIDE. */
export const GPS_RADIUS = 3_000;
export const GPS_RADIUS_WIDE = 10_000;
export const GPS_MIN_PLACES = 5;
/** Авто-режим включается, только если точка не дальше стольких метров от ближайшего пункта региона. */
export const REGION_REACH_M = 15_000;
/** Сообщение об отказе/выходе за регион гаснет само, мс. */
const FAILED_MS = 6_000;

/** Поиск вокруг точки устройства: радиус GPS_RADIUS, мало результатов — GPS_RADIUS_WIDE; radius — фактически использованный. */
export async function searchAround(
  search: GuideApi["search"],
  params: SearchParams,
  gps: LatLng,
): Promise<{ list: PlaceSummary[]; radius: number }> {
  const first = await search({ ...params, point: gps, radius: GPS_RADIUS });
  if (first.length >= GPS_MIN_PLACES) return { list: first, radius: GPS_RADIUS };
  const wide = await search({ ...params, point: gps, radius: GPS_RADIUS_WIDE });
  return wide.length >= first.length
    ? { list: wide, radius: GPS_RADIUS_WIDE }
    : { list: first, radius: GPS_RADIUS };
}

/** Точка в регионе: рядом с каким-либо пунктом; координат пунктов нет — проверить нечем (null). */
function inRegion(point: LatLng, options: readonly LocalityOption[]): boolean | null {
  const centers = options.flatMap((o) => (o.location ? [o.location] : []));
  if (centers.length === 0) return null;
  return centers.some((c) => distanceMeters(point, c) <= REGION_REACH_M);
}

const EMPTY: readonly string[] = [];
const LocationContext = createContext<LocationState>({
  options: null,
  selected: EMPTY,
  setSelected: () => undefined,
  gps: null,
  gpsBusy: false,
  gpsFailed: null,
  selectGps: () => undefined,
  sheetOpen: false,
  setSheetOpen: () => undefined,
  chosen: true,
});

/** mode "all" — турист сам выбрал «Усі локації»: GPS по умолчанию не включается. */
type Stored = { regionId: string; ids: string[]; mode?: "all" };

function readMode(regionId: string | null): boolean {
  if (!regionId) return false;
  try {
    const raw = window.localStorage.getItem(LOCATION_STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
    return v?.regionId === regionId && v.mode === "all";
  } catch {
    return false;
  }
}

function readStored(regionId: string | null): string[] {
  if (!regionId) return [];
  try {
    const raw = window.localStorage.getItem(LOCATION_STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
    return v?.regionId === regionId && Array.isArray(v.ids)
      ? v.ids.filter((x): x is string => typeof x === "string").slice(0, LOCATION_MAX)
      : [];
  } catch {
    return [];
  }
}

function store(regionId: string | null, ids: readonly string[], explicitAll = false): void {
  try {
    if (!regionId || (ids.length === 0 && !explicitAll)) window.localStorage.removeItem(LOCATION_STORAGE_KEY);
    else if (ids.length === 0)
      window.localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId, ids, mode: "all" }));
    else window.localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId, ids }));
  } catch {
    // Не сохранилось — выбор действует до закрытия.
  }
}

/**
 * Внутри GuideProvider (нужны api и регион). venueEntry — вход по QR заведения: сохранённый выбор не применяется
 * (выдача — от заведения), пока турист не выберет локацию в этом открытии.
 */
export function LocationProvider({
  venueEntry = false,
  entryKey,
  children,
}: {
  venueEntry?: boolean;
  /** Меняется при каждом входе по QR (в т.ч. скан внутри приложения): GPS-режим сбрасывается. */
  entryKey?: string;
  children?: ReactNode;
}) {
  const guide = useMaybeGuide();
  const api = guide?.api;
  const regionId = guide?.regionId ?? null;
  const [ids, setIds] = useState<readonly string[]>(() => readStored(regionId));
  const [picked, setPicked] = useState(false);
  const webApp = guide?.webApp;
  const [explicitAll, setExplicitAll] = useState(() => readMode(regionId));
  const [point, setPoint] = useState<LatLng | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsFailed, setGpsFailed] = useState<"denied" | "outside" | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [list, setList] = useState<
    { status: "loading" | "error" } | { status: "ready"; data: LocalityOption[] }
  >({
    status: "loading",
  });

  // Хранилище бывших «курортов» (заменены локациями) — убрать один раз.
  useEffect(() => {
    try {
      window.localStorage.removeItem("tg.resort");
    } catch {
      // Недоступно — нечего убирать.
    }
  }, []);

  useEffect(() => {
    setIds(readStored(regionId));
    setExplicitAll(readMode(regionId));
    if (!api || !regionId) {
      setList({ status: "error" });
      return;
    }
    let alive = true;
    setList({ status: "loading" });
    api.localities().then(
      (data) => alive && setList({ status: "ready", data: data.filter((l) => l.placeCount > 0) }),
      () => alive && setList({ status: "error" }),
    );
    return () => {
      alive = false;
    };
  }, [api, regionId]);

  // Хранилище — вслед за входом по QR: сохранённый выбор не вернётся при следующем открытии того же QR.
  useEffect(() => {
    if (venueEntry && !picked) store(regionId, []);
  }, [venueEntry, picked, regionId]);

  // Номер попытки определения точки: устаревший ответ (новый скан QR, явный выбор) не применяется.
  const attempt = useRef(0);

  // Вход по QR заведения (в т.ч. скан внутри приложения): точка заведения главнее GPS.
  useEffect(() => {
    if (!venueEntry) return;
    attempt.current++;
    setPicked(false);
    setPoint(null);
    setGpsFailed(null);
    setGpsBusy(false);
  }, [venueEntry, entryKey]);

  // Закрыли лист — сообщение об отказе больше не нужно.
  useEffect(() => {
    if (!sheetOpen) setGpsFailed(null);
  }, [sheetOpen]);

  // Сообщение гаснет само.
  useEffect(() => {
    if (!gpsFailed) return;
    const timer = setTimeout(() => setGpsFailed(null), FAILED_MS);
    return () => clearTimeout(timer);
  }, [gpsFailed]);

  const setSelected = useCallback(
    (next: readonly string[]) => {
      const clean = [...new Set(next)].slice(0, LOCATION_MAX);
      // Пустой выбор — явное «Усі локації»: GPS по умолчанию больше не включается.
      store(regionId, clean, true);
      setIds(clean);
      setExplicitAll(clean.length === 0);
      setPoint(null);
      setGpsFailed(null);
      setPicked(true);
    },
    [regionId],
  );

  const optionsRef = useRef<LocalityOption[] | null>(null);
  const selectGps = useCallback(() => {
    store(regionId, []);
    setIds([]);
    setExplicitAll(false);
    setPicked(true);
    setGpsFailed(null);
    setGpsBusy(true);
    const mine = ++attempt.current;
    void requestLocation(webApp).then((p) => {
      if (mine !== attempt.current) return;
      setGpsBusy(false);
      const inside = p && optionsRef.current ? inRegion(p, optionsRef.current) : null;
      if (p && inside !== false) setPoint(p);
      else {
        // Отказ, нет точки или точка вне региона: откат на «Усі локації» (в хранилище не пишем — не явный выбор).
        setPoint(null);
        setGpsFailed(p ? "outside" : "denied");
      }
    });
  }, [regionId, webApp]);

  const options = list.status === "ready" ? list.data : null;
  optionsRef.current = options;
  // Пока список грузится — сохранённый выбор (первый запрос сразу с фильтром); список недоступен — без фильтра
  // (турист не увидел бы, что выдача ограничена); пункты, которых больше нет, отбрасываются.
  // Выбирать не из чего (меньше двух пунктов, кнопки нет) — сохранённый выбор не применяется.
  const raw = (venueEntry && !picked) || (options && options.length < 2) ? EMPTY : ids;
  const key =
    list.status === "error" ? "" : raw.filter((id) => !options || options.some((o) => o.id === id)).join(",");
  const selected = useMemo(() => (key ? key.split(",") : EMPTY), [key]);
  // По умолчанию (ничего не выбрано, не «Усі локації» явно, не вход по QR, есть из чего выбирать) — вокруг точки
  // устройства, но только если доступ уже выдан (без запроса на старте) и точка в регионе; иначе весь регион, молча.
  const canAuto =
    !(venueEntry && !picked) && !explicitAll && selected.length === 0 && !!options && options.length >= 2;
  useEffect(() => {
    // Одна попытка за раз: пока идёт явный выбор, авто-проверка не стартует.
    if (!canAuto || !options || gpsBusy) return;
    const mine = ++attempt.current;
    void requestLocationIfGranted(webApp).then((p) => {
      if (mine === attempt.current && p && inRegion(p, options) === true) setPoint(p);
    });
    // Один запрос на смену условий; options нужен только для проверки региона.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAuto, webApp]);
  const gps =
    selected.length === 0 && !explicitAll && !(venueEntry && !picked) && options && options.length >= 2
      ? point
      : null;
  // Явный выбор: в этом сеансе или сохранённый (пункты / «Усі локації»); вход по QR заведения сбрасывает его.
  const chosen = picked || (!venueEntry && (ids.length > 0 || explicitAll));
  const value = useMemo(
    () => ({
      options,
      selected,
      setSelected,
      gps,
      gpsBusy,
      gpsFailed,
      selectGps,
      sheetOpen,
      setSheetOpen,
      chosen,
    }),
    [options, selected, setSelected, gps, gpsBusy, gpsFailed, selectGps, sheetOpen, chosen],
  );
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useLocations(): LocationState {
  return useContext(LocationContext);
}

/** Названия выбранных пунктов по порядку списка; пока список не пришёл — пусто. */
export function useLocationNames(): string[] {
  const { locale } = useT();
  const { options, selected } = useLocations();
  if (!options) return [];
  return options.filter((o) => selected.includes(o.id)).map((o) => pickLocalized(o.name, locale));
}

/** Подпись выдачи: «Локація: Яремче, Татарів»; без выбора — ничего. */
export function useLocationCaption(): string | null {
  const { t } = useT();
  const names = useLocationNames();
  const { gps } = useLocations();
  if (gps) return t("miniapp.location.caption", { names: t("miniapp.location.mine") });
  return names.length ? t("miniapp.location.caption", { names: names.join(", ") }) : null;
}
