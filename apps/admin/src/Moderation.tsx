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
  if (error.status === 409)
    return (
      <p role="alert" style={{ color: "#b3261e", margin: 0 }}>
        {t("admin.moderation.alreadyDecided")}
      </p>
    );
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
                    </Td>
                    <Td>{c.organizationName}</Td>
                    <Td>{c.templateCode ?? "—"}</Td>
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

/** Поле снимка карточки: мультиязычный текст → строка на языке интерфейса, число/строка — как есть. */
function snapshotText(v: unknown, pick: (x: { uk: string; en?: string }) => string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object" && "uk" in v) return pick(v as { uk: string; en?: string });
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function CaseScreen({ id }: { id: string }) {
  const { api } = useAdmin();
  const { t } = useT();
  const [result, reload] = useLoad(
    () => call(api.GET("/admin/moderation/cases/{id}", { params: { path: { id } } })),
    [id],
  );
  return (
    <Stack gap={3}>
      <p style={{ margin: 0 }}>
        <Link to="/moderation">← {t("admin.moderation")}</Link>
      </p>
      {result && !result.ok && result.error.status === 403 ? (
        <p role="alert">{t("admin.moderation.forbidden")}</p>
      ) : (
        <Loaded result={result}>{(c) => <CaseCard c={c} reload={reload} />}</Loaded>
      )}
    </Stack>
  );
}

function CaseCard({ c, reload }: { c: Detail; reload: () => void }) {
  const { t, tDynamic, locale } = useT();
  const l = useLocalized();
  const snap = c.placeSnapshot;
  const fields: [string, unknown][] = [
    ["admin.field.name", snap.name],
    ["admin.field.description", snap.description],
    ["admin.field.address", snap.address],
  ];
  return (
    <Stack gap={3}>
      <h2 style={{ margin: 0 }}>{l(c.placeName)}</h2>
      <section aria-labelledby="mod-info">
        <Stack gap={1}>
          <h3 id="mod-info" style={{ margin: 0 }}>
            {t("admin.moderation.data")}
          </h3>
          <p style={{ margin: 0 }}>
            {t("admin.field.status")}: <Status c={c} />
          </p>
          <p style={{ margin: 0 }}>
            {t("admin.moderation.template")}: {c.templateCode ?? "—"}
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
          <dl style={{ margin: 0 }}>
            {fields.map(([key, v]) => (
              <div key={key}>
                <dt style={{ fontWeight: 600 }}>{tDynamic(key)}</dt>
                <dd style={{ margin: 0 }}>{snapshotText(v, l)}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary>{t("admin.moderation.snapshot")}</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
              {JSON.stringify(snap, null, 2)}
            </pre>
          </details>
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
      ) : (
        <Decisions c={c} reload={reload} />
      )}
    </Stack>
  );
}

function Decisions({ c, reload }: { c: Detail; reload: () => void }) {
  const { api } = useAdmin();
  const { t, tDynamic } = useT();
  const [method, setMethod] = useState<Method | "">("");
  const [comment, setComment] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [local, setLocal] = useState<{ form: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const path = { params: { path: { id: c.id } } };

  // 409 «уже решено» — перечитываем заявку: экран покажет решение другого модератора.
  const done = (ok: boolean, err: ApiError | null, message: string) => {
    if (ok) {
      setError(null);
      setNotice(message);
      return reload();
    }
    setError(err);
    if (err?.status === 409) reload();
  };

  const approve = async () => {
    setNotice(null);
    if (!method) return setLocal({ form: "approve", text: t("admin.moderation.methodRequired") });
    setLocal(null);
    const body = { verificationMethod: method, ...(comment.trim() && { comment: comment.trim() }) };
    const res = await call(api.POST("/admin/moderation/cases/{id}/approve", { ...path, body }));
    done(res.ok, res.ok ? null : res.error, t("admin.moderation.approved"));
  };
  const decide = (kind: "return" | "reject", reason: string) => async () => {
    setNotice(null);
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
        <ModerationError error={error} />
        <Form
          label={t("admin.moderation.approve")}
          submitLabel={t("admin.moderation.approve")}
          onSubmit={approve}
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
          onSubmit={decide("return", returnReason)}
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
          onSubmit={decide("reject", rejectReason)}
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
        <Notice text={notice} />
        <div>
          <SmallButton type="button" onClick={reload}>
            {t("admin.moderation.refresh")}
          </SmallButton>
        </div>
      </Stack>
    </section>
  );
}
