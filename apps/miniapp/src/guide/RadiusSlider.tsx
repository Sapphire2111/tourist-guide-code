// Ползунок радиуса поиска (разделы каталога с картой, «Поруч»): шаги неравномерные — мелкие вблизи, крупные вдали.
// Значение всегда видно рядом; для читалок — aria-valuetext («2 км»). Каталог добавляет последний шаг «Усі місця».
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
  allowAll = false,
  overlay = false,
}: {
  /** Радиус, м; null — без ограничения (последний шаг, только с allowAll). */
  value: number | null;
  onChange: (m: number | null) => void;
  /** Последний шаг «Усі місця» (null) после максимального радиуса. */
  allowAll?: boolean;
  /** Поверх карты («Поруч»): стеклянная капсула, видимой подписи нет (для читалок остаётся). */
  overlay?: boolean;
}) {
  const { t } = useT();
  const id = useId();
  const label = useRadiusLabel();
  const last = allowAll ? RADIUS_STEPS.length : RADIUS_STEPS.length - 1;
  const idx = value === null ? last : stepIndex(value);
  const text =
    allowAll && idx === RADIUS_STEPS.length ? t("miniapp.catalog.radiusAll") : label(RADIUS_STEPS[idx]!);
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
        max={last}
        step={1}
        value={idx}
        aria-valuetext={text}
        onChange={(e) => {
          const i = Number(e.target.value);
          onChange(i >= RADIUS_STEPS.length ? null : RADIUS_STEPS[i]!);
        }}
      />
      <output htmlFor={id} aria-live="off" data-testid="radius-slider-value">
        {text}
      </output>
    </div>
  );
}
