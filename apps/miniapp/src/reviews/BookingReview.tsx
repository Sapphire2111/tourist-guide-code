// «Залишити відгук» в «Мої бронювання» (C21 → C13, флаг module.reviews): для завершённой брони, по которой сервер
// выдал право (eligibility.bookingId). active — вход в форму; consumed — статус своего отзыва и «Змінити»;
// expired/revoked — пояснение. Нет флага, права или брони не completed — ничего.
import { Link, useT } from "@tg/ui";
import type { MessageKey } from "@tg/i18n";
import { canEditReview, type ReviewEligibility } from "./reviews-api.js";
import "./reviews.css";

export function BookingReview({
  bookingId,
  completed,
  eligibility,
}: {
  bookingId: string;
  completed: boolean;
  /** Права пользователя (useMyEligibility); undefined — не загружены или модуль выключен. */
  eligibility: ReviewEligibility[] | undefined;
}) {
  const { t, locale } = useT();
  if (!completed || !eligibility) return null;
  const e = eligibility.find((x) => x.bookingId === bookingId);
  if (!e) return null;
  const expired = Date.parse(e.expiresAt) <= Date.now();
  if (e.status === "active" && !expired)
    return (
      <div className="rv-booking-review" data-testid="booking-review">
        <Link to={`/review/${e.id}`} className="kosiv-cta" data-testid="booking-review-link">
          {t("miniapp.reviews.write")}
        </Link>
        <p className="pc-muted rv-meta">
          {t("miniapp.reviews.expiresAt", { date: new Date(e.expiresAt).toLocaleDateString(locale) })}
        </p>
      </div>
    );
  if (e.status === "consumed" && e.review) {
    // Править можно createdAt + окно правки (как на сервере), а не до expiresAt права.
    const editable = canEditReview(e.review);
    return (
      <div className="rv-booking-review" data-testid="booking-review">
        <p className="rv-meta" data-testid="booking-review-status">
          {t("miniapp.reviews.mine")}: {t(`miniapp.reviews.status.${e.review.status}` as MessageKey)}
        </p>
        {(editable || e.review.canAppeal || e.review.appeal) && (
          <Link to={`/review/${e.id}`} data-testid="booking-review-link">
            {t(editable ? "miniapp.reviews.edit" : "miniapp.reviews.mine")}
          </Link>
        )}
      </div>
    );
  }
  const note: MessageKey | null =
    e.status === "revoked"
      ? "miniapp.reviews.revoked"
      : e.status === "expired" || (e.status === "active" && expired)
        ? "miniapp.reviews.expired"
        : null;
  return note ? (
    <p className="pc-muted rv-meta" data-testid="booking-review-closed">
      {t(note)}
    </p>
  ) : null;
}
