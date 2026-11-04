// C06 «Картка місця»: галерея (свои фото и фото Google с авторами), тип и рейтинг Google, бейджи, действия
// (маршрут в Google Карты, звонок tel:, сайт, Telegram, обране), «Про місце» (текст ШІ с пометкой или описание Google),
// «Що пропонує», график, адрес и контакты, отзывы Google, блок Вікіпедії, подписи источников. Нет данных — блока нет.
// «Доступно зараз» и «Забронювати» — блок 7 (флаг module.bookings); иначе «Уточнити доступність» (ТЗ §10.3).
import { SHOW_AI_LABELS } from "../ai-labels.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isAllDay, pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { usePlaceResources } from "../bookings/context.js";
import { AvailabilityBadge, BookingEntry } from "../bookings/PlaceBooking.js";
import { useAsync, useGuide } from "./context.js";
import { interceptBack } from "../telegram.js";
import { googleRouteUrl } from "./geo.js";
import { Badge, ExtLink, PlaceBadges, useDistance } from "./parts.js";
import { PeakDetails } from "./Peaks.js";
import "./place-card.css";
import {
  NotFoundError,
  UnauthorizedError,
  type Author,
  type PlaceDetail,
  type Review,
  type ScheduleInterval,
} from "./types.js";

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

function Section({
  title,
  children,
  testId,
  aside,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
  aside?: ReactNode;
}) {
  return (
    <section className="pc-section" data-testid={testId}>
      <header className="pc-section-head">
        <h2 className="pc-h2">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Schedule({ schedule }: { schedule: ScheduleInterval[] }) {
  const { t } = useT();
  const today = ((new Date().getDay() + 6) % 7) + 1;
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => schedule.filter((s) => s.weekday === d));
  const allDay = (day: ScheduleInterval[]) => day.some((s) => isAllDay(s.opens, s.closes));
  // Круглосуточно все 7 дней — одна строка вместо списка по дням.
  if (days.every(allDay)) return <p className="pc-m0">{t("miniapp.place.allDay")}</p>;
  return (
    <table className="pc-schedule">
      <tbody>
        {days.map((day, i) => {
          const d = i + 1;
          return (
            <tr key={d} data-today={d === today || undefined}>
              <th scope="row">{t(`miniapp.weekday.${d}` as MessageKey)}</th>
              <td>
                {allDay(day)
                  ? t("miniapp.place.allDay")
                  : day.length
                    ? day.map((s) => `${s.opens}–${s.closes}`).join(", ")
                    : t("miniapp.place.dayOff")}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// --- галерея ---

/** license и sourceUrl — обложка Wikimedia: лицензия и страница файла, подпись без них неполная. */
type SlideCredit = { authors: Author[]; license?: string | null; sourceUrl?: string | null };
type Slide = SlideCredit & { url: string; largeUrl: string; alt: string };

function Credit({ authors, license, sourceUrl, fallback }: SlideCredit & { fallback?: string }) {
  const { t } = useT();
  if (!authors.length) return fallback ? <>{fallback}</> : null;
  return (
    <>
      {t("miniapp.place.photoBy", { name: "" })}
      {authors.map((a, i) => (
        <span key={i}>
          {i > 0 && ", "}
          {a.uri ? <ExtLink href={a.uri}>{a.name}</ExtLink> : a.name}
        </span>
      ))}
      {license && (
        <>
          {" · "}
          {sourceUrl ? <ExtLink href={sourceUrl}>{license}</ExtLink> : license}
        </>
      )}
    </>
  );
}

function Lightbox({ slides, start, onClose }: { slides: Slide[]; start: number; onClose: () => void }) {
  const { t } = useT();
  const [pos, setI] = useState(start);
  // Большое фото не загрузилось — показываем превью; не загрузилось и оно — закрываем.
  const [fallback, setFallback] = useState<ReadonlySet<string>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Галерея могла укоротиться (фото не загрузилось): индекс — в пределах массива; пусто — закрыть.
  const i = Math.min(pos, Math.max(0, slides.length - 1));
  const s = slides[i];
  const go = useCallback(
    (d: number) => setI((v) => (Math.min(v, slides.length - 1) + d + slides.length) % slides.length),
    [slides.length],
  );
  useEffect(() => {
    if (!slides.length) onClose();
  }, [slides.length, onClose]);
  useEffect(() => {
    // Фокус — внутрь, по закрытию — обратно на кнопку фото; фон не прокручивается; «Назад» Telegram закрывает.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const releaseBack = interceptBack(onClose);
    return () => {
      document.body.style.overflow = overflow;
      releaseBack();
      opener?.focus();
    };
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "Tab" && dialogRef.current) {
        const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button, a[href]")];
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, onClose]);
  if (!s) return null;
  const src = fallback.has(s.largeUrl) ? s.url : s.largeUrl;
  // В body: у предков экрана могут быть transform/overflow — fixed внутри них не накрыл бы шапку и навигацию.
  return createPortal(
    <div
      ref={dialogRef}
      className="pc-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("miniapp.place.gallery")}
    >
      <button ref={closeRef} type="button" className="pc-lb-close" onClick={onClose}>
        <span aria-hidden="true">×</span>
        <span className="pc-sr">{t("miniapp.place.photoClose")}</span>
      </button>
      <img
        key={src}
        src={src}
        alt={s.alt}
        referrerPolicy="no-referrer"
        onError={() => {
          if (src === s.largeUrl && s.url !== s.largeUrl) setFallback((f) => new Set(f).add(s.largeUrl));
          else onClose();
        }}
      />
      <div className="pc-lb-bar">
        {slides.length > 1 && (
          <button type="button" className="pc-lb-nav" onClick={() => go(-1)}>
            <span aria-hidden="true">‹</span>
            <span className="pc-sr">{t("miniapp.place.photoPrev")}</span>
          </button>
        )}
        <p className="pc-lb-credit">
          <span>{t("miniapp.place.photoCounter", { n: i + 1, total: slides.length })}</span>{" "}
          <Credit authors={s.authors} license={s.license} sourceUrl={s.sourceUrl} />
        </p>
        {slides.length > 1 && (
          <button type="button" className="pc-lb-nav" onClick={() => go(1)}>
            <span aria-hidden="true">›</span>
            <span className="pc-sr">{t("miniapp.place.photoNext")}</span>
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Gallery({ slides: all }: { slides: Slide[] }) {
  const { t } = useT();
  // Фото, которое не загрузилось (нет адреса у Google, сеть), из галереи убирается.
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const slides = all.filter((s) => !failed.has(s.url));
  const close = useCallback(() => setOpen(null), []);
  if (!slides.length) return null;
  return (
    <section className="pc-gallery" aria-label={t("miniapp.place.gallery")} data-testid="place-photos">
      <div
        className="pc-track"
        onScroll={(e) => {
          const el = e.currentTarget;
          const w = el.firstElementChild?.clientWidth ?? el.clientWidth;
          setActive(Math.min(slides.length - 1, Math.round(el.scrollLeft / Math.max(1, w))));
        }}
      >
        {slides.map((s, i) => (
          <figure className="pc-slide" key={s.url}>
            <img
              src={s.url}
              alt={s.alt}
              loading={i === 0 ? "eager" : "lazy"}
              referrerPolicy="no-referrer"
              onError={() => setFailed((f) => new Set(f).add(s.url))}
            />
            {/* Кнопка поверх фото (не обёртка): фото остаётся изображением с alt в дереве доступности. */}
            <button
              type="button"
              className="pc-slide-open"
              aria-label={t("miniapp.place.photoOpen", { n: i + 1, total: slides.length })}
              onClick={() => setOpen(i)}
            />
            {s.authors.length > 0 && (
              <figcaption className="pc-credit">
                <Credit authors={s.authors} license={s.license} sourceUrl={s.sourceUrl} />
              </figcaption>
            )}
          </figure>
        ))}
      </div>
      {slides.length > 1 && (
        <span className="pc-counter" aria-hidden="true">
          {t("miniapp.place.photoCounter", { n: active + 1, total: slides.length })}
        </span>
      )}
      {open !== null && <Lightbox slides={slides} start={open} onClose={close} />}
    </section>
  );
}

// --- отзывы ---

function Stars({ value }: { value: number }) {
  const full = Math.round(value);
  return (
    <span className="pc-stars" aria-hidden="true">
      {"★★★★★".slice(0, full)}
      <span className="pc-stars-off">{"★★★★★".slice(full)}</span>
    </span>
  );
}

function ReviewItem({ review }: { review: Review }) {
  const { t } = useT();
  const long = review.text.length > 280;
  const [expanded, setExpanded] = useState(false);
  const a = review.author;
  return (
    <li className="pc-review" data-testid="place-review">
      <div className="pc-review-head">
        {a.photoUri ? (
          <img className="pc-avatar" src={a.photoUri} alt="" referrerPolicy="no-referrer" loading="lazy" />
        ) : (
          <span className="pc-avatar" aria-hidden="true">
            {a.name.slice(0, 1)}
          </span>
        )}
        <span className="pc-review-who">
          <strong>{a.uri ? <ExtLink href={a.uri}>{a.name}</ExtLink> : a.name}</strong>
          <span className="pc-muted">
            {review.rating !== null && (
              <>
                <Stars value={review.rating} />
                <span className="pc-sr">{t("miniapp.place.rating", { rating: review.rating })}</span>{" "}
              </>
            )}
            {review.relativeTime}
          </span>
        </span>
      </div>
      <p className="pc-review-text" data-clamped={long && !expanded ? true : undefined}>
        {review.text}
      </p>
      <div className="pc-review-foot">
        {long && (
          <button
            type="button"
            className="pc-textbtn"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {t(expanded ? "miniapp.place.reviewLess" : "miniapp.place.reviewMore")}
          </button>
        )}
        {review.uri && (
          <ExtLink href={review.uri} className="pc-textlink">
            {t("miniapp.place.reviewOnGoogle")}
          </ExtLink>
        )}
      </div>
    </li>
  );
}

/** Удобства чипами; длинный список свёрнут до первых OFFERS_SHOWN. */
const OFFERS_SHOWN = 10;
function Offers({ amenities }: { amenities: string[] }) {
  const { t } = useT();
  const [all, setAll] = useState(false);
  const shown = all ? amenities : amenities.slice(0, OFFERS_SHOWN);
  return (
    <Section title={t("miniapp.place.offers")} testId="place-offers">
      <ul className="pc-chips">
        {shown.map((a) => (
          <li key={a} className="pc-amenity">
            {t(`miniapp.place.amenity.${a}` as MessageKey)}
          </li>
        ))}
      </ul>
      {amenities.length > OFFERS_SHOWN && (
        <button type="button" className="pc-textbtn" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? t("miniapp.place.offersLess") : t("miniapp.place.offersAll", { count: amenities.length })}
        </button>
      )}
    </Section>
  );
}

// --- карточка ---

function PlaceView({ place }: { place: PlaceDetail }) {
  const { t, locale } = useT();
  const { api, analytics, webApp, signedIn, regionId } = useGuide();
  const resources = usePlaceResources(place.id, regionId);
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

  const route = place.location ? googleRouteUrl(place.location, place.googlePlaceId) : null;
  const verified = place.verifiedAt ? new Date(place.verifiedAt).toLocaleDateString("uk-UA") : null;
  // Своих фото нет, галереи Google нет (предел запросов) — обложка у нас с подписью автора.
  const googlePhotos = place.googlePhotos ?? [];
  const coverSlide: Slide[] =
    !place.photos.length && !googlePhotos.length && place.cover?.credit
      ? [
          {
            url: place.cover.url,
            largeUrl: place.cover.url,
            alt: name,
            authors: place.cover.credit.authors,
            license: place.cover.credit.license,
            sourceUrl: place.cover.credit.sourceUrl,
          },
        ]
      : [];
  const slides: Slide[] = [
    ...coverSlide,
    ...place.photos.map((p) => ({
      url: p.url,
      largeUrl: p.url,
      alt: p.alt ? pickLocalized(p.alt, locale) : name,
      authors: [],
    })),
    ...googlePhotos.map((p, i) => ({
      url: p.url,
      largeUrl: p.largeUrl,
      alt: `${name} — ${t("miniapp.place.photoOpen", { n: i + 1, total: googlePhotos.length })}`,
      authors: p.authors,
    })),
  ];
  const amenities = place.amenities ?? [];
  const reviews = place.reviews ?? [];
  const wiki = place.wikipedia ?? null;
  const about = place.aiSummary?.text ?? place.summary ?? null;
  // Автоописание импорта («Ресторан у Яремчі. Джерело: Google Maps.», descriptionAuto от api) не нужно, когда есть
  // содержательный текст; ручное описание (админка, партнёр) показывается всегда.
  const description =
    place.description && !(place.descriptionAuto && about) ? pickLocalized(place.description, locale) : null;
  const hasGoogle = Boolean(
    place.typeLabel ||
    place.summary ||
    (place.priceLevel !== null && place.priceLevel !== undefined) ||
    place.rating ||
    reviews.length ||
    amenities.length ||
    place.googlePhotos?.length,
  );
  const price =
    place.priceLevel !== null &&
    place.priceLevel !== undefined &&
    place.priceLevel >= 0 &&
    place.priceLevel <= 4
      ? t(`miniapp.place.price.${place.priceLevel}` as MessageKey)
      : null;

  return (
    <article aria-labelledby="place-title" className="pc">
      <Stack>
        {slides.length > 0 && <Gallery slides={slides} />}
        <header className="pc-head">
          {(place.typeLabel || price) && (
            <p className="pc-kicker" data-testid="place-type">
              {[place.typeLabel, price].filter(Boolean).join(" · ")}
            </p>
          )}
          <h1 id="place-title" ref={titleRef} tabIndex={-1} className="pc-title">
            {name}
          </h1>
          {place.rating && (
            <p className="pc-rating" data-testid="place-rating">
              <span className="pc-rating-value">{place.rating.value.toFixed(1)}</span>
              <Stars value={place.rating.value} />
              <span className="pc-sr">{t("miniapp.place.rating", { rating: place.rating.value })}</span>
              <span className="pc-muted">
                {t("miniapp.place.ratingCount", { count: place.rating.count.toLocaleString("uk-UA") })}
              </span>
            </p>
          )}
        </header>
        <span className="kosiv-place-meta">
          {distance && <span className="kosiv-chip">{distance}</span>}
          {place.openNow && place.openUntil && (
            <span className="kosiv-chip">{t("miniapp.place.openUntil", { time: place.openUntil })}</span>
          )}
          <PlaceBadges place={place} />
          <AvailabilityBadge resources={resources} />
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
            <ExtLink href={place.website} className="kosiv-action" variant="ghost">
              {t("miniapp.place.website")}
            </ExtLink>
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
        <BookingEntry placeId={place.id} resources={resources} signedIn={signedIn} />
        {!signedIn && <p className="pc-muted pc-small">{t("miniapp.place.favoriteNeedsLogin")}</p>}
        {favError && (
          <p role="alert">{t(favError === "auth" ? "miniapp.auth.again" : "miniapp.place.favoriteError")}</p>
        )}

        {place.peak && (
          <PeakDetails peak={place.peak} placeId={place.id} name={name} placeLocation={place.location} />
        )}

        {about && (
          <Section
            title={t("miniapp.place.about")}
            testId="place-about"
            aside={
              SHOW_AI_LABELS && place.aiSummary ? (
                <span className="pc-ai-badge" data-testid="place-ai-label">
                  {t("miniapp.place.aiLabel")}
                </span>
              ) : undefined
            }
          >
            <p className="pc-lead">{about}</p>
            {(SHOW_AI_LABELS || !place.aiSummary) && (
              <p className="pc-source">
                {place.aiSummary
                  ? t("miniapp.place.aiNote", { model: place.aiSummary.model })
                  : t("miniapp.place.summarySource")}
              </p>
            )}
          </Section>
        )}
        {description && <p className="pc-lead">{description}</p>}

        {amenities.length > 0 && <Offers amenities={amenities} />}

        {/* У вершини графіка немає — «Графік невідомий» не показуємо. */}
        {!(place.peak && !place.schedule.length) && (
          <Section title={t("miniapp.place.schedule")}>
            {place.schedule.length ? (
              <Schedule schedule={place.schedule} />
            ) : (
              <p className="pc-muted pc-m0">{t("miniapp.place.scheduleUnknown")}</p>
            )}
          </Section>
        )}

        {(place.address || place.phone || place.website || place.googleMapsUri) && (
          <Section title={t("miniapp.place.contacts")} testId="place-contacts">
            <dl className="pc-contacts">
              {place.address && (
                <>
                  <dt>{t("miniapp.place.address")}</dt>
                  <dd>{pickLocalized(place.address, locale)}</dd>
                </>
              )}
              {place.phone && (
                <>
                  <dt>{t("miniapp.place.call")}</dt>
                  <dd>
                    <a href={`tel:${place.phone}`}>{place.phone}</a>
                  </dd>
                </>
              )}
              {place.website && (
                <>
                  <dt>{t("miniapp.place.website")}</dt>
                  <dd>
                    <ExtLink href={place.website}>
                      {place.website.replace(/^https:\/\/(www\.)?/i, "").replace(/\/$/, "")}
                    </ExtLink>
                  </dd>
                </>
              )}
            </dl>
            {place.googleMapsUri && (
              <ExtLink href={place.googleMapsUri} className="pc-textlink" testId="place-google-maps">
                {t("miniapp.place.openInMaps")}
              </ExtLink>
            )}
          </Section>
        )}

        {reviews.length > 0 && (
          <Section title={t("miniapp.place.reviews")} testId="place-reviews">
            <ul className="pc-reviews">
              {reviews.map((r, i) => (
                <ReviewItem key={i} review={r} />
              ))}
            </ul>
            {place.googleMapsUri && (
              <ExtLink href={place.googleMapsUri} className="pc-textlink">
                {t("miniapp.place.reviewsAll")}
              </ExtLink>
            )}
          </Section>
        )}

        {wiki && (
          <Section title={t("miniapp.place.wikipedia")} testId="place-wikipedia">
            {wiki.image && (
              <figure className="pc-wiki-figure">
                <img src={wiki.image.url} alt={wiki.title} loading="lazy" />
                <figcaption className="pc-source">
                  <ExtLink href={wiki.image.sourceUrl}>
                    {wiki.image.author
                      ? t("miniapp.place.wikiImage", {
                          author: wiki.image.author,
                          license: wiki.image.license ?? "",
                        })
                      : t("miniapp.place.wikiImageNoAuthor", { license: wiki.image.license ?? "" })}
                  </ExtLink>
                </figcaption>
              </figure>
            )}
            <ExtLink href={wiki.url} className="pc-textlink">
              {t("miniapp.place.wikiReadMore")}
            </ExtLink>
            <p className="pc-source">{t("miniapp.place.wikiSource", { title: wiki.title })}</p>
          </Section>
        )}

        {place.tags.length > 0 && (
          <Section title={t("miniapp.place.attributes")}>
            <span className="pc-chips">
              {place.tags.map((tag, i) => (
                <Badge key={i}>{pickLocalized(tag, locale)}</Badge>
              ))}
            </span>
          </Section>
        )}
        <footer className="pc-footer">
          {verified && <p data-testid="place-verified">{t("miniapp.place.verified", { date: verified })}</p>}
          {hasGoogle && <p data-testid="place-google-attribution">{t("miniapp.place.googleAttribution")}</p>}
        </footer>
      </Stack>
    </article>
  );
}
