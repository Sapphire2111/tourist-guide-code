// Ползунок радиуса поиска «Жаринка»: тонкая дорожка с огненным заполнением, деления по шагам, бегунок-уголёк,
// значение в чипе справа. Шаги неравномерные — мелкие вблизи, крупные вдали. Для читалок — aria-valuetext («2 км»).
// Каталог добавляет последний шаг «Усі місця» (allowAll); поверх карты («Поруч») — стеклянная капсула (overlay).
import { useId, useRef, useState, type CSSProperties } from "react";
import { useT } from "@tg/ui";
import { useGuide } from "./context.js";
import { useRadiusLabel } from "./Nearby.js";

/** Шаги ползунка, м. Верх — предел API (SEARCH_RADIUS_MAX = 20 000). */
export const RADIUS_STEPS = [300, 500, 1000, 2000, 3000, 5000, 10_000, 15_000, 20_000] as const;

/** Индекс ближайшего шага для произвольного радиуса. */
export function stepIndex(m: number): number {
  let best = 0;
  RADIUS_STEPS.forEach((s, i) => {
    if (Math.abs(s - m) < Math.abs(RADIUS_STEPS[best]! - m)) best = i;
  });
  return best;
}

/** Значок радиуса: точка и два кольца (overlay — вместо видимой подписи). */
function RadiusIcon() {
  return (
    <svg className="kosiv-rs-icon" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <circle cx="9" cy="9" r="1.6" fill="currentColor" />
      <circle cx="9" cy="9" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle
        cx="9"
        cy="9"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="2.6 2.2"
      />
    </svg>
  );
}

export function RadiusSlider({
  value,
  onChange,
  allowAll = false,
  overlay = false,
  disabled = false,
}: {
  /** Радиус, м; null — без ограничения (последний шаг, только с allowAll). */
  value: number | null;
  onChange: (m: number | null) => void;
  /** Последний шаг «Усі місця» (null) после максимального радиуса. */
  allowAll?: boolean;
  /** Поверх карты («Поруч»): стеклянная капсула, видимой подписи нет (для читалок остаётся). */
  overlay?: boolean;
  disabled?: boolean;
}) {
  const { t } = useT();
  const { webApp } = useGuide();
  const id = useId();
  const label = useRadiusLabel();
  const last = allowAll ? RADIUS_STEPS.length : RADIUS_STEPS.length - 1;
  const idx = value === null ? last : stepIndex(value);
  const text =
    allowAll && idx === RADIUS_STEPS.length ? t("miniapp.catalog.radiusAll") : label(RADIUS_STEPS[idx]!);
  const [dragging, setDragging] = useState(false);
  const lastIdx = useRef(idx);

  const change = (i: number) => {
    if (i !== lastIdx.current) {
      lastIdx.current = i;
      // Лёгкий «щелчок» на каждом шаге — только в Telegram, вне его метода нет.
      webApp?.HapticFeedback?.selectionChanged?.();
    }
    onChange(i >= RADIUS_STEPS.length ? null : RADIUS_STEPS[i]!);
  };

  return (
    <div
      className={overlay ? "kosiv-radius-slider kosiv-radius-overlay" : "kosiv-radius-slider"}
      data-testid="radius-slider"
      data-dragging={dragging || undefined}
      data-disabled={disabled || undefined}
      style={{ "--p": last ? idx / last : 0 } as CSSProperties}
    >
      {overlay && <RadiusIcon />}
      <label htmlFor={id}>{t("miniapp.catalog.radius")}</label>
      <div className="kosiv-rs-track">
        <span className="kosiv-rs-fill" aria-hidden="true" />
        <span className="kosiv-rs-ticks" aria-hidden="true">
          {Array.from({ length: last + 1 }, (_, i) => (
            <i
              key={i}
              data-passed={i <= idx || undefined}
              data-all={allowAll && i === RADIUS_STEPS.length ? "" : undefined}
            />
          ))}
        </span>
        <input
          id={id}
          type="range"
          min={0}
          max={last}
          step={1}
          value={idx}
          disabled={disabled}
          aria-valuetext={text}
          onChange={(e) => change(Number(e.target.value))}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onBlur={() => setDragging(false)}
        />
      </div>
      <output htmlFor={id} aria-live="off" data-testid="radius-slider-value">
        {text}
      </output>
    </div>
  );
}
