// Состояние экрана, привязанное к записи истории (back.ts): уход вперёд и возврат «Назад» его сохраняют,
// новый заход на тот же экран — новая запись и чистое состояние.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { currentEntryKey, deleteSlot, focusScreenHeading, readSlot, writeSlot } from "./back.js";
import { interceptBack } from "./telegram.js";

/**
 * Как useState, но значение переживает уход с экрана по истории. `inMemoryOnly` — не писать в sessionStorage
 * (координаты устройства, персональные данные). Значение должно сериализоваться в JSON. Экран размонтирован без
 * смены записи (та же запись, но другой экран или повтор загрузки) — значение забывается.
 */
export function useScreenState<T>(
  slot: string,
  initial: T | (() => T),
  { inMemoryOnly = false }: { inMemoryOnly?: boolean } = {},
): [T, Dispatch<SetStateAction<T>>] {
  const [entry] = useState(currentEntryKey);
  const [value, setValue] = useState<T>(() => {
    const saved = readSlot(entry, slot, inMemoryOnly);
    if (saved !== undefined) return saved as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    writeSlot(entry, slot, latest.current, inMemoryOnly);
    return () => {
      if (currentEntryKey() === entry) deleteSlot(entry, slot, inMemoryOnly);
    };
  }, [entry, slot, inMemoryOnly]);
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(latest.current) : next;
      latest.current = v;
      writeSlot(entry, slot, v, inMemoryOnly);
      setValue(v);
    },
    [entry, slot, inMemoryOnly],
  );
  return [value, set];
}

/**
 * Пока `active`, «Назад» выполняет `fn` (шаг формы, деталь внутри экрана, подраздел), а не уходит с экрана.
 * Шаг убрал элемент с фокусом — фокус на прежний элемент или заголовок экрана, а не теряется в body.
 */
export function useBackStep(active: boolean, fn: () => void): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return interceptBack(() => {
      latest.current();
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
        else focusScreenHeading();
      }, 0);
    });
  }, [active]);
}
