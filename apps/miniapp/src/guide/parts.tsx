// Общие элементы экранов гида: состояния загрузки/ошибки, бейджи, список мест.
import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, useT } from "@tg/ui";
import { routeUrl, type LatLng } from "./geo.js";
import { ICONS, SECTION_EMOJI } from "../design/Ornament.js";
import { useCategoryIndex } from "./categories.js";
import { useMaybeGuide, type Async } from "./context.js";
import type { Photo, PlaceSummary } from "./types.js";

/** Внешняя ссылка: в Telegram — openLink (внешний браузер), иначе новая вкладка. */
export function ExtLink({
  href,
  children,
  className,
  testId,
  label,
  variant,
  onOpen,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  testId?: string;
  label?: string;
  variant?: "ghost";
  onOpen?: () => void;
}) {
  const webApp = useMaybeGuide()?.webApp;
  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      data-variant={variant}
      aria-label={label}
      onClick={(e: MouseEvent) => {
        onOpen?.();
        if (webApp?.openLink) {
          e.preventDefault();
          webApp.openLink(href);
        }
      }}
    >
      {children}
    </a>
  );
}

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
/** Подпись обложки из Google/Wikimedia: автор (и лицензия Commons) — обязательна. */
export function CoverCredit({
  credit,
  className,
}: {
  credit: NonNullable<Photo["credit"]>;
  className?: string;
}) {
  const { t } = useT();
  const names = credit.authors.map((a) => a.name).join(", ");
  const text =
    credit.source === "wikimedia"
      ? names
        ? t("miniapp.place.wikiImage", { author: names, license: credit.license ?? "" })
        : t("miniapp.place.wikiImageNoAuthor", { license: credit.license ?? "" })
      : names
        ? t("miniapp.place.googleCover", { name: names })
        : t("miniapp.place.googleCoverNoAuthor");
  return (
    <span className={className} data-testid="cover-credit">
      {text}
    </span>
  );
}

export function PlaceMedia({ place, icon }: { place: PlaceSummary; icon?: ReactNode }) {
  // Файл не загрузился (404, предел, сеть) — подложка с иконкой вместо битой картинки; подпись не нужна.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const cover = place.cover && place.cover.url !== failedUrl ? place.cover : null;
  return (
    <div className="kosiv-place-media">
      {cover ? (
        <img src={cover.url} alt="" loading="lazy" decoding="async" onError={() => setFailedUrl(cover.url)} />
      ) : (
        (icon ?? ICONS.nearby)
      )}
      {cover?.credit && <CoverCredit credit={cover.credit} className="kosiv-place-credit" />}
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
  quickRoute = false,
  routeFrom,
}: {
  place: PlaceSummary;
  /** Откуда расстояние, если не от пользователя/заведения: «від центру Яремче». */
  distanceFrom?: string;
  quickRoute?: boolean;
  routeFrom?: LatLng | null;
  layout?: "row" | "tile";
  testId?: string;
  as?: "li" | "div";
}) {
  const { t, locale } = useT();
  const raw = useDistance()(place.distanceMeters);
  // Что это за место («Кафе», «Пам'ятка») — название категории из справочника.
  const guide = useMaybeGuide();
  const categories = useCategoryIndex(guide?.api);
  const category = categories.byId.get(place.categoryId);
  const d = raw && distanceFrom ? t("miniapp.place.distanceFrom", { d: raw, from: distanceFrom }) : raw;
  return (
    <Tag className={`kosiv-card kosiv-place${layout === "row" ? " kosiv-row" : ""}`} data-testid={testId}>
      <PlaceMedia
        place={place}
        // Списки по удалённости: значок раздела вместо обложки-заглушки, как на эталоне.
        icon={
          quickRoute ? (
            <span aria-hidden="true">
              {SECTION_EMOJI[categories.sectionOf(place.categoryId) ?? "other"] ?? SECTION_EMOJI.other}
            </span>
          ) : undefined
        }
      />
      <div className="kosiv-place-body">
        <Link to={`/place/${encodeURIComponent(place.id)}`} className="kosiv-place-title">
          {pickLocalized(place.name, locale)}
        </Link>
        {guide && (
          // Строка зарезервирована до прихода справочника — карточка не прыгает.
          <span className="kosiv-place-cat" data-testid="place-category">
            {category ? pickLocalized(category.name, locale) : ""}
          </span>
        )}
        {place.address && <span className="kosiv-place-addr">{pickLocalized(place.address, locale)}</span>}
        <span className="kosiv-place-meta">
          {d && <span className="kosiv-chip">{d}</span>}
          <PlaceBadges place={place} />
        </span>
        {quickRoute && place.location && (
          <ExtLink
            className="modern-route"
            href={routeUrl(place.location, routeFrom)}
            onOpen={() => guide?.analytics.track("route_clicked", { placeId: place.id })}
          >
            <span aria-hidden="true">🧭</span>
            {t("miniapp.modern.route")}
          </ExtLink>
        )}
      </div>
    </Tag>
  );
}

export function PlaceList({
  places,
  testId = "place-list",
  distanceFrom,
  quickRoute = false,
  routeFrom,
}: {
  places: PlaceSummary[];
  testId?: string;
  distanceFrom?: string;
  quickRoute?: boolean;
  routeFrom?: LatLng | null;
}) {
  return (
    <ul data-testid={testId} style={listStyle}>
      {places.map((p) => (
        <PlaceSummaryCard
          key={p.id}
          place={p}
          distanceFrom={distanceFrom}
          quickRoute={quickRoute}
          routeFrom={routeFrom}
        />
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
