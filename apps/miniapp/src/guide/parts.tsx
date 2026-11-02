// Общие элементы экранов гида: состояния загрузки/ошибки, бейджи, список мест.
import type { CSSProperties, ReactNode } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import type { Async } from "./context.js";
import type { PlaceSummary } from "./types.js";

export const card: CSSProperties = {
  background: "var(--color-surface)",
  borderRadius: "var(--radius)",
  padding: "calc(var(--space) * 1.5)",
};

/** Бейдж: текст цвета темы на поверхности — контраст как у основного текста. */
const badge: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid currentColor",
  fontSize: "0.875rem",
  fontWeight: 600,
};

export function Badge({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span style={badge} data-testid={testId}>
      {children}
    </span>
  );
}

/** Бейджи места: «Відкрито зараз», «Ми рекомендуємо», «Реклама/Партнер» (реклама не маскируется под рекомендацию). */
export function PlaceBadges({ place }: { place: PlaceSummary }) {
  const { t } = useT();
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {place.openNow === true && <Badge testId="badge-open">{t("miniapp.place.openNow")}</Badge>}
      {place.openNow === false && <Badge testId="badge-closed">{t("miniapp.place.closedNow")}</Badge>}
      {place.recommended && <Badge testId="badge-recommended">{t("miniapp.place.recommended")}</Badge>}
      {place.adLabel && (
        <Badge testId="badge-ad">
          {t(place.adLabel === "partner" ? "miniapp.place.partner" : "miniapp.place.ad")}
        </Badge>
      )}
    </span>
  );
}

export function useDistance(): (meters: number | null) => string | null {
  const { t } = useT();
  return (m) => {
    if (m == null) return null;
    if (m < 1000) return t("miniapp.place.distance", { n: Math.round(m) });
    return t("miniapp.place.distanceKm", { n: (m / 1000).toFixed(1).replace(".", ",") });
  };
}

export function PlaceList({ places, testId = "place-list" }: { places: PlaceSummary[]; testId?: string }) {
  const { locale } = useT();
  const distance = useDistance();
  return (
    <ul data-testid={testId} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      <Stack gap={1}>
        {places.map((p) => {
          const d = distance(p.distanceMeters);
          return (
            <li key={p.id} style={card} data-testid="place-item">
              <Link
                to={`/place/${p.id}`}
                style={{ fontSize: "1.2rem", fontWeight: 700, display: "block", marginBottom: 4 }}
              >
                {pickLocalized(p.name, locale)}
              </Link>
              {d && <span>{d} </span>}
              <PlaceBadges place={p} />
            </li>
          );
        })}
      </Stack>
    </ul>
  );
}

/** Состояние загрузки/ошибки с повтором; при ready — содержимое. */
export function AsyncView<T>({
  state,
  retry,
  errorText,
  children,
}: {
  state: Async<T>;
  retry: () => void;
  errorText?: string;
  children: (data: T) => ReactNode;
}) {
  const { t } = useT();
  if (state.status === "loading") return <p role="status">{t("miniapp.guide.loading")}</p>;
  if (state.status === "error")
    return (
      <div>
        <p role="alert">{errorText ?? t("miniapp.guide.error")}</p>
        <Button onClick={retry}>{t("miniapp.guide.retry")}</Button>
      </div>
    );
  return <>{children(state.data)}</>;
}
