// Общие элементы экранов гида: состояния загрузки/ошибки, бейджи, список мест.
import type { CSSProperties, ReactNode } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, useT } from "@tg/ui";
import { ICONS } from "../design/Ornament.js";
import type { Async } from "./context.js";
import type { PlaceSummary } from "./types.js";

/** Список без маркеров с отступом между пунктами (li — прямые потомки ul). */
export const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

/** Карточка в стиле .kosiv-card (поверхность, рамка, мягкая тень); вложенные блоки — радиус 16px. */
export const card: CSSProperties = {
  background: "var(--app-surface, var(--color-surface))",
  border: "1.5px solid var(--app-border, transparent)",
  borderRadius: 20,
  boxShadow: "var(--shadow-card, none)",
  padding: "14px 16px",
};

/** Бейдж-пилюля (.kosiv-chip): тон accent — открыто/важное, accent2 — редакционное, outline — реклама. */
export function Badge({
  children,
  testId,
  tone,
}: {
  children: ReactNode;
  testId?: string;
  tone?: "accent" | "accent2" | "outline";
}) {
  return (
    <span className="kosiv-chip" data-tone={tone} data-testid={testId}>
      {children}
    </span>
  );
}

/** Бейджи места: «Відкрито зараз», «Ми рекомендуємо», «Реклама/Партнер» (реклама не маскируется под рекомендацию). */
export function PlaceBadges({ place }: { place: PlaceSummary }) {
  const { t } = useT();
  return (
    <>
      {place.openNow === true && (
        <Badge testId="badge-open" tone="accent">
          {t("miniapp.place.openNow")}
        </Badge>
      )}
      {place.openNow === false && <Badge testId="badge-closed">{t("miniapp.place.closedNow")}</Badge>}
      {place.recommended && (
        <Badge testId="badge-recommended" tone="accent2">
          {t("miniapp.place.recommended")}
        </Badge>
      )}
      {place.adLabel && (
        <Badge testId="badge-ad" tone="outline">
          {t(place.adLabel === "partner" ? "miniapp.place.partner" : "miniapp.place.ad")}
        </Badge>
      )}
    </>
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

/** Обложка места: фото (декор — название рядом) или керамическая подложка с иконкой. */
export function PlaceMedia({ place }: { place: PlaceSummary }) {
  return (
    <div className="kosiv-place-media">
      {place.cover ? <img src={place.cover.url} alt="" loading="lazy" decoding="async" /> : ICONS.nearby}
    </div>
  );
}

/** Карточка места: обложка, название (ссылка на всю карточку), расстояние и бейджи. */
export function PlaceSummaryCard({
  place,
  layout = "row",
  testId = "place-item",
  as: Tag = "li",
  distanceFrom,
}: {
  place: PlaceSummary;
  /** Откуда расстояние, если не от пользователя/заведения: «від центру Яремче». */
  distanceFrom?: string;
  layout?: "row" | "tile";
  testId?: string;
  as?: "li" | "div";
}) {
  const { t, locale } = useT();
  const raw = useDistance()(place.distanceMeters);
  const d = raw && distanceFrom ? t("miniapp.place.distanceFrom", { d: raw, from: distanceFrom }) : raw;
  return (
    <Tag className={`kosiv-card kosiv-place${layout === "row" ? " kosiv-row" : ""}`} data-testid={testId}>
      <PlaceMedia place={place} />
      <div className="kosiv-place-body">
        <Link to={`/place/${place.id}`} className="kosiv-place-title">
          {pickLocalized(place.name, locale)}
        </Link>
        {place.address && <span className="kosiv-place-addr">{pickLocalized(place.address, locale)}</span>}
        <span className="kosiv-place-meta">
          {d && <span className="kosiv-chip">{d}</span>}
          <PlaceBadges place={place} />
        </span>
      </div>
    </Tag>
  );
}

export function PlaceList({
  places,
  testId = "place-list",
  distanceFrom,
}: {
  places: PlaceSummary[];
  testId?: string;
  distanceFrom?: string;
}) {
  return (
    <ul data-testid={testId} style={listStyle}>
      {places.map((p) => (
        <PlaceSummaryCard key={p.id} place={p} distanceFrom={distanceFrom} />
      ))}
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
  if (state.status === "loading")
    return (
      <p role="status" className="kosiv-muted">
        {t("miniapp.guide.loading")}
      </p>
    );
  if (state.status === "error")
    return (
      <div className="kosiv-card kosiv-empty">
        <p role="alert">{errorText ?? t("miniapp.guide.error")}</p>
        <Button onClick={retry}>{t("miniapp.guide.retry")}</Button>
      </div>
    );
  return <>{children(state.data)}</>;
}
