import { useT } from "@tg/ui";
import "./sort-toggle.css";

export type PlaceSort = "distance" | "rating";

const OPTIONS = [
  { value: "distance", icon: "📍", key: "miniapp.sort.distance" },
  { value: "rating", icon: "★", key: "miniapp.sort.rating" },
] as const;

/**
 * Переключатель порядка «Ближчі / Рейтинг»: маленькая капсула, мягкая подложка переезжает к выбранному варианту
 * (без анимации при prefers-reduced-motion). Зона касания — 44 px при видимой высоте ~30 px.
 */
export function SortToggle({ value, onChange }: { value: PlaceSort; onChange: (v: PlaceSort) => void }) {
  const { t } = useT();
  return (
    <div
      role="radiogroup"
      aria-label={t("miniapp.sort.label")}
      className="sort-toggle"
      data-value={value}
      data-testid="sort-toggle"
    >
      <span className="sort-toggle-thumb" aria-hidden="true" />
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className="sort-toggle-option"
          data-testid={`sort-${o.value}`}
          onClick={() => value !== o.value && onChange(o.value)}
        >
          <span aria-hidden="true">{o.icon}</span> {t(o.key)}
        </button>
      ))}
    </div>
  );
}

/** Порядок на клиенте: по расстоянию (без расстояния — в конце) или по рейтингу Google (без рейтинга — в конце). */
export function sortPlaces<T>(
  items: readonly T[],
  sort: PlaceSort,
  of: (x: T) => { distanceMeters: number | null; rating?: number | null; ratingCount?: number | null },
): T[] {
  // Та же формула, что у серверного byRating (apps/api/src/modules/assistant/assistant.service.ts).
  const score = (x: T) => {
    const r = of(x);
    return r.rating == null ? -Infinity : r.rating + 0.01 * Math.log10(1 + (r.ratingCount ?? 0));
  };
  return [...items].sort((a, b) =>
    sort === "rating"
      ? score(b) - score(a)
      : (of(a).distanceMeters ?? Infinity) - (of(b).distanceMeters ?? Infinity),
  );
}
