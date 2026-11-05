// Общие элементы кабинета партнёра: статус места и комментарий модератора, живое сообщение, переключатель P13.
import type { MessageKey } from "@tg/i18n";
import type { ReactNode } from "react";
import { Link, useRoute, useT } from "@tg/ui";
import { Badge } from "../guide/parts.js";
import { getWebApp, nativeBackButton } from "../telegram.js";
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

/**
 * Шапка экрана кабинета: h1 и текстовая ссылка «← Мій заклад». В Telegram со своей BackButton ссылка не нужна
 * (одна кнопка «Назад» на приложение), в браузере и на старых клиентах — показываем.
 */
export function PartnerHeader({
  title,
  backTo = "/partner",
  backLabel,
  replace = false,
  children,
}: {
  title: string;
  backTo?: string;
  /** Подпись ссылки; по умолчанию «← Мій заклад». */
  backLabel?: string;
  /** Переход без записи в историю (после принятого приглашения). */
  replace?: boolean;
  children?: ReactNode;
}) {
  const { t } = useT();
  const [, navigate] = useRoute();
  const native = nativeBackButton(getWebApp()) !== undefined;
  return (
    <header className="partner-header">
      {!native && (
        <Link
          to={backTo}
          className="partner-back"
          onClick={
            replace
              ? (e) => {
                  e.preventDefault();
                  navigate(backTo, { replace: true });
                }
              : undefined
          }
        >
          {backLabel ?? t("miniapp.partner.toDashboard")}
        </Link>
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

/** Пустой список: иконка, текст и необязательное действие. */
export function EmptyState({
  text,
  icon = "🌿",
  action,
  testId,
}: {
  text: string;
  icon?: string;
  /** Кнопка или ссылка-призыв. */
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="kosiv-card kosiv-empty" data-testid={testId}>
      <span aria-hidden="true" style={{ fontSize: "2rem" }}>
        {icon}
      </span>
      <p style={{ margin: 0 }}>{text}</p>
      {action}
    </div>
  );
}

/** Карточка статуса места: человеческий текст, цитата модератора, одно действие (слот). */
export function PlaceStatusCard({
  status,
  moderation,
  action,
}: {
  status: PlaceStatus;
  moderation: PartnerPlaceSummary["moderation"];
  /** Единственное главное действие для этого статуса. */
  action?: ReactNode;
}) {
  const { t } = useT();
  const showComment =
    moderation?.comment && (status === "changes_requested" || status === "rejected" || moderation.decision);
  return (
    <section className="partner-status" data-status={status} aria-label={t(statusKey(status))}>
      <span>
        <Badge testId="place-status">{t(statusKey(status))}</Badge>
      </span>
      <p>{t(`miniapp.partner.status.text.${status}` as MessageKey)}</p>
      {showComment && (
        <blockquote className="partner-status-quote" data-testid="moderator-comment">
          <cite>{t("miniapp.partner.moderator.title")}</cite>
          {moderation!.comment}
        </blockquote>
      )}
      {action}
    </section>
  );
}

/** «Заповнено N з M» с полосой прогресса. */
export function ProgressBar({ done, total }: { done: number; total: number }) {
  const { t } = useT();
  const pct = total > 0 ? Math.round((Math.min(done, total) / total) * 100) : 0;
  return (
    <div className="partner-progress" data-testid="partner-progress">
      <span>{t("miniapp.partner.progress", { done, total })}</span>
      <div
        className="partner-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={t("miniapp.partner.progress", { done, total })}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** «Що далі»: не больше трёх шагов-ссылок. */
export function NextSteps({ steps }: { steps: readonly { to: string; label: string }[] }) {
  const { t } = useT();
  const shown = steps.slice(0, 3);
  if (!shown.length) return null;
  return (
    <nav aria-label={t("miniapp.partner.nextSteps.title")} data-testid="next-steps">
      <strong>{t("miniapp.partner.nextSteps.title")}</strong>
      <ul className="partner-next">
        {shown.map((s) => (
          <li key={s.to + s.label}>
            <Link to={s.to}>{s.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
