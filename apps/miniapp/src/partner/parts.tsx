// Общие элементы кабинета партнёра: статус места и комментарий модератора, живое сообщение, переключатель P13.
import type { MessageKey } from "@tg/i18n";
import { Link, useT } from "@tg/ui";
import { Badge } from "../guide/parts.js";
import type { PartnerField, PartnerPlaceSummary, PartnerRole, PlaceStatus } from "./partner-api.js";

export type Message = { text: string; alert: boolean } | null;

export const statusKey = (s: PlaceStatus) => `miniapp.partner.status.${s}` as MessageKey;
export const roleKey = (r: PartnerRole) => `miniapp.partner.role.${r}` as MessageKey;
export const fieldKey = (f: PartnerField) => `miniapp.partner.field.${f}` as MessageKey;

/**
 * Живые области сообщений: отдельные узлы status и alert всегда в DOM (читалка объявляет изменения, смена роли
 * узла не теряет объявление). testId — на обёртке.
 */
export function Live({ message, testId }: { message: Message; testId: string }) {
  return (
    <div data-testid={testId}>
      <p role="status">{message && !message.alert ? message.text : ""}</p>
      <p role="alert">{message?.alert ? message.text : ""}</p>
    </div>
  );
}

/** Статус модерации места и комментарий модератора (при возврате или отклонении). */
export function PlaceStatusInfo({
  status,
  moderation,
}: {
  status: PlaceStatus;
  moderation: PartnerPlaceSummary["moderation"];
}) {
  const { t } = useT();
  const showComment =
    moderation?.comment && (status === "changes_requested" || status === "rejected" || moderation.decision);
  return (
    <>
      <span style={{ display: "flex", gap: 6, margin: "4px 0" }}>
        <Badge testId="place-status">{t(statusKey(status))}</Badge>
      </span>
      {showComment && (
        <p data-testid="moderator-comment" style={{ whiteSpace: "pre-line" }}>
          {t("miniapp.partner.moderatorComment", { comment: moderation!.comment! })}
        </p>
      )}
    </>
  );
}

/** P13: режим турист / партнёр в одном Mini App (D-50). */
export function ModeSwitch({
  current,
  inProfile = false,
}: {
  current: "tourist" | "partner";
  /** В профиле текущий режим — не текущая страница: aria-current="true". */
  inProfile?: boolean;
}) {
  const mark = inProfile ? ("true" as const) : ("page" as const);
  const { t } = useT();
  return (
    <nav aria-label={t("miniapp.partner.mode")} data-testid="mode-switch" style={{ display: "flex", gap: 8 }}>
      <Link to="/" className="kosiv-chip" aria-current={current === "tourist" ? mark : undefined}>
        {t("miniapp.partner.mode.tourist")}
      </Link>
      <Link to="/partner" className="kosiv-chip" aria-current={current === "partner" ? mark : undefined}>
        {t("miniapp.partner.mode.partner")}
      </Link>
    </nav>
  );
}

/** Новый ключ идемпотентности (UUID). */
export function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
