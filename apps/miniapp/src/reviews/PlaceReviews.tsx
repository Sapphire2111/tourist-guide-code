// Отзывы в карточке места (C06, флаг module.reviews): рейтинг по D-37 («Мало відгуків» вместо цифры при малом числе
// отзывов), список опубликованных подтверждённых отзывов с ответом заведения, «Поскаржитися», вход «Залишити
// відгук» — только если сервер выдал право (после завершённой брони, eligibility active). Нет флага/провайдера/
// региона — блока нет. Рейтинг и отзывы Google — отдельные блоки карточки (рейтинг Google здесь не участвует).
import { useState } from "react";
import { Link, useT } from "@tg/ui";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView } from "../guide/parts.js";
import { useMyEligibility, useReviewsApi } from "./context.js";
import { ComplaintForm, RatingSummary, Stars } from "./parts.js";
import type { PublicReview, ReviewEligibility, ReviewsApi } from "./reviews-api.js";
import "../guide/place-card.css";
import "./reviews.css";

export function PlaceReviews({ placeId }: { placeId: string }) {
  const api = useReviewsApi();
  const { regionId } = useGuide();
  if (!api || !regionId) return null;
  return <Block api={api} regionId={regionId} placeId={placeId} />;
}

function Block({ api, regionId, placeId }: { api: ReviewsApi; regionId: string; placeId: string }) {
  const { t } = useT();
  const { signedIn } = useGuide();
  const [state, retry] = useAsync(() => api.placeReviews(regionId, placeId), [api, regionId, placeId]);
  const eligibility = useMyEligibility(regionId, signedIn)?.filter((e) => e.placeId === placeId);
  return (
    <section className="pc-section" data-testid="place-guest-reviews">
      <header className="pc-section-head">
        <h2 className="pc-h2">{t("miniapp.reviews.title")}</h2>
      </header>
      <AsyncView state={state} retry={retry} errorText={t("miniapp.reviews.loadError")}>
        {({ rating, items }) => (
          <>
            <RatingSummary rating={rating} />
            {items.length === 0 ? (
              <p className="pc-muted" data-testid="reviews-empty">
                {t("miniapp.reviews.empty")}
              </p>
            ) : (
              <ul className="rv-list" data-testid="guest-reviews">
                {items.map((r) => (
                  <ReviewItem key={r.id} review={r} api={api} regionId={regionId} signedIn={signedIn} />
                ))}
              </ul>
            )}
          </>
        )}
      </AsyncView>
      {eligibility && <WriteEntry items={eligibility} />}
    </section>
  );
}

/** «Залишити відгук» (право active) или «Змінити свій відгук» (отзыв уже есть); истёкшее/отозванное — без входа. */
function WriteEntry({ items }: { items: ReviewEligibility[] }) {
  const { t } = useT();
  const active = items.find((e) => e.status === "active");
  const consumed = items.find((e) => e.status === "consumed" && e.review);
  const target = active ?? consumed;
  if (!target) return null;
  return (
    <div data-testid="review-write">
      <Link to={`/review/${target.id}`} className="kosiv-cta" data-testid="review-write-link">
        {t(active ? "miniapp.reviews.write" : "miniapp.reviews.edit")}
      </Link>
    </div>
  );
}

function ReviewItem({
  review: r,
  api,
  regionId,
  signedIn,
}: {
  review: PublicReview;
  api: ReviewsApi;
  regionId: string;
  signedIn: boolean;
}) {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <li className="rv-item" data-testid="guest-review">
      <div className="rv-head">
        <Stars value={r.rating} />
        <span className="pc-sr">{t("miniapp.reviews.ratingOf", { rating: r.rating })}</span>
        <strong>{r.authorName ?? t("miniapp.reviews.guest")}</strong>
        <span className="pc-muted rv-meta">
          {t("miniapp.reviews.verified")} · {new Date(r.publishedAt).toLocaleDateString(locale)}
        </span>
      </div>
      <p className="rv-text">{r.text}</p>
      {r.response && (
        <div className="rv-reply" data-testid="review-response">
          <p className="rv-reply-title">{t("miniapp.reviews.response")}</p>
          <p>{r.response.text}</p>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {!message &&
        (signedIn ? (
          open ? (
            <ComplaintForm
              onCancel={() => setOpen(false)}
              onSubmit={async (input) => {
                await api.complain(regionId, r.id, input);
                setOpen(false);
                setMessage(t("miniapp.reviews.complainDone"));
              }}
            />
          ) : (
            <button
              type="button"
              className="rv-link"
              onClick={() => setOpen(true)}
              data-testid="complain-open"
            >
              {t("miniapp.reviews.complain")}
            </button>
          )
        ) : null)}
    </li>
  );
}
