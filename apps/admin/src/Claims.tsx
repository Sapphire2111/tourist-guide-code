// AD02 «Заявки на заклад» (0031): «Це мій заклад» — пользователь заявляет место каталога (обычно Google). Модератор
// звонит на номер места из Google, сверяет заявителя и решает: схвалити (место → организация заявителя) / відхилити.
import { useState } from "react";
import { Link, Stack, useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import { formatDate } from "./dates.js";
import { ModerationError, reasonBody } from "./Moderation.js";
import {
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
  useBusy,
  useLoad,
  useLocalized,
} from "./ui.js";

type Summary = ApiSchemas["PlaceClaimSummaryDto"];
type Detail = ApiSchemas["PlaceClaimDetailDto"];
export const CLAIM_FILTERS = ["pending", "decided"] as const;
type Filter = (typeof CLAIM_FILTERS)[number];
const COMMENT_MAX = 1000;
type Outcome = { notice: string | null; error: ApiError | null };

/** Внешняя ссылка — только http(s) (javascript:/data: не попадут в href). */
export function safeHref(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

/** Ссылка звонка: только цифры и ведущий «+». */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const clean = phone.replace(/[^\d+]/g, "");
  return /^\+?\d{6,15}$/.test(clean) ? `tel:${clean}` : null;
}

function State({ c }: { c: Summary }) {
  const { tDynamic } = useT();
  return <>{tDynamic(`admin.claims.state.${c.status}`)}</>;
}

function OrgName({ c }: { c: Summary }) {
  const { t } = useT();
  return (
    <>
      {c.newOrganization && c.status !== "approved"
        ? t("admin.claims.newOrg", { name: c.organizationName })
        : c.organizationName}
    </>
  );
}

function Claimant({ c }: { c: Summary }) {
  return (
    <>
      {[c.claimantName, c.claimantUsername ? `@${c.claimantUsername}` : null].filter(Boolean).join(" · ") ||
        c.userId}
    </>
  );
}

export function ClaimsScreen({ id }: { id?: string }) {
  return id ? <ClaimScreen key={id} id={id} /> : <ClaimsQueue />;
}

function ClaimsQueue() {
  const { api } = useAdmin();
  const { t, tDynamic, locale } = useT();
  const l = useLocalized();
  const [status, setStatus] = useState<Filter>("pending");
  const [result] = useLoad(
    () => call(api.GET("/admin/moderation/claims", { params: { query: { status } } })),
    [status],
  );
  return (
    <Stack gap={2}>
      <p style={{ margin: 0 }}>{t("admin.claims.hint")}</p>
      <div style={row}>
        <SelectField
          label={t("admin.field.status")}
          value={status}
          options={CLAIM_FILTERS.map((s) => ({ value: s, label: tDynamic(`admin.claims.filter.${s}`) }))}
          onChange={(v) => setStatus(v as Filter)}
        />
      </div>
      {result && !result.ok && result.error.status === 403 ? (
        <p role="alert">{t("admin.moderation.forbidden")}</p>
      ) : (
        <Loaded result={result}>
          {(data) =>
            data.items.length === 0 ? (
              <p>{t("admin.claims.empty")}</p>
            ) : (
              <Table
                caption={t("admin.moderation.tab.claims")}
                head={[
                  t("admin.claims.place"),
                  t("admin.claims.claimant"),
                  t("admin.claims.organization"),
                  t("admin.claims.createdAt"),
                  t("admin.field.status"),
                ]}
              >
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <Link to={`/moderation/claims/${c.id}`}>{l(c.placeName)}</Link>
                      {c.own && <strong> · {t("admin.moderation.ownBadge")}</strong>}
                    </Td>
                    <Td>
                      <Claimant c={c} />
                    </Td>
                    <Td>
                      <OrgName c={c} />
                    </Td>
                    <Td>{formatDate(c.createdAt, locale)}</Td>
                    <Td>
                      <State c={c} />
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

function ClaimScreen({ id }: { id: string }) {
  const { api } = useAdmin();
  const { t } = useT();
  const [result, reload] = useLoad(
    () => call(api.GET("/admin/moderation/claims/{id}", { params: { path: { id } } })),
    [id],
  );
  const [outcome, setOutcome] = useState<Outcome>({ notice: null, error: null });
  return (
    <Stack gap={3}>
      <p style={{ margin: 0 }}>
        <Link to="/moderation/claims">← {t("admin.moderation.tab.claims")}</Link>
      </p>
      {result && !result.ok && result.error.status === 403 ? (
        <p role="alert">{t("admin.moderation.forbidden")}</p>
      ) : (
        <Loaded result={result}>
          {(c) => (
            <>
              <Notice text={outcome.notice} />
              <ModerationError error={outcome.error} />
              <ClaimCard c={c} reload={reload} onOutcome={setOutcome} />
            </>
          )}
        </Loaded>
      )}
    </Stack>
  );
}

function ClaimCard({
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
  const p = c.place;
  const placeTel = telHref(p.phone);
  const claimantTel = telHref(c.phone);
  const maps = safeHref(p.googleMapsUri);
  const site = safeHref(p.website);
  return (
    <Stack gap={3}>
      <h2 style={{ margin: 0 }}>{l(c.placeName)}</h2>
      {c.own && (
        <p role="note" style={{ margin: 0, fontWeight: 600 }}>
          {t("admin.claims.own")}
        </p>
      )}
      <section aria-labelledby="claim-place">
        <Stack gap={1}>
          <h3 id="claim-place" style={{ margin: 0 }}>
            {t("admin.claims.placeInfo")} · {tDynamic(`admin.claims.source.${p.source}`)}
          </h3>
          {p.organizationName && (
            <p role="alert" style={{ margin: 0 }}>
              {t("admin.claims.alreadyClaimed", { name: p.organizationName })}
            </p>
          )}
          <p style={{ margin: 0 }}>
            {t("admin.claims.placePhone")}:{" "}
            {placeTel ? <a href={placeTel}>{p.phone}</a> : t("admin.claims.none")}
          </p>
          <p style={{ margin: 0 }}>
            {t("admin.claims.placeWebsite")}:{" "}
            {site ? (
              <a href={site} target="_blank" rel="noopener noreferrer">
                {p.website}
              </a>
            ) : (
              t("admin.claims.none")
            )}
          </p>
          {p.address && (
            <p style={{ margin: 0 }}>
              {t("admin.claims.address")}: {p.address}
            </p>
          )}
          {p.category && (
            <p style={{ margin: 0 }}>
              {t("admin.claims.category")}: {p.category}
            </p>
          )}
          {maps && (
            <a href={maps} target="_blank" rel="noopener noreferrer">
              {t("admin.claims.googleMaps")}
            </a>
          )}
          <Link to={`/places/${p.id}`}>{t("admin.claims.openPlace")}</Link>
        </Stack>
      </section>

      <section aria-labelledby="claim-claimant">
        <Stack gap={1}>
          <h3 id="claim-claimant" style={{ margin: 0 }}>
            {t("admin.claims.claimant")}
          </h3>
          <p style={{ margin: 0 }}>
            <Claimant c={c} />
          </p>
          <p style={{ margin: 0 }}>
            {t("admin.claims.claimantPhone")}:{" "}
            {c.phone === null ? (
              t("admin.claims.phonePurged")
            ) : (
              <>
                {claimantTel ? <a href={claimantTel}>{c.phone}</a> : c.phone} (
                {tDynamic(`admin.claims.phoneSource.${c.phoneSource}`)})
              </>
            )}
          </p>
          <p style={{ margin: 0 }}>
            {t("admin.claims.role")}: {tDynamic(`admin.claims.role.${c.role}`)}
          </p>
          <p style={{ margin: 0 }}>
            {t("admin.claims.organization")}: <OrgName c={c} />
          </p>
          <p style={{ margin: 0 }}>
            {t("admin.claims.createdAt")}: {formatDate(c.createdAt, locale)}
          </p>
          {c.comment && (
            <p style={{ margin: 0, whiteSpace: "pre-line" }}>
              {t("admin.claims.comment")}: {c.comment}
            </p>
          )}
        </Stack>
      </section>

      {c.otherClaims.length > 0 && (
        <section aria-labelledby="claim-others">
          <Stack gap={1}>
            <h3 id="claim-others" style={{ margin: 0 }}>
              {t("admin.claims.others")}
            </h3>
            {c.status === "pending" && c.otherClaims.some((o) => o.status === "pending") && (
              <p role="note" style={{ margin: 0 }}>
                {t("admin.claims.othersHint")}
              </p>
            )}
            <Table
              caption={t("admin.claims.others")}
              head={[
                t("admin.claims.claimant"),
                t("admin.claims.organization"),
                t("admin.claims.createdAt"),
                t("admin.field.status"),
              ]}
            >
              {c.otherClaims.map((o) => (
                <tr key={o.id}>
                  <Td>
                    <Link to={`/moderation/claims/${o.id}`}>
                      <Claimant c={o} />
                    </Link>
                  </Td>
                  <Td>
                    <OrgName c={o} />
                  </Td>
                  <Td>{formatDate(o.createdAt, locale)}</Td>
                  <Td>
                    <State c={o} />
                  </Td>
                </tr>
              ))}
            </Table>
          </Stack>
        </section>
      )}

      {c.status !== "pending" ? (
        <section aria-labelledby="claim-decided">
          <Stack gap={1}>
            <h3 id="claim-decided" style={{ margin: 0 }}>
              {t("admin.claims.decided")}
            </h3>
            <p style={{ margin: 0 }}>
              <State c={c} />
              {c.decidedByName ? ` · ${c.decidedByName}` : ""}
              {c.decidedAt ? ` · ${formatDate(c.decidedAt, locale)}` : ""}
            </p>
            {c.decisionComment && (
              <p style={{ margin: 0 }}>
                {t("admin.claims.decisionComment")}: {c.decisionComment}
              </p>
            )}
            {c.revokeReason && (
              <p style={{ margin: 0 }}>
                {t("admin.claims.revokedReason")}: {c.revokeReason}
              </p>
            )}
            {c.status === "approved" && !c.own && <Revoke c={c} reload={reload} onOutcome={onOutcome} />}
          </Stack>
        </section>
      ) : c.own ? null : (
        <Decisions c={c} reload={reload} onOutcome={onOutcome} />
      )}
    </Stack>
  );
}

/** Отмена ошибочного одобрения: причина обязательна, подтверждение перед запросом. */
function Revoke({
  c,
  reload,
  onOutcome,
}: {
  c: Detail;
  reload: () => void;
  onOutcome: (o: Outcome) => void;
}) {
  const { api } = useAdmin();
  const { t } = useT();
  const [reason, setReason] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const [busy, act] = useBusy();
  const revoke = async () => {
    const body = reasonBody(reason);
    if (!body) return setLocal(t("admin.moderation.reasonRequired"));
    setLocal(null);
    if (!window.confirm(t("admin.claims.revokeConfirm", { name: c.organizationName }))) return;
    const res = await call(
      api.POST("/admin/moderation/claims/{id}/revoke", { params: { path: { id: c.id } }, body }),
    );
    onOutcome(
      res.ok ? { notice: t("admin.claims.revoked"), error: null } : { notice: null, error: res.error },
    );
    if (res.ok || res.error.status === 409) reload();
  };
  return (
    <Form
      label={t("admin.claims.revoke")}
      submitLabel={t("admin.claims.revoke")}
      busy={busy}
      onSubmit={() => act(revoke)}
    >
      <p style={{ margin: 0 }}>{t("admin.claims.revokeHint")}</p>
      <Field
        label={t("admin.claims.revokeReason")}
        value={reason}
        multiline
        maxLength={COMMENT_MAX}
        onChange={setReason}
      />
      {local && <p role="alert">{local}</p>}
    </Form>
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
  const { t } = useT();
  const [comment, setComment] = useState("");
  const [reason, setReason] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  // Одно решение за раз на обе формы.
  const [busy, act] = useBusy();
  const path = { params: { path: { id: c.id } } };
  const done = (ok: boolean, err: ApiError | null, message: string) => {
    onOutcome(ok ? { notice: message, error: null } : { notice: null, error: err });
    if (ok || err?.status === 409) reload();
  };
  const approve = async () => {
    const body = comment.trim() ? { comment: comment.trim() } : {};
    const res = await call(api.POST("/admin/moderation/claims/{id}/approve", { ...path, body }));
    done(res.ok, res.ok ? null : res.error, t("admin.claims.approved"));
  };
  const reject = async () => {
    const body = reasonBody(reason);
    if (!body) return setLocal(t("admin.moderation.reasonRequired"));
    setLocal(null);
    const res = await call(api.POST("/admin/moderation/claims/{id}/reject", { ...path, body }));
    done(res.ok, res.ok ? null : res.error, t("admin.claims.rejected"));
  };
  return (
    <section aria-labelledby="claim-decision">
      <Stack gap={3}>
        <h3 id="claim-decision" style={{ margin: 0 }}>
          {t("admin.claims.decision")}
        </h3>
        <Form
          label={t("admin.claims.approve")}
          submitLabel={t("admin.claims.approve")}
          busy={busy}
          onSubmit={() => act(approve)}
        >
          <Field
            label={t("admin.claims.approveComment")}
            value={comment}
            multiline
            maxLength={COMMENT_MAX}
            onChange={setComment}
          />
        </Form>
        <Form
          label={t("admin.claims.reject")}
          submitLabel={t("admin.claims.reject")}
          busy={busy}
          onSubmit={() => act(reject)}
        >
          <Field
            label={t("admin.claims.rejectReason")}
            value={reason}
            multiline
            maxLength={COMMENT_MAX}
            onChange={setReason}
          />
          {local && <p role="alert">{local}</p>}
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
