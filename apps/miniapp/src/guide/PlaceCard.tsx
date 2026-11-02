// C06 «Картка місця»: фото, бейджи, график, атрибуты, дата проверки; маршрут (OSM), звонок (tel:), сайт, обране.
// «Доступно зараз» — блок 7; до него всегда «Уточнити доступність» (ТЗ §10.3).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { routeUrl } from "./geo.js";
import { Badge, card, PlaceBadges, useDistance } from "./parts.js";
import { NotFoundError, UnauthorizedError, type PlaceDetail, type ScheduleInterval } from "./types.js";

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
      <h2 style={{ fontSize: "1.2rem", margin: "0 0 6px" }}>{title}</h2>
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
  // Заголовок появляется после загрузки — фокус на нём ставит сам экран (смена маршрута его ещё не видит).
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => titleRef.current?.focus(), [place.id]);
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
          <div className="kosiv-photos" data-testid="place-photos">
            {place.photos.map((p) => (
              <img key={p.url} src={p.url} alt={p.alt ? pickLocalized(p.alt, locale) : ""} loading="lazy" />
            ))}
          </div>
        )}
        <h1 id="place-title" ref={titleRef} tabIndex={-1} style={{ margin: 0 }}>
          {name}
        </h1>
        <span className="kosiv-place-meta">
          {distance && <span className="kosiv-chip">{distance}</span>}
          {place.openNow && place.openUntil && (
            <span className="kosiv-chip">{t("miniapp.place.openUntil", { time: place.openUntil })}</span>
          )}
          <PlaceBadges place={place} />
          <Badge testId="badge-availability">{t("miniapp.place.checkAvailability")}</Badge>
        </span>
        <div className="kosiv-actions">
          {route && (
            <a
              href={route}
              className="kosiv-action"
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
              className="kosiv-action"
              data-variant="ghost"
              data-testid="place-call"
              onClick={() => analytics.track("call_clicked", { placeId: place.id })}
            >
              {t("miniapp.place.call")}
            </a>
          )}
          {place.website && (
            <a
              href={place.website}
              className="kosiv-action"
              data-variant="ghost"
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
              className="kosiv-action"
              data-variant="ghost"
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
