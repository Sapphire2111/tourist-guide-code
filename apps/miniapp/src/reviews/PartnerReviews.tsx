// P07 «Відгуки» кабинета партнёра (флаг module.reviews): отзывы о заведении (опубликованные и скрытые), ответ
// заведения (право review.respond — canRespond от сервера), жалоба на отзыв, апелляция, если модератор оставил отзыв по
// жалобе партнёра. Удалить или скрыть отзыв партнёр не может — только ответить и пожаловаться (ТЗ §5.3).
// Экран грузится лениво.
import { useId, useState } from "react";
import type { MessageKey } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync } from "../guide/context.js";
import { AsyncView } from "../guide/parts.js";
import { ApiCallError } from "../host/types.js";
import { useReviews } from "./context.js";
import {
  AppealForm,
  ComplaintForm,
  flagsText,
  isAutoFlag,
  Notice,
  Stars,
  useReviewErrorText,
} from "./parts.js";
import { RESPONSE_TEXT_MAX, type PartnerReview } from "./reviews-api.js";
import "./reviews.css";

export function PartnerReviews({ placeId }: { placeId: string }) {
  const { t } = useT();
  const { api } = useReviews();
  const [state, retry] = useAsync(() => api.partnerReviews(placeId), [api, placeId]);
  const [updated, setUpdated] = useState<Record<string, PartnerReview>>({});
  return (
    <Stack>
      <h1>{t("miniapp.partner.reviews.title")}</h1>
      <p className="pc-muted rv-meta">{t("miniapp.partner.reviews.hint")}</p>
      <AsyncView state={state} retry={retry} errorText={t("miniapp.partner.reviews.loadError")}>
        {(items) =>
          items.length === 0 ? (
            <p className="kosiv-card kosiv-empty" data-testid="partner-reviews-empty">
              {t("miniapp.partner.reviews.empty")}
            </p>
          ) : (
            <ul className="rv-list" data-testid="partner-reviews">
              {items.map((r) => (
                <PartnerReviewItem
                  key={r.id}
                  review={updated[r.id] ?? r}
                  onChange={(next) => setUpdated((u) => ({ ...u, [next.id]: next }))}
                />
              ))}
            </ul>
          )
        }
      </AsyncView>
    </Stack>
  );
}

type Panel = "respond" | "complain" | "appeal" | null;

function PartnerReviewItem({
  review: r,
  onChange,
}: {
  review: PartnerReview;
  onChange: (r: PartnerReview) => void;
}) {
  const { t, locale } = useT();
  const { api } = useReviews();
  const [panel, setPanel] = useState<Panel>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canComplain = r.status === "published" && !r.myComplaints.some((c) => c.status === "open");
  const canAppeal = r.canAppeal && !r.appeal;
  return (
    <li className="rv-item" data-testid="partner-review">
      <div className="rv-head">
        <Stars value={r.rating} />
        <span className="pc-sr">{t("miniapp.reviews.ratingOf", { rating: r.rating })}</span>
        <strong>{r.authorName ?? t("miniapp.reviews.guest")}</strong>
        <span className="pc-muted rv-meta">
          {new Date(r.publishedAt ?? r.createdAt).toLocaleDateString(locale)}
        </span>
      </div>
      <p className="rv-meta" data-testid="partner-review-status">
        {t(`miniapp.reviews.status.${r.status}` as MessageKey)}
      </p>
      <p className="rv-text">{r.text}</p>
      {r.response && (
        <div className="rv-reply" data-testid="review-response">
          <p className="rv-reply-title">{t("miniapp.reviews.response")}</p>
          <p>{r.response.text}</p>
        </div>
      )}
      {r.myComplaints.map((c) => (
        <p key={c.id} className="rv-meta" data-testid="my-complaint">
          {t("miniapp.partner.reviews.myComplaint", {
            reason: t(`miniapp.reviews.complaintReason.${c.reasonCode}` as MessageKey),
            status: t(`miniapp.partner.reviews.complaintStatus.${c.status}` as MessageKey),
          })}
        </p>
      ))}
      {r.appeal && (
        <p className="rv-meta" data-testid="review-appeal-status">
          {r.appeal.status === "open"
            ? t("miniapp.reviews.appealOpen")
            : r.appeal.status === "granted"
              ? t("miniapp.reviews.appealGranted")
              : r.appeal.decisionNote
                ? t("miniapp.reviews.appealDenied", { note: r.appeal.decisionNote })
                : t("miniapp.reviews.appealDeniedNoNote")}
        </p>
      )}
      {canAppeal && panel !== "appeal" && (
        <p className="rv-meta">{t("miniapp.partner.reviews.appealHint")}</p>
      )}
      {message && <p role="status">{message}</p>}

      {panel === "respond" && (
        <ResponseForm
          review={r}
          onCancel={() => setPanel(null)}
          onSaved={(response) => {
            onChange({ ...r, response });
            setPanel(null);
            setMessage(t("miniapp.partner.reviews.responseDone"));
          }}
        />
      )}
      {panel === "complain" && (
        <ComplaintForm
          onCancel={() => setPanel(null)}
          onSubmit={async (input) => {
            const c = await api.complain(r.regionId, r.id, input);
            onChange({ ...r, myComplaints: [...r.myComplaints, c] });
            setPanel(null);
            setMessage(t("miniapp.reviews.complainDone"));
          }}
        />
      )}
      {panel === "appeal" && (
        <AppealForm
          onCancel={() => setPanel(null)}
          onSubmit={async (text) => {
            const a = await api.appeal(r.regionId, r.id, text);
            onChange({ ...r, appeal: a, canAppeal: false });
            setPanel(null);
            setMessage(t("miniapp.reviews.appealDone"));
          }}
        />
      )}
      {panel === null && (
        <span className="rv-actions">
          {r.canRespond && r.status === "published" && (
            <button
              type="button"
              className="rv-link"
              data-testid="respond-open"
              onClick={() => {
                setMessage(null);
                setPanel("respond");
              }}
            >
              {t(r.response ? "miniapp.partner.reviews.editResponse" : "miniapp.partner.reviews.respond")}
            </button>
          )}
          {canComplain && (
            <button
              type="button"
              className="rv-link"
              data-testid="complain-open"
              onClick={() => {
                setMessage(null);
                setPanel("complain");
              }}
            >
              {t("miniapp.reviews.complain")}
            </button>
          )}
          {canAppeal && (
            <button
              type="button"
              className="rv-link"
              data-testid="appeal-open"
              onClick={() => {
                setMessage(null);
                setPanel("appeal");
              }}
            >
              {t("miniapp.reviews.appeal")}
            </button>
          )}
        </span>
      )}
    </li>
  );
}

/** Ответ заведения: один на отзыв, публикуется сразу; автофильтр (ссылки, телефоны, e-mail, мат) отклоняет с причиной. */
function ResponseForm({
  review,
  onSaved,
  onCancel,
}: {
  review: PartnerReview;
  onSaved: (r: NonNullable<PartnerReview["response"]>) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const { api } = useReviews();
  const errorText = useReviewErrorText();
  const id = useId();
  const [text, setText] = useState(review.response?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.respond(review.id, text.trim()));
    } catch (e) {
      const flags = e instanceof ApiCallError ? e.details?.flags : undefined;
      setError(
        Array.isArray(flags) && flags.length > 0
          ? t("miniapp.partner.reviews.responseRejected", { flags: flagsText(flags.filter(isAutoFlag), t) })
          : errorText(e, "miniapp.partner.reviews.responseError"),
      );
      setBusy(false);
    }
  };
  return (
    <form
      className="rv-form"
      data-testid="response-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="rv-field">
        {t("miniapp.partner.reviews.responseText")}
        <textarea
          id={id}
          rows={4}
          maxLength={RESPONSE_TEXT_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <Notice text={error} alert testId="response-error" />
      <span className="rv-actions">
        <Button type="submit" disabled={busy || !text.trim()} data-testid="response-send">
          {t("miniapp.partner.reviews.responseSend")}
        </Button>
        <Button type="button" disabled={busy} onClick={onCancel}>
          {t("miniapp.reviews.complainCancel")}
        </Button>
      </span>
    </form>
  );
}
