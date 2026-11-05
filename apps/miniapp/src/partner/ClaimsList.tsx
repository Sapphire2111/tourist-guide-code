// Заявки «Це мій заклад» (0031) в кабинете партнёра (P01): «Заявка на розгляді», затем «Схвалено» / «Відхилено» с
// комментарием модератора. Список — GET /partner/claims региона входа; пусто — блока нет.
import type { MessageKey } from "@tg/i18n";
import { pickLocalized } from "@tg/i18n";
import { Stack, useT } from "@tg/ui";
import { useAsync } from "../guide/context.js";
import { Badge, listStyle } from "../guide/parts.js";
import { usePartner } from "./context.js";
import type { PlaceClaim, PlaceClaimStatus } from "./partner-api.js";

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
      {claim.decisionComment && (
        <p data-testid="claim-comment" className="partner-status-quote">
          {t("miniapp.claim.moderatorComment", { comment: claim.decisionComment })}
        </p>
      )}
    </>
  );
}

/** Мои заявки на заклады; ошибка загрузки — короткое сообщение (кабинет работает и без списка). */
export function MyClaims() {
  const { t, locale } = useT();
  const { api, regionId, enabled } = usePartner();
  const [state] = useAsync(
    () => (enabled && regionId ? api.claims(regionId) : Promise.resolve([] as PlaceClaim[])),
    [api, regionId, enabled],
  );
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
            </li>
          ))}
        </ul>
      </Stack>
    </section>
  );
}
