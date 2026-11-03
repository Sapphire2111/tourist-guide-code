// Кнопка «Локація» на главной и нижний лист с мультивыбором населённых пунктов («Усі локації» — без фильтра).
// Выбор применяется сразу; лист закрывают «Готово», Escape, тап по фону и «Назад» Telegram.
import { pickLocalized } from "@tg/i18n";
import { useT } from "@tg/ui";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { interceptBack } from "../telegram.js";
import { LOCATION_MAX, useLocationNames, useLocations } from "./LocationProvider.js";
import "./location.css";

export function LocationChip() {
  const { t } = useT();
  const { options, gps, sheetOpen: open, setSheetOpen: setOpen } = useLocations();
  const names = useLocationNames();
  // Пунктов с местами меньше двух — выбирать нечего.
  if (!options || options.length < 2) return null;
  const label =
    names.length === 0
      ? gps
        ? t("miniapp.location.mine")
        : t("miniapp.location.all")
      : names.length === 1
        ? names[0]!
        : t("miniapp.location.more", { name: names[0]!, count: names.length - 1 });
  return (
    <>
      <button
        type="button"
        className="loc-chip"
        data-testid="location-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t("miniapp.location.title")}: ${label}`}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">📍</span>
        <span className="loc-chip-text">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
    </>
  );
}

/** Единственный лист «Локація»: открывается из чипа и подсказок «Змінити локацію»; закрывается при смене маршрута. */
export function LocationSheetHost({ path }: { path?: string }) {
  const { sheetOpen, setSheetOpen } = useLocations();
  const close = useCallback(() => setSheetOpen(false), [setSheetOpen]);
  useEffect(() => {
    setSheetOpen(false);
  }, [path, setSheetOpen]);
  return sheetOpen ? <LocationSheet onClose={close} /> : null;
}

function LocationSheet({ onClose }: { onClose: () => void }) {
  const { t, locale } = useT();
  const { options, selected, setSelected, gps, gpsBusy, gpsFailed, selectGps } = useLocations();
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const sheet = sheetRef.current;
    (
      sheet?.querySelector<HTMLElement>("input:checked") ?? sheet?.querySelector<HTMLElement>("input")
    )?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const releaseBack = interceptBack(onClose);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && sheetRef.current) {
        const items = [...sheetRef.current.querySelectorAll<HTMLElement>("input, button")];
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      releaseBack();
      opener?.focus();
    };
  }, [onClose]);
  const toggle = (id: string) =>
    setSelected(
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id].slice(0, LOCATION_MAX),
    );
  return createPortal(
    <div className="loc-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={sheetRef}
        className="loc-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="loc-sheet-title"
        aria-describedby="loc-sheet-hint"
        data-testid="location-sheet"
      >
        <h2 id="loc-sheet-title">{t("miniapp.location.title")}</h2>
        <p id="loc-sheet-hint" className="loc-hint">
          {t("miniapp.location.hint")}
        </p>
        <ul className="loc-list">
          <li>
            <label className="loc-option">
              <input type="checkbox" checked={gps !== null || gpsBusy} onChange={selectGps} />
              <span>{t("miniapp.location.mine")}</span>
            </label>
            {gpsBusy && (
              <p role="status" className="loc-hint">
                {t("miniapp.location.locating")}
              </p>
            )}
            {gpsFailed && (
              <p role="alert" className="loc-hint" data-testid="location-gps-failed">
                {t(gpsFailed === "outside" ? "miniapp.location.outside" : "miniapp.location.gpsFailed")}
              </p>
            )}
          </li>
          <li>
            <label className="loc-option">
              <input
                type="checkbox"
                checked={selected.length === 0 && gps === null && !gpsBusy}
                onChange={() => setSelected([])}
              />
              <span>{t("miniapp.location.all")}</span>
            </label>
          </li>
          {(options ?? []).map((o) => (
            <li key={o.id}>
              <label className="loc-option">
                <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                <span>{pickLocalized(o.name, locale)}</span>
              </label>
            </li>
          ))}
        </ul>
        <button type="button" className="loc-done" onClick={onClose}>
          {t("miniapp.location.done")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
