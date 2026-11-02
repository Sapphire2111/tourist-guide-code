// Выбранный курорт коридора Н-09: фильтрует выдачу главной, каталога и поиска (выбора в интерфейсе пока нет —
// App включает провайдер выключенным, выдача от QR-контекста / всего региона).
// Выбор запоминается на устройстве; по умолчанию — «Усе Прикарпаття» (весь регион, как без свайпера).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useT } from "@tg/ui";
import {
  isResortId,
  resortById,
  RESORT_STORAGE_KEY,
  RESORTS,
  type Resort,
  type ResortId,
} from "./resorts.js";

type ResortState = { resort: Resort; setResort: (id: ResortId) => void };

const ResortContext = createContext<ResortState>({ resort: RESORTS[0]!, setResort: () => undefined });

function readResort(): ResortId {
  try {
    const v = window.localStorage.getItem(RESORT_STORAGE_KEY);
    return isResortId(v) ? v : "all";
  } catch {
    return "all";
  }
}

function storeResort(id: ResortId): void {
  try {
    if (id === "all") window.localStorage.removeItem(RESORT_STORAGE_KEY);
    else window.localStorage.setItem(RESORT_STORAGE_KEY, id);
  } catch {
    // Не сохранилось — выбор действует до закрытия.
  }
}

/**
 * enabled — регион курортов (иначе всегда «весь регион»). venueEntry — вход по QR заведения: сохранённый курорт
 * сбрасывается, базовая точка выдачи — само заведение.
 */
export function ResortProvider({
  enabled = true,
  venueEntry = false,
  children,
}: {
  enabled?: boolean;
  venueEntry?: boolean;
  children?: ReactNode;
}) {
  const [id, setId] = useState<ResortId>(readResort);
  /** Курорт выбран в этом открытии (после входа по QR — выбор туриста важнее заведения). */
  const [picked, setPicked] = useState(false);
  // Эффективный курорт считается при рендере: первый же запрос при входе по QR — уже от заведения.
  const effective: ResortId = !enabled || (venueEntry && !picked) ? "all" : id;
  // Хранилище — вслед: сохранённый курорт не вернётся при следующем открытии того же QR.
  useEffect(() => {
    if (venueEntry && !picked) storeResort("all");
  }, [venueEntry, picked]);
  const setResort = useCallback((next: ResortId) => {
    storeResort(next);
    setId(next);
    setPicked(true);
  }, []);
  const value = useMemo(() => ({ resort: resortById(effective), setResort }), [effective, setResort]);
  return <ResortContext.Provider value={value}>{children}</ResortContext.Provider>;
}

export function useResort(): ResortState {
  return useContext(ResortContext);
}

/** Подпись выдачи по курорту: «Поблизу: Яремче (до 4,5 км від центру)»; весь регион — ничего. */
export function useResortCaption(): string | null {
  const { t, locale } = useT();
  const { resort } = useResort();
  if (!resort.area) return null;
  const km = new Intl.NumberFormat(locale === "uk" ? "uk-UA" : "en-GB", { maximumFractionDigits: 1 }).format(
    resort.area.radius / 1000,
  );
  return t("miniapp.resort.near", { name: t(resort.name), km });
}
