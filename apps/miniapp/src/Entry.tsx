// C01: контекст входа по QR («Про заклад» отеля или нейтральный регион) и онбординг согласий (C17, D-41).
import { useState, type CSSProperties } from "react";
import type { ApiClient } from "@tg/api-client";
import { pickLocalized } from "@tg/i18n";
import { Button, Stack, useT } from "@tg/ui";
import { CONSENT_VERSIONS } from "./consents.js";
import type { Me, QrContext } from "./session.js";
import type { TelegramWebApp } from "./telegram.js";

// Контакты — крупные жирные ссылки-действия: link_color Telegram (#3390ec на белом, 3.4:1) проходит AA только для
// крупного текста (≥ 14pt bold, порог 3:1).
const actionLink: CSSProperties = { fontSize: "1.25rem", fontWeight: 700 };

/** «Про заклад» при ok у QR отеля, иначе нейтральный экран региона — без ручного выбора. */
/** Ссылка через WebApp.openTelegramLink/openLink, если доступны; иначе обычный переход. */
function ExternalLink({
  href,
  via,
  webApp,
  children,
}: {
  href: string;
  via: "telegram" | "web";
  webApp?: TelegramWebApp;
  children: string;
}) {
  const open = via === "telegram" ? webApp?.openTelegramLink : webApp?.openLink;
  return (
    <a
      style={actionLink}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (!open) return;
        e.preventDefault();
        open.call(webApp, href);
      }}
    >
      {children}
    </a>
  );
}

/** Контекст не загрузился (429/5xx/сеть): не нейтральный регион, а повтор по кнопке. */
export function ContextUnavailable({ retry }: { retry: () => Promise<boolean> }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <section data-testid="context-unavailable">
      <p role="alert">{t("miniapp.context.unavailable")}</p>
      {failed && <p>{t("miniapp.context.retryFailed")}</p>}
      <Button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void retry().then((ok) => {
            setFailed(!ok);
            setBusy(false);
          });
        }}
      >
        {t("miniapp.context.retry")}
      </Button>
    </section>
  );
}

export function ContextView({ context, webApp }: { context: QrContext | null; webApp?: TelegramWebApp }) {
  const { t, locale } = useT();
  const venue = context?.status === "ok" && context.entryType === "hotel" ? context.venue : null;
  if (venue) {
    const name = pickLocalized(venue.name, locale);
    const description = venue.description && pickLocalized(venue.description, locale);
    const address = venue.address && pickLocalized(venue.address, locale);
    return (
      <section aria-labelledby="venue-title" data-testid="venue">
        <p>{t("miniapp.venue.opened", { name })}</p>
        <h2 id="venue-title">{t("miniapp.venue.title")}</h2>
        <h3 data-testid="venue-name">{name}</h3>
        {description && <p>{description}</p>}
        <dl>
          {address && (
            <>
              <dt>{t("miniapp.venue.address")}</dt>
              <dd>{address}</dd>
            </>
          )}
          {venue.phone && (
            <>
              <dt>{t("miniapp.venue.phone")}</dt>
              <dd>
                <a style={actionLink} href={`tel:${venue.phone}`}>
                  {venue.phone}
                </a>
              </dd>
            </>
          )}
          {venue.website && (
            <>
              <dt>{t("miniapp.venue.website")}</dt>
              <dd>
                <ExternalLink href={venue.website} via="web" webApp={webApp}>
                  {venue.website.replace(/^https:\/\//, "")}
                </ExternalLink>
              </dd>
            </>
          )}
          {venue.telegram && (
            <>
              <dt>{t("miniapp.venue.telegram")}</dt>
              <dd>
                <ExternalLink href={`https://t.me/${venue.telegram}`} via="telegram" webApp={webApp}>
                  {`@${venue.telegram}`}
                </ExternalLink>
              </dd>
            </>
          )}
        </dl>
      </section>
    );
  }
  return (
    <section data-testid="neutral-context">
      <p>
        {context?.region
          ? t("miniapp.context.region", { region: pickLocalized(context.region.name, locale) })
          : t("miniapp.context.noRegion")}
      </p>
      <p>{t("miniapp.context.neutral")}</p>
    </section>
  );
}

export function requestWriteAccess(webApp?: TelegramWebApp): Promise<boolean | undefined> {
  const request = webApp?.requestWriteAccess;
  if (!request) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      request.call(webApp, (granted) => resolve(granted));
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Онбординг: terms + privacy обязательны; затем requestWriteAccess для сервисных сообщений,
 * маркетинг — отдельный необязательный переключатель (только при выданном разрешении писать).
 */
export function Onboarding({
  api,
  webApp,
  onDone,
}: {
  api: ApiClient;
  webApp?: TelegramWebApp;
  onDone: (me: Me) => void;
}) {
  const { t } = useT();
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  /** Разрешение писать не выдано, а маркетинг отмечен: показать и дать продолжить. */
  const [noAccess, setNoAccess] = useState<Me | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(false);
    try {
      for (const kind of ["terms", "privacy"] as const) {
        const res = await api.POST("/me/consents", {
          body: { kind, version: CONSENT_VERSIONS[kind], action: "accept" },
        });
        if (res.error) throw new Error("consent");
      }
      const granted = await requestWriteAccess(webApp);
      if (granted !== undefined) {
        const service = await api.POST("/me/messaging-consent", {
          body: { purpose: "service", granted, source: "request_write_access" },
        });
        if (service.error) throw new Error("service");
        if (granted && marketing) {
          const res = await api.POST("/me/messaging-consent", {
            body: { purpose: "marketing", granted: true, source: "request_write_access" },
          });
          if (res.error) throw new Error("marketing");
        }
      }
      const me = await api.GET("/me");
      if (!me.data) throw new Error("me");
      if (marketing && !granted) {
        setNoAccess(me.data);
        setBusy(false);
        return;
      }
      onDone(me.data);
    } catch {
      setError(true);
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="onboarding-title">
      <Stack>
        <h2 id="onboarding-title">{t("miniapp.onboarding.title")}</h2>
        <p>{t("miniapp.onboarding.intro")}</p>
        <label>
          <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />{" "}
          {t("miniapp.onboarding.terms")}
        </label>
        <label>
          <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} />{" "}
          {t("miniapp.onboarding.privacy")}
        </label>
        <label>
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />{" "}
          {t("miniapp.onboarding.marketing")}
        </label>
        <p>{t("miniapp.onboarding.service")}</p>
        {error && <p role="alert">{t("miniapp.onboarding.error")}</p>}
        {noAccess ? (
          <>
            <p role="alert">{t("miniapp.onboarding.noWriteAccess")}</p>
            <Button onClick={() => onDone(noAccess)}>{t("miniapp.onboarding.continue")}</Button>
          </>
        ) : (
          <Button disabled={!terms || !privacy || busy} onClick={() => void submit()}>
            {t("miniapp.onboarding.continue")}
          </Button>
        )}
      </Stack>
    </section>
  );
}
