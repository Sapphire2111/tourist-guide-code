import type { ComponentProps, CSSProperties, ReactNode } from "react";

/** Вертикальный стек с отступом в шагах сетки (8px). */
export function Stack({
  gap = 2,
  children,
  style,
}: {
  gap?: number;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: `calc(var(--space) * ${gap})`, ...style }}>
      {children}
    </div>
  );
}

// Размеры и форму приложение может переопределить переменными --button-* (дизайн Mini App); по умолчанию — как было.
const buttonStyle: CSSProperties = {
  font: "inherit",
  // Крупный жирный текст: button_color Telegram (#3390ec) с белым — 3.4:1, AA проходит только как large text (3:1).
  fontSize: "var(--button-font-size, 1.2rem)",
  fontWeight: "var(--button-font-weight, 700)" as CSSProperties["fontWeight"],
  padding: "var(--button-padding, 10px 16px)",
  minHeight: 44,
  border: 0,
  borderRadius: "var(--button-radius, var(--radius))",
  background: "var(--color-button)",
  color: "var(--color-button-text)",
  cursor: "pointer",
};

// Неактивная — заметно бледнее и без «руки»; доступность — нативный disabled (сам даёт disabled-состояние в a11y-дереве,
// aria-disabled поверх не нужен). WCAG не требует контраста текста у неактивных элементов.
const disabledStyle: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

/** Кнопка в цветах темы. */
export function Button({ style, type = "button", ...props }: ComponentProps<"button">) {
  return (
    <button
      type={type}
      style={{ ...buttonStyle, ...(props.disabled ? disabledStyle : {}), ...style }}
      {...props}
    />
  );
}
