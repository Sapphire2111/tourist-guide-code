// Выбранный курорт коридора Н-09 (свайпер под шапкой): фильтрует выдачу главной, каталога и поиска.
// Выбор запоминается на устройстве; по умолчанию — «Усе Прикарпаття» (весь регион, как без свайпера).
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
  useEffect(() => {
    if (!venueEntry) return;
    storeResort("all");
    setId("all");
  }, [venueEntry]);
  const setResort = useCallback((next: ResortId) => {
    storeResort(next);
    setId(next);
  }, []);
  const value = useMemo(
    () => ({ resort: resortById(enabled ? id : "all"), setResort }),
    [enabled, id, setResort],
  );
  return <ResortContext.Provider value={value}>{children}</ResortContext.Provider>;
}

export function useResort(): ResortState {
  return useContext(ResortContext);
}

/** Липкий свайпер курортов: горизонтальные пиллы, активный — цвет акцента. */
export function ResortSwiper() {
  const { t } = useT();
  const { resort, setResort } = useResort();
  const active = useRef<HTMLButtonElement>(null);
  // Выбранный курорт виден и после перезапуска (прокрутка к нему без анимации).
  useEffect(() => {
    active.current?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [resort.id]);
  return (
    <div
      className="kosiv-resorts"
      role="group"
      aria-label={t("miniapp.resort.label")}
      data-testid="resort-swiper"
    >
      {RESORTS.map((r) => {
        const on = r.id === resort.id;
        return (
          <button
            key={r.id}
            ref={on ? active : undefined}
            type="button"
            className="kosiv-resort"
            aria-pressed={on}
            data-resort={r.id}
            onClick={() => setResort(r.id)}
          >
            <span className="kosiv-resort-name">{t(r.name)}</span>
            <span className="kosiv-resort-meta">{t(r.meta.key, r.meta.params)}</span>
          </button>
        );
      })}
    </div>
  );
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
