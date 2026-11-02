// P14 принятие приглашения (S-06): start_param inv_<токен> → GET /partner/invites/:token → «Прийняти» →
// POST …/accept → кабинет (P13/P01). PIN кассира не задаём (D-52 отложено).
import { useState } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Button, Stack, useRoute, useT } from "@tg/ui";
import { useAsync } from "../guide/context.js";
import { NotFoundError } from "../guide/types.js";
import { useErrorText } from "../host/errors.js";
import { ConflictError } from "../host/types.js";
import { usePartner } from "./context.js";
import { INVITE_TOKEN_RE } from "./partner-api.js";
import { Live, roleKey, type Message } from "./parts.js";

const STATE_KEYS: Record<string, MessageKey> = {
  accepted: "errors.staffInvite.used",
  expired: "errors.staffInvite.expired",
  revoked: "errors.staffInvite.revoked",
};

export function AcceptInvite({ token }: { token: string }) {
  const { t, locale } = useT();
  const [, navigate] = useRoute();
  const { api, enabled, reloadMe, select } = usePartner();
  const errorText = useErrorText();
  const valid = INVITE_TOKEN_RE.test(token);
  const [preview, retry] = useAsync(
    () => (enabled && valid ? api.invitePreview(token) : Promise.reject(new NotFoundError())),
    [api, token, enabled, valid],
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  if (!enabled) return <p role="alert">{t("miniapp.partner.needsLogin")}</p>;
  const accept = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.acceptInvite(token);
      select({ orgId: res.organizationId, placeId: null });
      reloadMe();
      setMessage({ text: t("miniapp.partner.invite.accepted"), alert: false });
      navigate("/partner", { replace: true });
    } catch (err) {
      setMessage({ text: errorText(err, "miniapp.partner.invite.error"), alert: true });
      setBusy(false);
      if (err instanceof ConflictError) {
        // Уже принято (возможно, нами в другой вкладке) или уже сотрудник: назначения могли появиться.
        reloadMe();
        if (err.messageKey === "errors.staffInvite.alreadyMember") navigate("/partner", { replace: true });
      }
    }
  };
  return (
    <Stack>
      <h1>{t("miniapp.partner.invite.title")}</h1>
      {preview.status === "loading" && (
        <p role="status" className="kosiv-muted">
          {t("miniapp.guide.loading")}
        </p>
      )}
      {preview.status === "error" &&
        (preview.error instanceof NotFoundError ? (
          <p role="alert" data-testid="invite-error">
            {t("miniapp.partner.invite.notFound")}
          </p>
        ) : (
          <>
            <p role="alert" data-testid="invite-error">
              {errorText(preview.error, "miniapp.partner.loadError")}
            </p>
            <Button onClick={retry}>{t("miniapp.guide.retry")}</Button>
          </>
        ))}
      {preview.status === "ready" && (
        <div className="kosiv-card kosiv-panel" data-testid="invite-preview">
          <p>
            {t("miniapp.partner.invite.text", {
              role: t(roleKey(preview.data.role)),
              org: preview.data.organizationName,
            })}
          </p>
          {preview.data.placeNames.length > 0 && (
            <p>
              {t("miniapp.partner.invite.places", {
                places: preview.data.placeNames.map((n) => pickLocalized(n, locale)).join(", "),
              })}
            </p>
          )}
          {preview.data.alreadyMember ? (
            <p role="alert">{t("errors.staffInvite.alreadyMember")}</p>
          ) : preview.data.state !== "active" ? (
            <p role="alert">{t(STATE_KEYS[preview.data.state] ?? "miniapp.partner.invite.error")}</p>
          ) : (
            <Button onClick={() => void accept()} disabled={busy}>
              {t("miniapp.partner.invite.accept")}
            </Button>
          )}
          <Live message={message} testId="invite-message" />
        </div>
      )}
      {/* replace: «Назад» из кабинета не возвращает на использованное приглашение */}
      <a
        href="#/partner"
        onClick={(e) => {
          e.preventDefault();
          navigate("/partner", { replace: true });
        }}
      >
        {t("miniapp.partner.toDashboard")}
      </a>
    </Stack>
  );
}
