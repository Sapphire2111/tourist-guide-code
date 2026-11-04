// Общее поведение нижних листов (LocationPicker, SubcategorySelect): фокус внутрь и возврат на кнопку-открывалку,
// блокировка прокрутки страницы, «Назад» Telegram, Escape и фокус-ловушка по реальным Tab-остановкам.
import { useEffect, type RefObject } from "react";
import { interceptBack } from "../telegram.js";

/** Элементы листа, до которых доходит Tab (tabIndex >= 0, не disabled): у радиогруппы — только отмеченная. */
export function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("input, button")].filter(
    (el) => !(el as HTMLInputElement).disabled && el.tabIndex >= 0,
  );
}

export function useSheet(sheetRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = sheetRef.current;
    (
      sheet?.querySelector<HTMLElement>("input:checked, [role=radio][aria-checked=true]") ??
      tabStops(sheet ?? document.body)[0]
    )?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const releaseBack = interceptBack(onClose);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && sheetRef.current) {
        const items = tabStops(sheetRef.current);
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !sheetRef.current.contains(active))) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && (active === last || !sheetRef.current.contains(active))) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    // Фокус, всё же ушедший из листа (например, на радио без Tab-остановки), возвращаем внутрь.
    const onFocusIn = (e: FocusEvent) => {
      const s = sheetRef.current;
      if (s && e.target instanceof Node && !s.contains(e.target)) tabStops(s)[0]?.focus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      document.body.style.overflow = overflow;
      releaseBack();
      opener?.focus();
    };
  }, [onClose, sheetRef]);
}
