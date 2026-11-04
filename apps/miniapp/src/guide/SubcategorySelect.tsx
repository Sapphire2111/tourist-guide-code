// Одна кнопка вместо ряда чипов подкатегорий/фильтров: «Шукати все ▾» или «<выбранное> ▾».
// Нажатие открывает нижний лист (тот же вид, что у «Локація») с радио-выбором; выбор применяется сразу и закрывает лист.
// Закрытие: тап по фону, Escape, «Закрити», «Назад» Telegram.
import { useT } from "@tg/ui";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { interceptBack } from "../telegram.js";
import "./location.css";
import "./subcategory-select.css";

export interface SubcategoryOption {
  id: string;
  label: string;
  /** Необязательный значок/эмодзи перед названием (декоративный). */
  icon?: ReactNode;
}

/**
 * `options[0]` — пункт «Шукати все» (его id — значение «ничего не выбрано»); подпись берётся из общего ключа.
 * `title` — название списка (заголовок листа и часть доступного имени кнопки).
 */
export function SubcategorySelect({
  title,
  options,
  value,
  onChange,
  className,
  testId = "subcategory-select",
}: {
  title: string;
  options: readonly SubcategoryOption[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
  testId?: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const allId = options[0]?.id;
  const current = options.find((o) => o.id === value);
  const label = !current || current.id === allId ? t("miniapp.subcategory.all") : current.label;
  return (
    <>
      <button
        type="button"
        className={className ? `subcat-trigger ${className}` : "subcat-trigger"}
        data-testid={testId}
        data-all={!current || current.id === allId ? "true" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${title}: ${label}`}
        onClick={() => setOpen(true)}
      >
        <span className="subcat-trigger-text">{label}</span>
        <span className="subcat-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <SubcategorySheet
          title={title}
          options={options}
          value={current?.id ?? allId ?? ""}
          onPick={(id) => {
            onChange(id);
            close();
          }}
          onClose={close}
        />
      )}
    </>
  );
}

function SubcategorySheet({
  title,
  options,
  value,
  onPick,
  onClose,
}: {
  title: string;
  options: readonly SubcategoryOption[];
  value: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const titleId = useId();
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
  const name = useId();
  return createPortal(
    <div className="loc-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={sheetRef}
        className="loc-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="subcategory-sheet"
      >
        <h2 id={titleId}>{title}</h2>
        <ul className="loc-list" role="radiogroup" aria-labelledby={titleId}>
          {options.map((o, i) => (
            <li key={o.id} role="presentation">
              <label className="loc-option">
                <input
                  type="radio"
                  name={name}
                  checked={o.id === value}
                  onChange={() => onPick(o.id)}
                  // Повторный тап по уже выбранному пункту тоже закрывает лист.
                  onClick={() => o.id === value && onPick(o.id)}
                />
                {o.icon != null && <span aria-hidden="true">{o.icon}</span>}
                <span>{i === 0 ? t("miniapp.subcategory.all") : o.label}</span>
              </label>
            </li>
          ))}
        </ul>
        <button type="button" className="loc-done" onClick={onClose}>
          {t("miniapp.menu.close")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
