// Оформление одно — «modern»; выбор пользователя убран, старое сохранённое значение игнорируется.
import { createContext, useContext, useEffect, type ReactNode } from "react";

// "original" остаётся в типе, пока из компонентов не вычищены его ветки.
export type Design = "original" | "modern";
const Context = createContext<{ design: Design }>({ design: "modern" });
const VALUE: { design: Design } = { design: "modern" };
export function DesignProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.design = "modern";
  }, []);
  return <Context.Provider value={VALUE}>{children}</Context.Provider>;
}
export function useDesign() {
  return useContext(Context);
}
