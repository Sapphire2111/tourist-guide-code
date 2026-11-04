// Фильтр удобств «Де жити»: кнопка «Зручності ▾» / «Зручності · 2» и нижний лист (тот же, что «Локація» и
// подкатегории) с флажками. Выбор применяется сразу (выдача — только места со ВСЕМИ отмеченными, И); лист закрывают
// «Готово», Escape, тап по фону и «Назад» Telegram. Счётчик у пункта — мест с этим удобством в разделе (без учёта
// других отметок); удобства без мест скрыты, кроме уже отмеченных. Данные — Google Maps (часть — по отзывам гостей).
import { type MessageKey } from "@tg/i18n";
import { useT } from "@tg/ui";
import { useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSheet } from "./use-sheet.js";
import "./location.css";
import "./subcategory-select.css";
import "./amenity-filter.css";

/** Удобства фильтра — коды тегов каталога (places:amenities), порядок показа. */
export const LODGING_AMENITIES = [
  "pool",
  "sauna",
  "hot-tub",
  "breakfast",
  "parking",
  "kitchen",
  "wifi",
  "kids",
  "pets",
] as const;

const ICON: Record<(typeof LODGING_AMENITIES)[number], string> = {
  pool: "🏊",
  sauna: "🧖",
  "hot-tub": "♨️",
  breakfast: "🥐",
  parking: "🅿️",
  kitchen: "🍳",
  wifi: "📶",
  kids: "🧸",
  pets: "🐾",
};

export function AmenityFilter({
  value,
  onChange,
  counts,
  onOpen,
}: {
  value: readonly string[];
  onChange: (codes: string[]) => void;
  /** Мест по коду тега; null — счётчиков нет (не загружены или api без метода): показываются все удобства. */
  counts: Readonly<Record<string, number>> | null;
  /** Лист открыт — повод загрузить счётчики. */
  onOpen?: () => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const label = value.length
    ? t("miniapp.amenityFilter.selected", { count: value.length })
    : t("miniapp.amenityFilter.title");
  return (
    <>
      <button
        type="button"
        className="subcat-trigger"
        data-testid="amenity-filter"
        data-active={value.length ? "true" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          onOpen?.();
        }}
      >
        <span className="subcat-trigger-text">{label}</span>
        <span className="subcat-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && <AmenitySheet value={value} onChange={onChange} counts={counts} onClose={close} />}
    </>
  );
}

function AmenitySheet({
  value,
  onChange,
  counts,
  onClose,
}: {
  value: readonly string[];
  onChange: (codes: string[]) => void;
  counts: Readonly<Record<string, number>> | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const titleId = useId();
  const hintId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  useSheet(sheetRef, onClose);
  const shown = LODGING_AMENITIES.filter((c) => counts === null || (counts[c] ?? 0) > 0 || value.includes(c));
  const toggle = (code: string) =>
    // Порядок кодов — как в списке: тот же выбор — тот же ключ запроса.
    onChange(LODGING_AMENITIES.filter((c) => (c === code ? !value.includes(c) : value.includes(c))));
  return createPortal(
    <div className="loc-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={sheetRef}
        className="loc-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        data-testid="amenity-sheet"
      >
        <h2 id={titleId}>{t("miniapp.amenityFilter.title")}</h2>
        <p id={hintId} className="loc-hint">
          {t("miniapp.amenityFilter.hint")}
        </p>
        <ul className="loc-list">
          {shown.map((code) => {
            const n = counts?.[code];
            return (
              <li key={code}>
                <label className="loc-option amenity-option">
                  <input
                    type="checkbox"
                    value={code}
                    checked={value.includes(code)}
                    onChange={() => toggle(code)}
                  />
                  <span aria-hidden="true">{ICON[code]}</span>
                  <span className="amenity-name">{t(`miniapp.amenityFilter.${code}` as MessageKey)}</span>
                  {n !== undefined && (
                    <span
                      className="amenity-count"
                      aria-label={t("miniapp.amenityFilter.count", { count: n })}
                    >
                      {n}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
        <div className="amenity-actions">
          <button
            type="button"
            className="amenity-reset"
            disabled={value.length === 0}
            onClick={() => onChange([])}
            data-testid="amenity-reset"
          >
            {t("miniapp.amenityFilter.reset")}
          </button>
          <button type="button" className="loc-done" onClick={onClose}>
            {t("miniapp.amenityFilter.done")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
