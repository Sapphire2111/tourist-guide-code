// Общие элементы отзывов: звёзды, рейтинг (D-37), тексты ошибок, флаги автофильтра, формы жалобы и апелляции.
import { useId, useState, type ReactNode } from "react";
import type { MessageKey } from "@tg/i18n";
import { Button, useT } from "@tg/ui";
import { useErrorText } from "../host/errors.js";
import { ApiCallError, NetworkError } from "../host/types.js";
import {
  APPEAL_TEXT_MAX,
  COMPLAINT_REASONS,
  COMPLAINT_TEXT_MAX,
  type ComplaintReason,
  type PlaceRating,
  type ReviewAutoFlag,
} from "./reviews-api.js";
import "./reviews.css";

/** Звёзды оценки (декоративные: значение читалке отдаёт текст рядом). */
export function Stars({ value }: { value: number }) {
  const full = Math.round(value);
  return (
    <span className="rv-stars" aria-hidden="true">
      {"★★★★★".slice(0, full)}
      <span className="rv-stars-off">{"★★★★★".slice(full)}</span>
    </span>
  );
}

/** Рейтинг места по формуле D-37: цифра только от minReviews отзывов, иначе «Мало відгуків». */
export function RatingSummary({ rating }: { rating: PlaceRating }) {
  const { t } = useT();
  return (
    <p className="rv-summary" data-testid="reviews-rating">
      {rating.fewReviews || rating.score === null ? (
        <strong>{t("miniapp.reviews.few")}</strong>
      ) : (
        <>
          <Stars value={rating.score} />
          <strong>{rating.score.toFixed(1)}</strong>
          <span className="pc-sr">{t("miniapp.reviews.score", { score: rating.score.toFixed(1) })}</span>
        </>
      )}
      {rating.reviewCount > 0 && (
        <span className="pc-muted"> · {t("miniapp.reviews.count", { count: rating.reviewCount })}</span>
      )}
    </p>
  );
}

/** Текст ошибки отзывов: сеть, 403 без перевода, известный messageKey сервера (errors.review.*), иначе запасной. */
export function useReviewErrorText(): (err: unknown, fallback: MessageKey) => string {
  const { t } = useT();
  const base = useErrorText();
  return (err, fallback) => {
    if (err instanceof NetworkError) return t("miniapp.reviews.network");
    const text = base(err, fallback);
    if (err instanceof ApiCallError && err.status === 403 && text === t(fallback))
      return t("miniapp.reviews.forbidden");
    return text;
  };
}

/** Перечень сработавших флагов автофильтра: «посилання, номер телефону». */
export function flagsText(flags: readonly string[], t: (key: MessageKey) => string): string {
  return flags.map((f) => t(`miniapp.reviews.flag.${f}` as MessageKey)).join(", ");
}

export function isAutoFlag(x: unknown): x is ReviewAutoFlag {
  return x === "link" || x === "phone" || x === "email" || x === "profanity";
}

/** Живое сообщение (status/alert всегда в DOM — читалка объявляет изменения). */
export function Notice({ text, alert, testId }: { text: string | null; alert?: boolean; testId?: string }) {
  return (
    <div data-testid={testId}>
      <p role="status">{text && !alert ? text : ""}</p>
      <p role="alert">{text && alert ? text : ""}</p>
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <label htmlFor={id} className="rv-field">
      {label}
      {children}
    </label>
  );
}

/**
 * Форма жалобы на отзыв (турист и партнёр): причина из справочника и необязательный текст. Закрывается при успехе —
 * сообщение показывает вызывающий.
 */
export function ComplaintForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: { reasonCode: ComplaintReason; text?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useT();
  const errorText = useReviewErrorText();
  const ids = { reason: useId(), text: useId() };
  const [reason, setReason] = useState<ComplaintReason>("insult");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = text.trim();
      await onSubmit({ reasonCode: reason, ...(body ? { text: body } : {}) });
    } catch (e) {
      setError(errorText(e, "miniapp.reviews.complainError"));
      setBusy(false);
    }
  };
  return (
    <form
      className="rv-form"
      data-testid="complaint-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="rv-h3">{t("miniapp.reviews.complainTitle")}</h3>
      <Field label={t("miniapp.reviews.complainReason")} id={ids.reason}>
        <select id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value as ComplaintReason)}>
          {COMPLAINT_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`miniapp.reviews.complaintReason.${r}` as MessageKey)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("miniapp.reviews.complainText")} id={ids.text}>
        <textarea
          id={ids.text}
          rows={3}
          maxLength={COMPLAINT_TEXT_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <p role="alert" data-testid="complaint-error">
        {error ?? ""}
      </p>
      <span className="rv-actions">
        <Button type="submit" disabled={busy} data-testid="complaint-send">
          {t("miniapp.reviews.complainSend")}
        </Button>
        <Button type="button" disabled={busy} onClick={onCancel}>
          {t("miniapp.reviews.complainCancel")}
        </Button>
      </span>
    </form>
  );
}

/** Форма апелляции (автор — на скрытый/отклонённый отзыв; владелец — на «оставить» по его жалобе). */
export function AppealForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useT();
  const errorText = useReviewErrorText();
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim());
    } catch (e) {
      setError(errorText(e, "miniapp.reviews.appealError"));
      setBusy(false);
    }
  };
  return (
    <form
      className="rv-form"
      data-testid="appeal-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label={t("miniapp.reviews.appealText")} id={id}>
        <textarea
          id={id}
          rows={3}
          maxLength={APPEAL_TEXT_MAX}
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <p role="alert">{error ?? ""}</p>
      <span className="rv-actions">
        <Button type="submit" disabled={busy || !text.trim()} data-testid="appeal-send">
          {t("miniapp.reviews.appealSend")}
        </Button>
        <Button type="button" disabled={busy} onClick={onCancel}>
          {t("miniapp.reviews.complainCancel")}
        </Button>
      </span>
    </form>
  );
}
