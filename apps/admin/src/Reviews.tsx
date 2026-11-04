// Модерація відгуків (AD06, блок 10): черга (автофільтр, скарги, апеляції), картка відгуку, рішення й апеляції.
import { useEffect, useState } from "react";
import { Stack, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import { formatDate } from "./dates.js";
import {
  ErrorBox,
  Field,
  Notice,
  SmallButton,
  row,
  SelectField,
  useAdmin,
  useBusy,
  useLoad,
  useLocalized,
} from "./ui.js";

type Review = ApiSchemas["AdminReviewDto"];
type ServerFilter = ApiSchemas["AdminReviewFilter"];

/** Фильтры экрана: auto/complaints/appeals — очередь (сервер отдаёт queue, уточнение на клиенте), остальные — журнал. */
export const REVIEW_FILTERS = [
  "queue",
  "auto",
  "complaints",
  "appeals",
  "all",
  "published",
  "hidden",
  "rejected",
] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];
const REASON_MAX = 500;

/** Запрос к серверу для фильтра экрана. */
export function serverFilter(f: ReviewFilter): ServerFilter {
  return f === "auto" || f === "complaints" || f === "appeals" ? "queue" : f;
}

export const hasOpenComplaint = (r: Review): boolean => r.complaints.some((c) => c.status === "open");
export const hasOpenAppeal = (r: Review): boolean => r.appeal?.status === "open";

/** Уточнение очереди: автофильтр — ждёт модерации, скарги — есть открытая жалоба, апелляции — открытая апелляция. */
export function matchesFilter(r: Review, f: ReviewFilter): boolean {
  if (f === "auto") return r.status === "pending_moderation";
  if (f === "complaints") return hasOpenComplaint(r);
  if (f === "appeals") return hasOpenAppeal(r);
  return true;
}

/** Причина: обрезанная, непустая — иначе undefined. */
export function reasonOf(text: string): string | undefined {
  return text.trim() || undefined;
}

/** Ошибка решения для показа: понятный текст по причине/ключу, остальное — как есть (ErrorBox). */
export function ReviewError({ error }: { error: ApiError | null }) {
  const { t } = useT();
  if (!error) return null;
  const has = (reason: string) => error.problems?.includes(reason);
  const text =
    error.status === 403
      ? has("own_organization")
        ? t("admin.reviews.err.ownOrganization")
        : has("same_moderator")
          ? t("admin.reviews.err.sameModerator")
          : has("appeal_final")
            ? t("admin.reviews.err.appealFinal")
            : t("admin.reviews.forbidden")
      : error.status === 404
        ? t("admin.reviews.err.notFound")
        : error.status === 409
          ? error.messageKey === "errors.review.appealPending"
            ? t("admin.reviews.err.appealPending")
            : error.messageKey === "errors.review.appealDecided"
              ? t("admin.reviews.err.appealDecided")
              : error.messageKey === "errors.review.nothingToDecide"
                ? t("admin.reviews.err.nothingToDecide")
                : t("admin.reviews.err.changed")
          : null;
  if (!text) return <ErrorBox error={error} />;
  return (
    <p role="alert" style={{ color: "#b3261e", margin: 0 }}>
      {text}
    </p>
  );
}

type Outcome = { notice: string | null; error: ApiError | null; id: string | null };

export function ReviewsScreen() {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const [filter, setFilter] = useState<ReviewFilter>("queue");
  const [result, reload] = useLoad(
    () => call(api.GET("/admin/reviews", { params: { query: { status: serverFilter(filter) } } })),
    [filter],
  );
  const [outcome, setOutcome] = useState<Outcome>({ notice: null, error: null, id: null });
  const forbidden = result && !result.ok && result.error.status === 403;
  // Пока список перечитывается после решения, кнопки заблокированы: повторный клик ушёл бы по устаревшей карточке.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => setRefreshing(false), [result]);
  const stale = outcome.error?.status === 409 || outcome.error?.status === 404;
  return (
    <Stack gap={3}>
      <p style={{ margin: 0 }}>{t("admin.reviews.hint")}</p>
      <div style={row}>
        <SelectField
          label={t("admin.field.status")}
          value={filter}
          options={REVIEW_FILTERS.map((f) => ({ value: f, label: tDynamic(`admin.reviews.filter.${f}`) }))}
          onChange={(v) => {
            setFilter(v as ReviewFilter);
            setOutcome({ notice: null, error: null, id: null });
          }}
        />
        <SmallButton type="button" onClick={reload}>
          {t("admin.moderation.refresh")}
        </SmallButton>
      </div>
      <Notice text={outcome.notice} />
      {/* 409/404: карточка исчезает после перечитывания, поэтому текст не привязан к ней. */}
      {stale && <ReviewError error={outcome.error} />}
      {forbidden ? (
        <p role="alert">{t("admin.reviews.forbidden")}</p>
      ) : !result ? (
        <p>{t("admin.loading")}</p>
      ) : !result.ok ? (
        <ErrorBox error={result.error} />
      ) : (
        <ReviewList
          items={result.data.items.filter((r) => matchesFilter(r, filter))}
          outcome={outcome}
          locked={refreshing}
          onOutcome={(o) => {
            setOutcome(o);
            if (o.notice || o.error?.status === 409 || o.error?.status === 404) {
              setRefreshing(true);
              reload();
            }
          }}
        />
      )}
    </Stack>
  );
}

function ReviewList({
  items,
  outcome,
  locked,
  onOutcome,
}: {
  items: Review[];
  outcome: Outcome;
  locked: boolean;
  onOutcome: (o: Outcome) => void;
}) {
  const { t } = useT();
  if (items.length === 0) return <p>{t("admin.reviews.empty")}</p>;
  return (
    <Stack gap={3}>
      {items.map((r) => (
        <ReviewCard
          key={r.id}
          r={r}
          error={
            outcome.id === r.id && outcome.error?.status !== 409 && outcome.error?.status !== 404
              ? outcome.error
              : null
          }
          locked={locked}
          onOutcome={onOutcome}
        />
      ))}
    </Stack>
  );
}

function Stars({ rating }: { rating: number }) {
  const { t } = useT();
  return (
    <span aria-label={t("admin.reviews.rating", { n: rating })}>
      {"★".repeat(rating) + "☆".repeat(Math.max(0, 5 - rating))}
    </span>
  );
}

function ReviewCard({
  r,
  error,
  locked,
  onOutcome,
}: {
  r: Review;
  error: ApiError | null;
  locked: boolean;
  onOutcome: (o: Outcome) => void;
}) {
  const { t, tDynamic, locale } = useT();
  const l = useLocalized();
  const title = `${l(r.placeName)} · ${r.authorName ?? t("admin.reviews.anonymous")}`;
  const openComplaints = r.complaints.filter((c) => c.status === "open").length;
  const flags = (list: Review["autoFlags"]) =>
    list.map((f) => tDynamic(`admin.reviews.flag.${f}`)).join(", ");
  return (
    <article aria-label={title} style={{ border: "1px solid #6b6f75", borderRadius: 6, padding: 12 }}>
      <Stack gap={2}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <p style={{ margin: 0 }}>
          <Stars rating={r.rating} /> · {tDynamic(`admin.reviews.status.${r.status}`)} ·{" "}
          {t("admin.reviews.version", { n: r.version })} · {formatDate(r.createdAt, locale)}
        </p>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.text}</p>
        {r.autoFlags.length > 0 && (
          <p style={{ margin: 0 }}>
            {t("admin.reviews.autoFlags")}: {flags(r.autoFlags)}
          </p>
        )}
        {r.hiddenReason && (
          <p style={{ margin: 0 }}>
            {t("admin.reviews.hiddenReason")}: {r.hiddenReason}
          </p>
        )}
        {openComplaints > 0 && (
          <p role="note" style={{ margin: 0, fontWeight: 600 }}>
            {t("admin.reviews.openComplaints", { n: openComplaints })}
          </p>
        )}
        {r.revisions.length > 1 && (
          <details>
            <summary>{t("admin.reviews.revisions", { n: r.revisions.length })}</summary>
            <ol style={{ margin: 0 }}>
              {r.revisions.map((v) => (
                <li key={v.version}>
                  {t("admin.reviews.version", { n: v.version })} · {formatDate(v.createdAt, locale)} ·{" "}
                  <Stars rating={v.rating} />
                  {v.autoFlags.length > 0 && ` · ${flags(v.autoFlags)}`}
                  <br />
                  {v.text}
                </li>
              ))}
            </ol>
          </details>
        )}
        {r.complaints.length > 0 && (
          <section aria-label={t("admin.reviews.complaints")}>
            <p style={{ margin: 0, fontWeight: 600 }}>{t("admin.reviews.complaints")}</p>
            <ul style={{ margin: 0 }}>
              {r.complaints.map((c) => (
                <li key={c.id}>
                  {tDynamic(`admin.reviews.complaintKind.${c.kind}`)} ·{" "}
                  {tDynamic(`admin.reviews.reason.${c.reasonCode}`)} ·{" "}
                  {tDynamic(`admin.reviews.complaintStatus.${c.status}`)} · {formatDate(c.createdAt, locale)}
                  {c.text ? ` — ${c.text}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}
        {r.response && (
          <section aria-label={t("admin.reviews.response")}>
            <p style={{ margin: 0, fontWeight: 600 }}>{t("admin.reviews.response")}</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.response.text}</p>
          </section>
        )}
        {r.appeal && (
          <section aria-label={t("admin.reviews.appeal")}>
            <p style={{ margin: 0, fontWeight: 600 }}>
              {t("admin.reviews.appeal")}: {tDynamic(`admin.reviews.appealKind.${r.appeal.kind}`)} ·{" "}
              {tDynamic(`admin.reviews.appealStatus.${r.appeal.status}`)}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.appeal.text}</p>
            {r.appeal.decisionNote && (
              <p style={{ margin: 0 }}>
                {t("admin.reviews.decisionNote")}: {r.appeal.decisionNote}
              </p>
            )}
          </section>
        )}
        <ReviewError error={error} />
        <Decisions r={r} locked={locked} onOutcome={onOutcome} />
      </Stack>
    </article>
  );
}

function Decisions({
  r,
  locked,
  onOutcome,
}: {
  r: Review;
  locked: boolean;
  onOutcome: (o: Outcome) => void;
}) {
  const { api } = useAdmin();
  const { t } = useT();
  const [reason, setReason] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const [pending, act] = useBusy();
  const busy = pending || locked;
  const path = { params: { path: { id: r.id } } };

  if (r.ownOrganization) return <p role="note">{t("admin.reviews.err.ownOrganization")}</p>;
  const appealing = hasOpenAppeal(r);
  if (appealing && !r.canDecideAppeal) return <p role="note">{t("admin.reviews.err.sameModerator")}</p>;

  const finish = (res: { ok: true } | { ok: false; error: ApiError }, message: string) => {
    onOutcome(
      res.ok ? { notice: message, error: null, id: null } : { notice: null, error: res.error, id: r.id },
    );
    if (res.ok) setReason("");
  };

  // Апелляция партнёра: grant скрывает отзыв, автор увидит причину — как при «Приховати».
  const grantNeedsReason = r.appeal?.kind === "partner";
  const decideAppeal = (decision: "grant" | "deny") => async () => {
    if (decision === "grant" && grantNeedsReason && !reasonOf(reason))
      return setLocal(t("admin.reviews.reasonRequired"));
    setLocal(null);
    const res = await call(
      api.POST("/admin/reviews/{id}/appeal-decision", {
        ...path,
        body: { decision, reason: reasonOf(reason) },
      }),
    );
    finish(res, t(decision === "grant" ? "admin.reviews.appealGranted" : "admin.reviews.appealDenied"));
  };
  const decide = (decision: "publish" | "hide") => async () => {
    const why = reasonOf(reason);
    if (decision === "hide" && !why) return setLocal(t("admin.reviews.reasonRequired"));
    setLocal(null);
    const res = await call(
      api.POST("/admin/reviews/{id}/decision", { ...path, body: { decision, reason: why } }),
    );
    finish(res, t(decision === "publish" ? "admin.reviews.published" : "admin.reviews.hidden"));
  };

  if (appealing)
    return (
      <form aria-label={t("admin.reviews.appealDecision")} onSubmit={(e) => e.preventDefault()}>
        <Stack gap={1}>
          <p role="note" style={{ margin: 0 }}>
            {t("admin.reviews.appealFinalHint")}
          </p>
          <Field
            label={t(grantNeedsReason ? "admin.reviews.reasonGrantPartner" : "admin.reviews.reason")}
            value={reason}
            multiline
            maxLength={REASON_MAX}
            onChange={setReason}
          />
          {local && <p role="alert">{local}</p>}
          <div style={row}>
            <SmallButton type="button" disabled={busy} onClick={() => act(decideAppeal("grant"))}>
              {t("admin.reviews.grant")}
            </SmallButton>
            <SmallButton type="button" disabled={busy} onClick={() => act(decideAppeal("deny"))}>
              {t("admin.reviews.deny")}
            </SmallButton>
          </div>
        </Stack>
      </form>
    );

  const publishLabel =
    r.status === "pending_moderation"
      ? t("admin.reviews.approve")
      : r.status === "published"
        ? t("admin.reviews.keep")
        : t("admin.reviews.restore");
  const hideLabel = r.status === "pending_moderation" ? t("admin.reviews.reject") : t("admin.reviews.hide");
  // Опубликованному без открытых жалоб «оставлять» нечего (сервер ответил бы nothingToDecide).
  const canPublish = r.status !== "published" || hasOpenComplaint(r);
  const canHide = r.status === "published" || r.status === "pending_moderation";
  if (!canPublish && !canHide) return null;
  return (
    <form aria-label={t("admin.reviews.decision")} onSubmit={(e) => e.preventDefault()}>
      <Stack gap={1}>
        <Field
          label={t(canHide ? "admin.reviews.reasonHide" : "admin.reviews.reason")}
          value={reason}
          multiline
          maxLength={REASON_MAX}
          onChange={setReason}
        />
        {local && <p role="alert">{local}</p>}
        <div style={row}>
          {canPublish && (
            <SmallButton type="button" disabled={busy} onClick={() => act(decide("publish"))}>
              {publishLabel}
            </SmallButton>
          )}
          {canHide && (
            <SmallButton type="button" disabled={busy} onClick={() => act(decide("hide"))}>
              {hideLabel}
            </SmallButton>
          )}
        </div>
      </Stack>
    </form>
  );
}
