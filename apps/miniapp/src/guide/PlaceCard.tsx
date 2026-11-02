// C06 «Картка місця»: фото, бейджи, график, атрибуты, дата проверки; маршрут (OSM), звонок (tel:), сайт, обране.
// «Доступно зараз» — блок 7; до него всегда «Уточнити доступність» (ТЗ §10.3).
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { routeUrl } from "./geo.js";
import { Badge, card, PlaceBadges, useDistance } from "./parts.js";
import { NotFoundError, UnauthorizedError, type PlaceDetail, type ScheduleInterval } from "./types.js";

const action: CSSProperties = {
  display: "inline-block",
  padding: "10px 16px",
  borderRadius: "var(--radius)",
  background: "var(--color-button)",
  color: "var(--color-button-text)",
  fontSize: "1.2rem",
  fontWeight: 700,
  textDecoration: "none",
};

export function PlaceCard({ id }: { id: string }) {
  const { t } = useT();
  const { api, analytics } = useGuide();
  const [place, retry] = useAsync(
    // Битый/не-UUID id из адреса — «Заклад недоступний» без запроса.
    () => (id ? api.place(id) : Promise.reject(new NotFoundError())),
    [api, id],
  );
  useEffect(() => {
    if (place.status === "ready") analytics.track("place_viewed", { placeId: place.data.id });
  }, [analytics, place]);

  if (place.status === "loading") return <p role="status">{t("miniapp.guide.loading")}</p>;
  if (place.status === "error") {
    if (place.error instanceof NotFoundError)
      return (
        <p role="alert" data-testid="place-not-found">
          {t("miniapp.place.notFound")}
        </p>
      );
    return (
      <div>
        <p role="alert">{t("miniapp.place.error")}</p>
        <Button onClick={retry}>{t("miniapp.guide.retry")}</Button>
      </div>
    );
  }
  return <PlaceView place={place.data} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={card}>
      <h2 style={{ fontSize: "1.1rem", margin: "0 0 6px" }}>{title}</h2>
      {children}
    </section>
  );
}

function Schedule({ schedule }: { schedule: ScheduleInterval[] }) {
  const { t } = useT();
  return (
    <table>
      <tbody>
        {[1, 2, 3, 4, 5, 6, 7].map((d) => {
          const day = schedule.filter((s) => s.weekday === d);
          return (
            <tr key={d}>
              <th scope="row" style={{ textAlign: "left", paddingRight: 12 }}>
                {t(`miniapp.weekday.${d}` as MessageKey)}
              </th>
              <td>
                {day.length ? day.map((s) => `${s.opens}–${s.closes}`).join(", ") : t("miniapp.place.dayOff")}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PlaceView({ place }: { place: PlaceDetail }) {
  const { t, locale } = useT();
  const { api, analytics, webApp, signedIn, base } = useGuide();
  const distance = useDistance()(place.distanceMeters);
  const name = pickLocalized(place.name, locale);
  // favorite в карточке: null — сервер не видит сессии.
  const [favorite, setFavorite] = useState<boolean | null>(place.favorite);
  const [busy, setBusy] = useState(false);
  const [favError, setFavError] = useState<"error" | "auth" | false>(false);

  const toggleFavorite = async () => {
    setBusy(true);
    setFavError(false);
    try {
      if (favorite) await api.removeFavorite(place.id);
      else await api.addFavorite(place.id);
      setFavorite(!favorite);
    } catch (e) {
      setFavError(e instanceof UnauthorizedError ? "auth" : "error");
    }
    setBusy(false);
  };

  const route = place.location ? routeUrl(place.location, base?.point) : null;
  const verified = place.verifiedAt ? new Date(place.verifiedAt).toLocaleDateString("uk-UA") : null;

  return (
    <article aria-labelledby="place-title">
      <Stack>
        {place.photos.length > 0 && (
          <div style={{ display: "flex", gap: 8, overflowX: "auto" }} data-testid="place-photos">
            {place.photos.map((p) => (
              <img
                key={p.url}
                src={p.url}
                alt={p.alt ? pickLocalized(p.alt, locale) : ""}
                loading="lazy"
                style={{ height: 180, borderRadius: "var(--radius)", objectFit: "cover", flex: "0 0 auto" }}
              />
            ))}
          </div>
        )}
        <h1 id="place-title" style={{ margin: 0 }}>
          {name}
        </h1>
        {distance && <p style={{ margin: 0 }}>{distance}</p>}
        {place.openNow && place.openUntil && (
          <p style={{ margin: 0 }}>{t("miniapp.place.openUntil", { time: place.openUntil })}</p>
        )}
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <PlaceBadges place={place} />
          <Badge testId="badge-availability">{t("miniapp.place.checkAvailability")}</Badge>
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {route && (
            <a
              href={route}
              style={action}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="place-route"
              onClick={(e) => {
                analytics.track("route_clicked", { placeId: place.id });
                if (webApp?.openLink) {
                  e.preventDefault();
                  webApp.openLink(route);
                }
              }}
            >
              {t("miniapp.place.route")}
            </a>
          )}
          {place.phone && (
            <a
              href={`tel:${place.phone}`}
              style={action}
              data-testid="place-call"
              onClick={() => analytics.track("call_clicked", { placeId: place.id })}
            >
              {t("miniapp.place.call")}
            </a>
          )}
          {place.website && (
            <a
              href={place.website}
              style={action}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                if (webApp?.openLink) {
                  e.preventDefault();
                  webApp.openLink(place.website!);
                }
              }}
            >
              {t("miniapp.place.website")}
            </a>
          )}
          {place.telegram && (
            <a
              href={`https://t.me/${place.telegram}`}
              style={action}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                if (webApp?.openTelegramLink) {
                  e.preventDefault();
                  webApp.openTelegramLink(`https://t.me/${place.telegram}`);
                }
              }}
            >
              {t("miniapp.place.telegram")}
            </a>
          )}
          {signedIn && (
            <Button
              disabled={busy}
              aria-pressed={favorite === true}
              onClick={() => void toggleFavorite()}
              data-testid="place-favorite"
            >
              {favorite ? t("miniapp.place.favoriteRemove") : t("miniapp.place.favoriteAdd")}
            </Button>
          )}
        </div>
        {!signedIn && <p>{t("miniapp.place.favoriteNeedsLogin")}</p>}
        {favError && (
          <p role="alert">{t(favError === "auth" ? "miniapp.auth.again" : "miniapp.place.favoriteError")}</p>
        )}
        {place.description && <p>{pickLocalized(place.description, locale)}</p>}
        {place.address && (
          <Section title={t("miniapp.place.address")}>
            <p style={{ margin: 0 }}>{pickLocalized(place.address, locale)}</p>
            {place.phone && <p style={{ margin: "6px 0 0" }}>{place.phone}</p>}
          </Section>
        )}
        <Section title={t("miniapp.place.schedule")}>
          {place.schedule.length ? (
            <Schedule schedule={place.schedule} />
          ) : (
            <p style={{ margin: 0 }}>{t("miniapp.place.scheduleUnknown")}</p>
          )}
        </Section>
        {place.tags.length > 0 && (
          <Section title={t("miniapp.place.attributes")}>
            <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {place.tags.map((tag, i) => (
                <Badge key={i}>{pickLocalized(tag, locale)}</Badge>
              ))}
            </span>
          </Section>
        )}
        {verified && <p data-testid="place-verified">{t("miniapp.place.verified", { date: verified })}</p>}
      </Stack>
    </article>
  );
}
