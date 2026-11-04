// Одна кнопка вместо ряда чипов подкатегорий/фильтров: «Шукати все ▾» или «<выбранное> ▾».
// Нажатие открывает нижний лист (тот же вид, что у «Локація») с радио-выбором; выбор применяется сразу и закрывает лист.
// Закрытие: тап по фону, Escape, «Закрити», «Назад» Telegram. Радио — кнопки role="radio" с одной Tab-остановкой:
// стрелки только двигают фокус, применяют Enter / Space / тап (WCAG 3.2.2: фокус не меняет контекст).
import { useT } from "@tg/ui";
import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSheet } from "./use-sheet.js";
import "./location.css";
import "./subcategory-select.css";

export interface SubcategoryOption {
  id: string;
  label: string;
  /** Необязательный значок/эмодзи перед названием (декоративный). */
  icon?: ReactNode;
}

/**
 * `options[0]` — пункт «все» (его id — значение «ничего не выбрано», подпись задаёт вызывающий:
 * «Шукати все», «Усі складності»). `title` — название списка (заголовок листа и часть имени кнопки).
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
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const all = options[0];
  const current = options.find((o) => o.id === value) ?? all;
  const active = current !== undefined && current !== all;
  return (
    <>
      <button
        type="button"
        className={className ? `subcat-trigger ${className}` : "subcat-trigger"}
        data-testid={testId}
        data-active={active ? "true" : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${title}: ${current?.label ?? ""}`}
        onClick={() => setOpen(true)}
      >
        {active && current.icon != null && (
          <span className="subcat-trigger-icon" aria-hidden="true">
            {current.icon}
          </span>
        )}
        <span className="subcat-trigger-text">{current?.label}</span>
        <span className="subcat-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <SubcategorySheet
          title={title}
          options={options}
          value={current?.id ?? ""}
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
  const listRef = useRef<HTMLDivElement>(null);
  useSheet(sheetRef, onClose);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, (i: number, n: number) => number> = {
      ArrowDown: (i, n) => (i + 1) % n,
      ArrowRight: (i, n) => (i + 1) % n,
      ArrowUp: (i, n) => (i - 1 + n) % n,
      ArrowLeft: (i, n) => (i - 1 + n) % n,
      Home: () => 0,
      End: (_, n) => n - 1,
    };
    const move = keys[e.key];
    if (!move) return;
    const radios = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const at = radios.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    radios[move(Math.max(at, 0), radios.length)]?.focus();
  };
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
        <div
          ref={listRef}
          className="loc-list"
          role="radiogroup"
          aria-labelledby={titleId}
          onKeyDown={onKeyDown}
        >
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={o.id === value}
              tabIndex={o.id === value ? 0 : -1}
              className="loc-option subcat-option"
              onClick={() => onPick(o.id)}
            >
              <span className="subcat-radio" aria-hidden="true" />
              {o.icon != null && <span aria-hidden="true">{o.icon}</span>}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="loc-done" onClick={onClose}>
          {t("miniapp.menu.close")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
