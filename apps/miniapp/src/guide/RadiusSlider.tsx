// Ползунок радиуса поиска (разделы каталога с картой): шаги неравномерные — мелкие вблизи, крупные вдали.
// Значение всегда видно рядом; для читалок — aria-valuetext («2 км»).
import { useId } from "react";
import { useT } from "@tg/ui";
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

export function RadiusSlider({
  value,
  onChange,
  valueText,
  overlay = false,
}: {
  /** Радиус, м; null — не задан (ползунок стоит на максимуме). */
  value: number | null;
  onChange: (m: number) => void;
  /** Текст вместо числа (радиус не задан: «Усі місця»). */
  valueText?: string;
  /** Поверх карты («Поруч»): стеклянная капсула. */
  overlay?: boolean;
}) {
  const { t } = useT();
  const id = useId();
  const label = useRadiusLabel();
  const idx = value === null ? RADIUS_STEPS.length - 1 : stepIndex(value);
  const text = valueText ?? label(RADIUS_STEPS[idx]!);
  return (
    <div
      className={overlay ? "kosiv-radius-slider kosiv-radius-overlay" : "kosiv-radius-slider"}
      data-testid="radius-slider"
    >
      <label htmlFor={id}>{t("miniapp.catalog.radius")}</label>
      <input
        id={id}
        type="range"
        min={0}
        max={RADIUS_STEPS.length - 1}
        step={1}
        value={idx}
        aria-valuetext={text}
        onChange={(e) => onChange(RADIUS_STEPS[Number(e.target.value)]!)}
      />
      <output htmlFor={id} data-testid="radius-slider-value">
        {text}
      </output>
    </div>
  );
}
