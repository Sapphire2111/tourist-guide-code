// P09 сотрудники организации (только abilities.manageStaff — ORG_OWNER): список, смена роли, деактивация,
// приглашения (ссылка t.me/<бот>?startapp=inv_<токен> показывается один раз, с копированием) и их отзыв.
import { useId, useState } from "react";
import type { MessageKey } from "@tg/i18n";
import { Button, Link, Stack, useT } from "@tg/ui";
import { AsyncView, Badge, card, listStyle } from "../guide/parts.js";
import { useLiveAsync } from "../host/context.js";
import { useErrorText } from "../host/errors.js";
import { formatDateTime } from "../host/format.js";
import { usePartner, usePartnerOrgs } from "./context.js";
import type { StaffInviteCreated, StaffInviteRole } from "./partner-api.js";
import { Live, roleKey, type Message } from "./parts.js";

const INVITE_ROLES: readonly StaffInviteRole[] = ["ORG_MANAGER", "ORG_STAFF"];

function InviteLink({ created }: { created: StaffInviteCreated }) {
  const { t } = useT();
  const [copied, setCopied] = useState<Message>(null);
  const value = created.link ?? created.startParam;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied({ text: t("miniapp.partner.staff.copied"), alert: false });
    } catch {
      setCopied({ text: t("miniapp.partner.staff.copyFailed"), alert: true });
    }
  };
  return (
    <div className="kosiv-panel" data-testid="invite-created">
      <p>
        {created.link
          ? t("miniapp.partner.staff.inviteLink")
          : t("miniapp.partner.staff.inviteCode", { code: created.startParam })}
      </p>
      <code data-testid="invite-link" style={{ wordBreak: "break-all", userSelect: "all" }}>
        {value}
      </code>
      <Button onClick={() => void copy()}>{t("miniapp.partner.staff.copy")}</Button>
      <Live message={copied} testId="invite-copy" />
    </div>
  );
}

export function PartnerStaff({ orgId }: { orgId: string }) {
  const { t, locale } = useT();
  const { api, enabled, me } = usePartner();
  const orgs = usePartnerOrgs();
  const errorText = useErrorText();
  const org = orgs.find((o) => o.id === orgId) ?? null;
  const allowed = org?.abilities.manageStaff === true;
  const [list, reload] = useLiveAsync(
    () => (enabled && allowed ? api.staff(orgId) : Promise.resolve({ members: [], invites: [] })),
    [api, orgId, enabled, allowed],
  );
  const [role, setRole] = useState<StaffInviteRole>("ORG_STAFF");
  const [created, setCreated] = useState<StaffInviteCreated | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const roleGroup = useId();
  if (!enabled) return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;
  if (me.status === "loading")
    return (
      <p role="status" className="kosiv-muted">
        {t("miniapp.guide.loading")}
      </p>
    );
  const run = async (action: () => Promise<unknown>, done: MessageKey | null) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      if (done) setMessage({ text: t(done), alert: false });
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.staff.error"), alert: true });
    } finally {
      setBusy(false);
      setConfirm(null);
      reload();
    }
  };
  const invite = () => run(async () => setCreated(await api.invite(orgId, role)), null);
  return (
    <Stack>
      <h1>{t("miniapp.partner.staff.title")}</h1>
      <Link to="/partner">{t("miniapp.partner.toDashboard")}</Link>
      {!allowed ? (
        <p role="alert">{t("miniapp.partner.staff.forbidden")}</p>
      ) : (
        <>
          {org && <p>{org.name}</p>}
          <Live message={message} testId="staff-message" />
          <AsyncView state={list} retry={reload} errorText={t("miniapp.partner.loadError")}>
            {({ members, invites }) => (
              <>
                <ul style={listStyle} data-testid="staff-members">
                  {members.map((m) => {
                    const name =
                      m.displayName ?? (m.username ? `@${m.username}` : t("miniapp.partner.staff.noName"));
                    const editable = !m.isMe && m.role !== "ORG_OWNER";
                    return (
                      <li key={m.assignmentId} style={card} data-testid="staff-member">
                        <strong>{name}</strong>
                        {m.isMe && <small> ({t("miniapp.partner.staff.me")})</small>}
                        <span style={{ display: "block" }}>
                          <Badge>{t(roleKey(m.role))}</Badge>
                        </span>
                        {editable && (
                          <Stack>
                            <label>
                              {t("miniapp.partner.staff.roleOf", { name })}
                              <select
                                value={m.role}
                                disabled={busy}
                                onChange={(e) =>
                                  void run(
                                    () =>
                                      api.changeRole(
                                        orgId,
                                        m.assignmentId,
                                        e.target.value as StaffInviteRole,
                                      ),
                                    "miniapp.partner.staff.roleChanged",
                                  )
                                }
                              >
                                {INVITE_ROLES.map((r) => (
                                  <option key={r} value={r}>
                                    {t(roleKey(r))}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {confirm === m.assignmentId ? (
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void run(
                                    () => api.deactivate(orgId, m.assignmentId),
                                    "miniapp.partner.staff.deactivated",
                                  )
                                }
                              >
                                {t("miniapp.partner.staff.deactivateConfirm")}
                              </Button>
                            ) : (
                              <Button onClick={() => setConfirm(m.assignmentId)}>
                                {t("miniapp.partner.staff.deactivate", { name })}
                              </Button>
                            )}
                          </Stack>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <h2>{t("miniapp.partner.staff.invites")}</h2>
                {!invites.length && <p>{t("miniapp.partner.staff.invitesEmpty")}</p>}
                <ul style={listStyle} data-testid="staff-invites">
                  {invites.map((i) => (
                    <li key={i.id} style={card} data-testid="staff-invite">
                      <Badge>{t(roleKey(i.role))}</Badge>{" "}
                      <Badge testId="invite-state">
                        {t(`miniapp.partner.staff.state.${i.state}` as MessageKey)}
                      </Badge>
                      {i.state === "active" && (
                        <small style={{ display: "block" }}>
                          {t("miniapp.partner.staff.expires", { date: formatDateTime(i.expiresAt, locale) })}
                        </small>
                      )}
                      {i.acceptedByName && (
                        <small style={{ display: "block" }}>
                          {t("miniapp.partner.staff.acceptedBy", { name: i.acceptedByName })}
                        </small>
                      )}
                      {i.state === "active" && (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void run(() => api.revokeInvite(orgId, i.id), "miniapp.partner.staff.revoked")
                          }
                        >
                          {t("miniapp.partner.staff.revoke")}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </AsyncView>
          <section style={card} aria-labelledby={`${roleGroup}-t`}>
            <h2 id={`${roleGroup}-t`}>{t("miniapp.partner.staff.invite")}</h2>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>{t("miniapp.partner.staff.inviteRole")}</legend>
              {INVITE_ROLES.map((r) => (
                <label key={r} style={{ display: "block" }}>
                  <input type="radio" name={roleGroup} checked={role === r} onChange={() => setRole(r)} />{" "}
                  {t(roleKey(r))}
                </label>
              ))}
            </fieldset>
            <Button onClick={() => void invite()} disabled={busy}>
              {t("miniapp.partner.staff.invite")}
            </Button>
            {created && <InviteLink created={created} />}
          </section>
        </>
      )}
    </Stack>
  );
}
