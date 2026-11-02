// Модерація партнерів (AD02, S-05): черга заявок, картка заявки, рішення (схвалити / повернути / відхилити).
import { useState } from "react";
import { Link, Stack, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import { formatDate } from "./dates.js";
import {
  ErrorBox,
  Field,
  Form,
  Loaded,
  Notice,
  useBusy,
  row,
  SelectField,
  SmallButton,
  Table,
  Td,
  useAdmin,
  useLoad,
  useLocalized,
} from "./ui.js";

type Case = ApiSchemas["ModerationCaseDto"];
type Detail = ApiSchemas["ModerationCaseDetailDto"];
export const CASE_STATUSES = ["open", "decided"] as const;
export const VERIFICATION_METHODS = ["phone_call", "document", "site_visit", "other"] as const;
type Method = (typeof VERIFICATION_METHODS)[number];
const COMMENT_MAX = 1000;

/** Причина/что исправить: обрезанная, непустая — иначе null (на сервере то же правило). */
export function reasonBody(reason: string): { reason: string } | null {
  const r = reason.trim();
  return r ? { reason: r } : null;
}

/**
 * Ошибка решения для показа: 403/409 — понятный текст экрана, остальное — как есть (ErrorBox).
 * 409 — заявку уже решил другой модератор; 403 — нет права или заявка своей организации (BR-12).
 */
export function ModerationError({ error }: { error: ApiError | null }) {
  const { t } = useT();
  if (!error) return null;
  if (error.status === 409) {
    // «Вже розглянуто» — своє пояснення; інші конфлікти (місце не на модерації) — текст із конверта.
    const decided = error.messageKey === "errors.moderation.alreadyDecided";
    if (!decided && error.messageKey !== "errors.conflict") return <ErrorBox error={error} />;
    return (
      <p role="alert" style={{ color: "#b3261e", margin: 0 }}>
        {decided ? t("admin.moderation.alreadyDecided") : t("errors.conflict")}
      </p>
    );
  }
  if (error.status === 403)
    return (
      <p role="alert" style={{ color: "#b3261e", margin: 0 }}>
        {error.problems?.includes("own_organization")
          ? t("admin.moderation.ownOrganization")
          : t("admin.moderation.forbidden")}
      </p>
    );
  return <ErrorBox error={error} />;
}

function Status({ c }: { c: Case }) {
  const { tDynamic } = useT();
  return (
    <>
      {c.decision
        ? tDynamic(`admin.moderation.decision.${c.decision}`)
        : tDynamic(`admin.moderation.status.${c.status}`)}
    </>
  );
}

export function ModerationScreen({ id }: { id?: string }) {
  return id ? <CaseScreen id={id} /> : <QueueScreen />;
}

function QueueScreen() {
  const { api } = useAdmin();
  const { t, tDynamic, locale } = useT();
  const l = useLocalized();
  const [status, setStatus] = useState<(typeof CASE_STATUSES)[number]>("open");
  const [result] = useLoad(
    () => call(api.GET("/admin/moderation/cases", { params: { query: { status } } })),
    [status],
  );
  return (
    <Stack gap={2}>
      <p style={{ margin: 0 }}>{t("admin.moderation.hint")}</p>
      <div style={row}>
        <SelectField
          label={t("admin.field.status")}
          value={status}
          options={CASE_STATUSES.map((s) => ({ value: s, label: tDynamic(`admin.moderation.status.${s}`) }))}
          onChange={(v) => setStatus(v as (typeof CASE_STATUSES)[number])}
        />
      </div>
      {result && !result.ok && result.error.status === 403 ? (
        <p role="alert">{t("admin.moderation.forbidden")}</p>
      ) : (
        <Loaded result={result}>
          {(data) =>
            data.items.length === 0 ? (
              <p>{t("admin.moderation.empty")}</p>
            ) : (
              <Table
                caption={t("admin.moderation")}
                head={[
                  t("admin.field.name"),
                  t("admin.moderation.organization"),
                  t("admin.moderation.template"),
                  t("admin.moderation.submittedAt"),
                  t("admin.field.status"),
                ]}
              >
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <Link to={`/moderation/${c.id}`}>{l(c.placeName)}</Link>
                      {c.ownOrganization && <strong> · {t("admin.moderation.ownBadge")}</strong>}
                    </Td>
                    <Td>{c.organizationName}</Td>
                    <Td>{c.templateName ? l(c.templateName) : (c.templateCode ?? "—")}</Td>
                    <Td>{formatDate(c.submittedAt, locale)}</Td>
                    <Td>
                      <Status c={c} />
                    </Td>
                  </tr>
                ))}
              </Table>
            )
          }
        </Loaded>
      )}
    </Stack>
  );
}

type Interval = { dayOfWeek: number; opensAt: string; closesAt: string };
type Exception = { date: string; closed: boolean; opensAt: string | null; closesAt: string | null };
type SnapMedia = { mediaAssetId: string; isCover?: boolean; alt?: { uk?: string } | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Ссылка на карту точки (OpenStreetMap); нет корректных координат — null. */
export function mapUrl(location: unknown): string | null {
  if (!isRecord(location)) return null;
  const { lat, lon } = location;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}

/** Превью допускаем только по http(s): снимок — данные партнёра. */
export function safeImageUrl(url: unknown): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

/** Снимок карточки читабельно: поля, точка со ссылкой на карту, график, фото; полный JSON — под спойлером. */
export function SnapshotView({
  snap,
  previews = {},
}: {
  snap: Record<string, unknown>;
  previews?: Record<string, string>;
}) {
  const { t, tDynamic } = useT();
  const l = useLocalized();
  const text = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "—";
    if (isRecord(v) && "uk" in v) return l(v as { uk: string; en?: string });
    return isRecord(v) ? JSON.stringify(v) : String(v);
  };
  const fields: [string, unknown][] = [
    ["admin.field.name", snap.name],
    ["admin.field.description", snap.description],
    ["admin.field.address", snap.address],
    ["admin.moderation.phone", snap.phone],
    ["admin.moderation.website", snap.website],
    ["admin.moderation.telegram", snap.telegram],
  ];
  const map = mapUrl(snap.location);
  const loc = isRecord(snap.location) ? (snap.location as { lat?: number; lon?: number }) : null;
  const schedule = isRecord(snap.schedule) ? snap.schedule : {};
  const weekly = asArray<Interval>(schedule.weekly);
  const exceptions = asArray<Exception>(schedule.exceptions);
  const media = asArray<SnapMedia>(snap.media);
  return (
    <Stack gap={2}>
      <dl style={{ margin: 0 }}>
        {fields.map(([key, v]) => (
          <div key={key}>
            <dt style={{ fontWeight: 600 }}>{tDynamic(key)}</dt>
            <dd style={{ margin: 0 }}>{text(v)}</dd>
          </div>
        ))}
        <div>
          <dt style={{ fontWeight: 600 }}>{t("admin.moderation.location")}</dt>
          <dd style={{ margin: 0 }}>
            {map && loc ? (
              <a href={map} target="_blank" rel="noopener noreferrer">
                {loc.lat}, {loc.lon} · {t("admin.moderation.openMap")}
              </a>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
      <div>
        <p style={{ margin: 0, fontWeight: 600 }}>{t("admin.schedule")}</p>
        {weekly.length === 0 && exceptions.length === 0 ? (
          <p style={{ margin: 0 }}>{t("admin.schedule.closed")}</p>
        ) : (
          <ul style={{ margin: 0 }}>
            {weekly.map((w) => (
              <li key={`${w.dayOfWeek}-${w.opensAt}`}>
                {tDynamic(`miniapp.weekday.${w.dayOfWeek}`)}: {w.opensAt}–{w.closesAt}
              </li>
            ))}
            {exceptions.map((e) => (
              <li key={e.date}>
                {e.date}:{" "}
                {e.closed ? t("admin.moderation.closedDay") : `${e.opensAt ?? ""}–${e.closesAt ?? ""}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p style={{ margin: 0, fontWeight: 600 }}>{t("admin.moderation.photos")}</p>
        {media.length === 0 ? (
          <p style={{ margin: 0 }}>{t("admin.moderation.photosEmpty")}</p>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {media.map((m) => {
              const src = safeImageUrl(previews[m.mediaAssetId]);
              const alt = m.alt?.uk ?? "";
              return (
                <figure key={m.mediaAssetId} style={{ margin: 0, maxWidth: 160 }}>
                  {src ? (
                    <img src={src} alt={alt} width={160} style={{ maxWidth: "100%", height: "auto" }} />
                  ) : (
                    <span>{t("admin.moderation.noPreview")}</span>
                  )}
                  <figcaption style={{ fontSize: 12 }}>
                    {m.isCover ? `${t("admin.moderation.cover")} · ` : ""}
                    {alt || t("admin.moderation.noAlt")}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}
      </div>
      <details>
        <summary>{t("admin.moderation.snapshot")}</summary>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>{JSON.stringify(snap, null, 2)}</pre>
      </details>
    </Stack>
  );
}

/** Возможные дубли заявки: места региона рядом или с похожим названием — со ссылкой в каталог. */
function Duplicates({ items }: { items: Detail["possibleDuplicates"] }) {
  const { t, tDynamic } = useT();
  const l = useLocalized();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="mod-dups" style={{ border: "2px solid #b26a00", borderRadius: 6, padding: 8 }}>
      <Stack gap={1}>
        <h3 id="mod-dups" style={{ margin: 0 }}>
          {t("admin.moderation.duplicates")}
        </h3>
        <p style={{ margin: 0 }}>{t("admin.moderation.duplicatesHint")}</p>
        <ul style={{ margin: 0 }}>
          {items.map((d) => (
            <li key={d.id}>
              <Link to={`/places/${d.id}`}>{l(d.name)}</Link> · {tDynamic(`admin.placeStatus.${d.status}`)} ·{" "}
              {t(d.source === "google" ? "admin.moderation.sourceGoogle" : "admin.moderation.sourceManual")}
              {d.distanceMeters === null
                ? ""
                : ` · ${t("admin.moderation.distance", { m: Math.round(d.distanceMeters) })}`}
            </li>
          ))}
        </ul>
      </Stack>
    </section>
  );
}

type Outcome = { notice: string | null; error: ApiError | null };

function CaseScreen({ id }: { id: string }) {
  const { api } = useAdmin();
  const { t } = useT();
  const [result, reload] = useLoad(
    () => call(api.GET("/admin/moderation/cases/{id}", { params: { path: { id } } })),
    [id],
  );
  // Итог решения живёт здесь: после решения заявка становится decided, форма уходит, а сообщение остаётся.
  const [outcome, setOutcome] = useState<Outcome>({ notice: null, error: null });
  return (
    <Stack gap={3}>
      <p style={{ margin: 0 }}>
        <Link to="/moderation">← {t("admin.moderation")}</Link>
      </p>
      {result && !result.ok && result.error.status === 403 ? (
        <p role="alert">{t("admin.moderation.forbidden")}</p>
      ) : (
        <Loaded result={result}>
          {(c) => (
            <>
              <Notice text={outcome.notice} />
              <ModerationError error={outcome.error} />
              <CaseCard c={c} reload={reload} onOutcome={setOutcome} />
            </>
          )}
        </Loaded>
      )}
    </Stack>
  );
}

function CaseCard({
  c,
  reload,
  onOutcome,
}: {
  c: Detail;
  reload: () => void;
  onOutcome: (o: Outcome) => void;
}) {
  const { t, tDynamic, locale } = useT();
  const l = useLocalized();
  const snap = c.placeSnapshot;
  return (
    <Stack gap={3}>
      <h2 style={{ margin: 0 }}>{l(c.placeName)}</h2>
      {c.ownOrganization && (
        <p role="note" style={{ margin: 0, fontWeight: 600 }}>
          {t("admin.moderation.ownBadge")}: {t("admin.moderation.ownOrganization")}
        </p>
      )}
      <Duplicates items={c.possibleDuplicates} />
      <section aria-labelledby="mod-info">
        <Stack gap={1}>
          <h3 id="mod-info" style={{ margin: 0 }}>
            {t("admin.moderation.data")}
          </h3>
          <p style={{ margin: 0 }}>
            {t("admin.field.status")}: <Status c={c} />
          </p>
          <p style={{ margin: 0 }}>
            {t("admin.moderation.template")}: {c.templateName ? l(c.templateName) : (c.templateCode ?? "—")}
          </p>
          <p style={{ margin: 0 }}>
            {t("admin.moderation.organization")}: {c.organizationName}
          </p>
          <p style={{ margin: 0 }}>
            {t("admin.moderation.submittedBy")}: {c.submittedByName ?? c.submittedBy} ·{" "}
            {formatDate(c.submittedAt, locale)}
          </p>
          {c.partnerNote && (
            <p style={{ margin: 0 }}>
              {t("admin.moderation.partnerNote")}: {c.partnerNote}
            </p>
          )}
          <SnapshotView snap={snap} previews={c.snapshotMediaPreview} />
          <Link to={`/places/${c.placeId}`}>{t("admin.moderation.openPlace")}</Link>
        </Stack>
      </section>

      <section aria-labelledby="mod-owners">
        <Stack gap={1}>
          <h3 id="mod-owners" style={{ margin: 0 }}>
            {t("admin.moderation.owners")}
          </h3>
          {c.owners.length === 0 ? (
            <p style={{ margin: 0 }}>{t("admin.empty")}</p>
          ) : (
            <ul style={{ margin: 0 }}>
              {c.owners.map((o) => (
                <li key={o.userId}>
                  {[o.displayName, o.username ? `@${o.username}` : null].filter(Boolean).join(" · ") ||
                    o.userId}
                </li>
              ))}
            </ul>
          )}
        </Stack>
      </section>

      <section aria-labelledby="mod-history">
        <Stack gap={1}>
          <h3 id="mod-history" style={{ margin: 0 }}>
            {t("admin.moderation.history")}
          </h3>
          {c.history.length === 0 ? (
            <p style={{ margin: 0 }}>{t("admin.moderation.historyEmpty")}</p>
          ) : (
            <Table
              caption={t("admin.moderation.history")}
              head={[
                t("admin.moderation.submittedAt"),
                t("admin.field.status"),
                t("admin.moderation.verification"),
                t("admin.moderation.comment"),
              ]}
            >
              {c.history.map((h) => (
                <tr key={h.id}>
                  <Td>{formatDate(h.submittedAt, locale)}</Td>
                  <Td>
                    <Status c={h} />
                  </Td>
                  <Td>
                    {h.verificationMethod ? tDynamic(`admin.moderation.method.${h.verificationMethod}`) : "—"}
                  </Td>
                  <Td>{h.comment ?? "—"}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Stack>
      </section>

      {c.status === "decided" ? (
        <section aria-labelledby="mod-decided">
          <Stack gap={1}>
            <h3 id="mod-decided" style={{ margin: 0 }}>
              {t("admin.moderation.decided")}
            </h3>
            <p style={{ margin: 0 }}>
              <Status c={c} />
              {c.decidedByName ? ` · ${c.decidedByName}` : ""}
              {c.decidedAt ? ` · ${formatDate(c.decidedAt, locale)}` : ""}
            </p>
            {c.verificationMethod && (
              <p style={{ margin: 0 }}>
                {t("admin.moderation.verification")}:{" "}
                {tDynamic(`admin.moderation.method.${c.verificationMethod}`)}
              </p>
            )}
            {c.comment && (
              <p style={{ margin: 0 }}>
                {t("admin.moderation.comment")}: {c.comment}
              </p>
            )}
          </Stack>
        </section>
      ) : c.ownOrganization ? null : (
        <Decisions c={c} reload={reload} onOutcome={onOutcome} />
      )}
    </Stack>
  );
}

function Decisions({
  c,
  reload,
  onOutcome,
}: {
  c: Detail;
  reload: () => void;
  onOutcome: (o: Outcome) => void;
}) {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const [method, setMethod] = useState<Method | "">("");
  const [comment, setComment] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [local, setLocal] = useState<{ form: string; text: string } | null>(null);
  // Одно решение за раз на все три формы (двойной клик, Enter, соседняя форма).
  const [busy, act] = useBusy();
  const path = { params: { path: { id: c.id } } };

  // 409 «уже решено» — перечитываем заявку: экран покажет решение другого модератора.
  const done = (ok: boolean, err: ApiError | null, message: string) => {
    if (ok) onOutcome({ notice: message, error: null });
    else onOutcome({ notice: null, error: err });
    if (ok || err?.status === 409) reload();
  };

  const approve = async () => {
    if (!method) return setLocal({ form: "approve", text: t("admin.moderation.methodRequired") });
    setLocal(null);
    const body = { verificationMethod: method, ...(comment.trim() && { comment: comment.trim() }) };
    const res = await call(api.POST("/admin/moderation/cases/{id}/approve", { ...path, body }));
    done(res.ok, res.ok ? null : res.error, t("admin.moderation.approved"));
  };
  const decide = (kind: "return" | "reject", reason: string) => async () => {
    const body = reasonBody(reason);
    if (!body) return setLocal({ form: kind, text: t("admin.moderation.reasonRequired") });
    setLocal(null);
    const res = await call(
      kind === "return"
        ? api.POST("/admin/moderation/cases/{id}/return", { ...path, body })
        : api.POST("/admin/moderation/cases/{id}/reject", { ...path, body }),
    );
    done(
      res.ok,
      res.ok ? null : res.error,
      t(kind === "return" ? "admin.moderation.returned" : "admin.moderation.rejected"),
    );
  };

  return (
    <section aria-labelledby="mod-decision">
      <Stack gap={3}>
        <h3 id="mod-decision" style={{ margin: 0 }}>
          {t("admin.moderation.decision")}
        </h3>
        {c.publishProblems.length > 0 && (
          <div role="note">
            <p style={{ margin: 0 }}>{t("admin.moderation.problems")}</p>
            <ul style={{ margin: 0 }}>
              {c.publishProblems.map((p) => (
                <li key={p}>{tDynamic(`admin.problem.${p}`)}</li>
              ))}
            </ul>
          </div>
        )}
        <Form
          label={t("admin.moderation.approve")}
          submitLabel={t("admin.moderation.approve")}
          busy={busy}
          onSubmit={() => act(approve)}
        >
          <SelectField
            label={t("admin.moderation.verification")}
            value={method}
            empty={t("admin.moderation.methodChoose")}
            options={VERIFICATION_METHODS.map((m) => ({
              value: m,
              label: tDynamic(`admin.moderation.method.${m}`),
            }))}
            onChange={(v) => setMethod(v as Method | "")}
          />
          <Field
            label={t("admin.moderation.comment")}
            value={comment}
            multiline
            maxLength={COMMENT_MAX}
            onChange={setComment}
          />
          {local?.form === "approve" && <p role="alert">{local.text}</p>}
        </Form>
        <Form
          label={t("admin.moderation.return")}
          submitLabel={t("admin.moderation.return")}
          busy={busy}
          onSubmit={() => act(decide("return", returnReason))}
        >
          <Field
            label={t("admin.moderation.returnReason")}
            value={returnReason}
            multiline
            maxLength={COMMENT_MAX}
            onChange={setReturnReason}
          />
          {local?.form === "return" && <p role="alert">{local.text}</p>}
        </Form>
        <Form
          label={t("admin.moderation.reject")}
          submitLabel={t("admin.moderation.reject")}
          busy={busy}
          onSubmit={() => act(decide("reject", rejectReason))}
        >
          <Field
            label={t("admin.moderation.rejectReason")}
            value={rejectReason}
            multiline
            maxLength={COMMENT_MAX}
            onChange={setRejectReason}
          />
          {local?.form === "reject" && <p role="alert">{local.text}</p>}
        </Form>
        <div>
          <SmallButton type="button" onClick={reload}>
            {t("admin.moderation.refresh")}
          </SmallButton>
        </div>
      </Stack>
    </section>
  );
}
