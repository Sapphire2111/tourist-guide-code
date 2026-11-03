// «Локація»: выбранные туристом населённые пункты региона (GET /localities) фильтруют выдачу главной, каталогов
// разделов и текстового поиска (localityIds в GET /places/search). «Що поруч» выбор не применяет — там выдача от
// позиции туриста. Выбор запоминается на устройстве по региону; пусто — «Усі локації» (весь регион).
import { pickLocalized } from "@tg/i18n";
import { useT } from "@tg/ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMaybeGuide } from "./context.js";
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
};

const EMPTY: readonly string[] = [];
const LocationContext = createContext<LocationState>({
  options: null,
  selected: EMPTY,
  setSelected: () => undefined,
});

type Stored = { regionId: string; ids: string[] };

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

function store(regionId: string | null, ids: readonly string[]): void {
  try {
    if (!regionId || ids.length === 0) window.localStorage.removeItem(LOCATION_STORAGE_KEY);
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
  children,
}: {
  venueEntry?: boolean;
  children?: ReactNode;
}) {
  const guide = useMaybeGuide();
  const api = guide?.api;
  const regionId = guide?.regionId ?? null;
  const [ids, setIds] = useState<readonly string[]>(() => readStored(regionId));
  const [picked, setPicked] = useState(false);
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

  const setSelected = useCallback(
    (next: readonly string[]) => {
      const clean = [...new Set(next)].slice(0, LOCATION_MAX);
      store(regionId, clean);
      setIds(clean);
      setPicked(true);
    },
    [regionId],
  );

  const options = list.status === "ready" ? list.data : null;
  // Пока список грузится — сохранённый выбор (первый запрос сразу с фильтром); список недоступен — без фильтра
  // (турист не увидел бы, что выдача ограничена); пункты, которых больше нет, отбрасываются.
  // Выбирать не из чего (меньше двух пунктов, кнопки нет) — сохранённый выбор не применяется.
  const raw = (venueEntry && !picked) || (options && options.length < 2) ? EMPTY : ids;
  const key =
    list.status === "error" ? "" : raw.filter((id) => !options || options.some((o) => o.id === id)).join(",");
  const selected = useMemo(() => (key ? key.split(",") : EMPTY), [key]);
  const value = useMemo(() => ({ options, selected, setSelected }), [options, selected, setSelected]);
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
  return names.length ? t("miniapp.location.caption", { names: names.join(", ") }) : null;
}
