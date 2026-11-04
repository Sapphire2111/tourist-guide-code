// C13 «Перевірений відгук» (флаг module.reviews): оценка 1–5 + текст по праву из GET /reviews/eligibility (после
// завершённой брони). Повторная отправка по тому же праву — новая версия (окно правки считает сервер). Автофильтр
// (ссылки, телефоны, e-mail, мат) отправляет отзыв модератору — это объясняется до и после отправки; скрытый/
// отклонённый отзыв можно оспорить (апелляция). Экран грузится лениво (не входит в первый экран).
import { useId, useState } from "react";
import type { MessageKey } from "@tg/i18n";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "../guide/context.js";
import { AsyncView } from "../guide/parts.js";
import { UnauthorizedError } from "../guide/types.js";
import { useReviews } from "./context.js";
import { AppealForm, flagsText, Notice, Stars, useReviewErrorText } from "./parts.js";
import {
  canEditReview,
  editDeadline,
  REVIEW_TEXT_MAX,
  type MyReview,
  type ReviewEligibility,
} from "./reviews-api.js";
import "./reviews.css";

export function ReviewScreen({ eligibilityId }: { eligibilityId: string }) {
  const { t } = useT();
  const { regionId, signedIn } = useGuide();
  const { api } = useReviews();
  const [state, retry] = useAsync(
    () => (signedIn ? api.eligibility(regionId!) : Promise.reject(new UnauthorizedError())),
    [api, regionId, signedIn],
  );
  return (
    <Stack>
      {!signedIn ? (
        <>
          <h1>{t("miniapp.reviews.write")}</h1>
          <p role="alert">{t("miniapp.reviews.needsLogin")}</p>
        </>
      ) : (
        <AsyncView state={state} retry={retry} errorText={t("miniapp.reviews.loadError")}>
          {(items) => {
            const e = items.find((x) => x.id === eligibilityId);
            return e ? (
              <ReviewForm eligibility={e} />
            ) : (
              <>
                <h1>{t("miniapp.reviews.write")}</h1>
                <p role="alert" data-testid="review-not-found">
                  {t("miniapp.reviews.notFound")}
                </p>
              </>
            );
          }}
        </AsyncView>
      )}
    </Stack>
  );
}

const STATUS_NOTE: Record<MyReview["status"], MessageKey> = {
  published: "miniapp.reviews.status.published",
  pending_moderation: "miniapp.reviews.status.pending_moderation",
  hidden: "miniapp.reviews.status.hidden",
  rejected: "miniapp.reviews.status.rejected",
};

/** Выбор оценки 1–5: группа радиокнопок (кнопки ≥ 44 px). */
function RatingInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const { t } = useT();
  const label = useId();
  return (
    <div role="radiogroup" aria-labelledby={label} className="rv-stars-input" data-testid="rating-input">
      <span id={label} className="pc-sr">
        {t("miniapp.reviews.formRating")}
      </span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={t("miniapp.reviews.star", { n })}
          className="rv-star"
          data-on={n <= value ? true : undefined}
          onClick={() => onChange(n)}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function ReviewForm({ eligibility }: { eligibility: ReviewEligibility }) {
  const { t, locale } = useT();
  const { regionId } = useGuide();
  const { api } = useReviews();
  const errorText = useReviewErrorText();
  const textId = useId();
  const [review, setReview] = useState<MyReview | null>(eligibility.review);
  const [rating, setRating] = useState(eligibility.review?.rating ?? 0);
  const [text, setText] = useState(eligibility.review?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; alert: boolean } | null>(null);
  const [appealOpen, setAppealOpen] = useState(false);
  const place = pickLocalized(eligibility.placeName, locale);

  // Новый отзыв — до eligibility.expiresAt; правка уже написанного — createdAt + окно правки (как editAllowed сервера).
  const expired = Date.parse(eligibility.expiresAt) <= Date.now();
  const editDone = review !== null && !canEditReview(review);
  const editable =
    eligibility.status === "active"
      ? !expired
      : eligibility.status === "consumed" && review !== null && !editDone;
  const deadline = review ? editDeadline(review) : Date.parse(eligibility.expiresAt);
  const closedKey: MessageKey | null =
    eligibility.status === "revoked"
      ? "miniapp.reviews.revoked"
      : eligibility.status === "expired" || (eligibility.status === "active" && expired)
        ? "miniapp.reviews.expired"
        : eligibility.status === "consumed" && editDone
          ? "miniapp.reviews.editClosed"
          : null;

  const submit = async () => {
    if (busy) return;
    if (rating < 1) return setMessage({ text: t("miniapp.reviews.ratingRequired"), alert: true });
    const body = text.trim();
    if (!body) return setMessage({ text: t("miniapp.reviews.textRequired"), alert: true });
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api.submit(regionId!, { eligibilityId: eligibility.id, rating, text: body });
      setReview(saved);
      const key: MessageKey =
        saved.status === "pending_moderation"
          ? "miniapp.reviews.donePending"
          : review
            ? "miniapp.reviews.doneEdit"
            : "miniapp.reviews.doneNew";
      setMessage({ text: t(key), alert: false });
    } catch (e) {
      setMessage({ text: errorText(e, "miniapp.reviews.sendError"), alert: true });
    }
    setBusy(false);
  };

  return (
    <Stack>
      <h1>{t("miniapp.reviews.formTitle", { place })}</h1>
      <p className="pc-muted rv-meta">{t("miniapp.reviews.verified")}</p>

      {review && (
        <section className="kosiv-card rv-booking-review" data-testid="my-review">
          <h2 className="rv-h3">{t("miniapp.reviews.mine")}</h2>
          <span>
            <Stars value={review.rating} />{" "}
            <span className="pc-sr">{t("miniapp.reviews.ratingOf", { rating: review.rating })}</span>
          </span>
          <p data-testid="my-review-status">
            <strong>{t(STATUS_NOTE[review.status])}</strong>
          </p>
          {review.status === "pending_moderation" && review.autoFlags.length > 0 && (
            <p data-testid="my-review-flags">
              {t("miniapp.reviews.pendingNote", { flags: flagsText(review.autoFlags, t) })}
            </p>
          )}
          {(review.status === "hidden" || review.status === "rejected") && review.hiddenReason && (
            <p data-testid="my-review-reason">
              {t("miniapp.reviews.hiddenReason", { reason: review.hiddenReason })}
            </p>
          )}
          {review.response && (
            <div className="rv-reply">
              <p className="rv-reply-title">{t("miniapp.reviews.response")}</p>
              <p>{review.response.text}</p>
            </div>
          )}
          <Appeal review={review} open={appealOpen} setOpen={setAppealOpen} onDone={setReview} />
        </section>
      )}

      {closedKey && (
        <p role="alert" data-testid="review-closed">
          {t(closedKey)}
        </p>
      )}

      {editable ? (
        <form
          className="rv-form"
          data-testid="review-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="pc-muted rv-meta">
            {t("miniapp.reviews.expiresAt", {
              date: new Date(deadline).toLocaleDateString(locale),
            })}
          </p>
          <RatingInput value={rating} onChange={setRating} />
          <label htmlFor={textId} className="rv-field">
            {t("miniapp.reviews.formText")}
            <textarea
              id={textId}
              rows={6}
              maxLength={REVIEW_TEXT_MAX}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-describedby={`${textId}-hint`}
            />
          </label>
          <p id={`${textId}-hint`} className="pc-muted rv-meta">
            {t("miniapp.reviews.formHint")}{" "}
            {t("miniapp.reviews.counter", { n: text.length, max: REVIEW_TEXT_MAX })}
          </p>
          <Notice text={message?.text ?? null} alert={message?.alert} testId="review-message" />
          <Button type="submit" disabled={busy} data-testid="review-submit">
            {busy ? t("miniapp.reviews.sending") : t("miniapp.reviews.send")}
          </Button>
        </form>
      ) : (
        <Notice text={message?.text ?? null} alert={message?.alert} testId="review-message" />
      )}

      <Link to={`/place/${eligibility.placeId}`} data-testid="review-to-place">
        {t("miniapp.reviews.toPlace")}
      </Link>
    </Stack>
  );
}

/** Апелляция автора на скрытый/отклонённый отзыв (одна на отзыв; решает другой модератор). */
function Appeal({
  review,
  open,
  setOpen,
  onDone,
}: {
  review: MyReview;
  open: boolean;
  setOpen: (v: boolean) => void;
  onDone: (r: MyReview) => void;
}) {
  const { t } = useT();
  const { regionId } = useGuide();
  const { api } = useReviews();
  const a = review.appeal;
  if (a)
    return (
      <p data-testid="my-review-appeal">
        {a.status === "open"
          ? t("miniapp.reviews.appealOpen")
          : a.status === "granted"
            ? t("miniapp.reviews.appealGranted")
            : a.decisionNote
              ? t("miniapp.reviews.appealDenied", { note: a.decisionNote })
              : t("miniapp.reviews.appealDeniedNoNote")}
      </p>
    );
  if (!review.canAppeal) return null;
  return open ? (
    <AppealForm
      onCancel={() => setOpen(false)}
      onSubmit={async (text) => {
        const created = await api.appeal(regionId!, review.id, text);
        setOpen(false);
        onDone({ ...review, appeal: created, canAppeal: false });
      }}
    />
  ) : (
    <button type="button" className="rv-link" onClick={() => setOpen(true)} data-testid="appeal-open">
      {t("miniapp.reviews.appeal")}
    </button>
  );
}
