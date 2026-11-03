// Пользовательский выбор оформления; состояние маршрутов и сессии при смене не сбрасывается.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useT } from "@tg/ui";

export type Design = "original" | "modern";
export const DESIGN_STORAGE_KEY = "tg.design";
export function readDesign(): Design {
  try {
    return localStorage.getItem(DESIGN_STORAGE_KEY) === "modern" ? "modern" : "original";
  } catch {
    return "original";
  }
}
const Context = createContext<{ design: Design; setDesign: (design: Design) => void }>({
  design: "original",
  setDesign: () => undefined,
});
export function DesignProvider({ children }: { children: ReactNode }) {
  const [design, setState] = useState<Design>(readDesign);
  useEffect(() => {
    document.documentElement.dataset.design = design;
  }, [design]);
  const setDesign = (next: Design) => {
    setState(next);
    try {
      localStorage.setItem(DESIGN_STORAGE_KEY, next);
    } catch {
      /* WebView может запретить хранилище. */
    }
  };
  return <Context.Provider value={{ design, setDesign }}>{children}</Context.Provider>;
}
export function useDesign() {
  return useContext(Context);
}
export function DesignSwitcher({ onPicked }: { onPicked?: () => void } = {}) {
  const { design, setDesign } = useDesign();
  const { t } = useT();
  return (
    <div className="design-switch" role="group" aria-label={t("miniapp.design.label")}>
      {(["original", "modern"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={design === value}
          onClick={() => {
            setDesign(value);
            onPicked?.();
          }}
        >
          {t(`miniapp.design.${value}`)}
        </button>
      ))}
    </div>
  );
}
