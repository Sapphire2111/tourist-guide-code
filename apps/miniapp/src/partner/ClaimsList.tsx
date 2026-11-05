// Заявки «Це мій заклад» (0031) в кабинете партнёра (P01): «Заявка на розгляді», затем «Схвалено» / «Відхилено» с
// комментарием модератора. Список — GET /partner/claims региона входа; пусто — блока нет.
import type { MessageKey } from "@tg/i18n";
import { pickLocalized } from "@tg/i18n";
import { useState } from "react";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync } from "../guide/context.js";
import { Badge, listStyle } from "../guide/parts.js";
import { usePartner } from "./context.js";
import type { PlaceClaim, PlaceClaimStatus } from "./partner-api.js";
import { Live, type Message } from "./parts.js";

export const claimStatusKey = (s: PlaceClaimStatus) => `miniapp.claim.status.${s}` as MessageKey;

/** Статус заявки и комментарий модератора (после решения). */
export function ClaimStatus({ claim }: { claim: PlaceClaim }) {
  const { t } = useT();
  return (
    <>
      <span style={{ display: "flex", gap: 6, margin: "4px 0" }}>
        <Badge testId="claim-status" tone={claim.status === "approved" ? "accent" : "outline"}>
          {t(claimStatusKey(claim.status))}
        </Badge>
      </span>
      {claim.status === "revoked" && claim.revokeReason ? (
        <p data-testid="claim-comment" className="partner-status-quote">
          {t("miniapp.claim.moderatorComment", { comment: claim.revokeReason })}
        </p>
      ) : null}
      {claim.status !== "revoked" && claim.decisionComment && (
        <p data-testid="claim-comment" className="partner-status-quote">
          {t("miniapp.claim.moderatorComment", { comment: claim.decisionComment })}
        </p>
      )}
    </>
  );
}

/**
 * Мои заявки на заклады (на рассмотрении и решённые за последние 30 дней — фильтр сервера); заявку на рассмотрении
 * можно отозвать (с подтверждением). Ошибка загрузки — короткое сообщение (кабинет работает и без списка).
 */
export function MyClaims() {
  const { t, locale } = useT();
  const { api, regionId, enabled } = usePartner();
  const [state, reload] = useAsync(
    () => (enabled && regionId ? api.claims(regionId) : Promise.resolve([] as PlaceClaim[])),
    [api, regionId, enabled],
  );
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const withdraw = async (id: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.withdrawClaim(id);
      setConfirming(null);
      setMessage({ text: t("miniapp.claim.withdrawn"), alert: false });
      reload();
    } catch {
      setMessage({ text: t("miniapp.claim.withdrawError"), alert: true });
    } finally {
      setBusy(false);
    }
  };
  if (state.status === "loading") return null;
  if (state.status === "error")
    return (
      <p className="kosiv-muted" data-testid="claims-error">
        {t("miniapp.claim.loadError")}
      </p>
    );
  if (state.data.length === 0) return null;
  return (
    <section aria-labelledby="my-claims" data-testid="my-claims">
      <Stack>
        <h2 id="my-claims" style={{ margin: 0 }}>
          {t("miniapp.claim.list")}
        </h2>
        <ul style={listStyle}>
          {state.data.map((c) => (
            <li key={c.id} className="partner-status" data-testid="my-claim">
              <strong>{pickLocalized(c.placeName, locale)}</strong>
              <ClaimStatus claim={c} />
              {c.status === "pending" &&
                (confirming === c.id ? (
                  <div role="group" aria-label={t("miniapp.claim.withdraw")}>
                    <p style={{ margin: "4px 0" }}>
                      {t("miniapp.claim.withdrawConfirm", { place: pickLocalized(c.placeName, locale) })}
                    </p>
                    <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Button
                        onClick={() => void withdraw(c.id)}
                        disabled={busy}
                        data-testid="claim-withdraw-yes"
                      >
                        {t("miniapp.claim.withdraw")}
                      </Button>
                      <Button onClick={() => setConfirming(null)} disabled={busy}>
                        {t("miniapp.claim.keep")}
                      </Button>
                    </span>
                  </div>
                ) : (
                  <Button
                    onClick={() => setConfirming(c.id)}
                    style={{ alignSelf: "flex-start" }}
                    data-testid="claim-withdraw"
                  >
                    {t("miniapp.claim.withdraw")}
                  </Button>
                ))}
            </li>
          ))}
        </ul>
        <Live message={message} testId="claims-message" />
      </Stack>
    </section>
  );
}
