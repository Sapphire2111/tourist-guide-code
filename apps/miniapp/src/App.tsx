import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { ApiClient } from "@tg/api-client";
import { DEFAULT_LOCALE, resolveLocale, SUPPORTED_LOCALES, type Locale } from "@tg/i18n";
import {
  Button,
  Feature,
  FeatureFlagsProvider,
  I18nProvider,
  Link,
  Stack,
  ThemeStyle,
  useFeatureFlag,
  useRoute,
  useT,
} from "@tg/ui";
import { hasRequiredConsents } from "./consents.js";
import { ContextUnavailable, ContextView, Onboarding } from "./Entry.js";
import { useFeatureFlags } from "./feature-flags.js";
import { Profile } from "./Profile.js";
import { fetchContext, type Me, type StartupState } from "./session.js";
import { Health } from "./Health.js";
import type { Role } from "./role.js";
import type { TelegramUser, TelegramWebApp } from "./telegram.js";

// Safe areas: переменные Telegram (Bot API 8.0+, их ставит telegram-web-app.js), иначе env() браузера.
const inset = (side: "top" | "bottom" | "left" | "right") =>
  `calc(var(--tg-safe-area-inset-${side}, env(safe-area-inset-${side}, 0px)) + var(--tg-content-safe-area-inset-${side}, 0px) + 16px)`;

const shellStyle: CSSProperties = {
  minHeight: "var(--tg-viewport-stable-height, 100vh)",
  paddingTop: inset("top"),
  paddingBottom: inset("bottom"),
  paddingLeft: inset("left"),
  paddingRight: inset("right"),
};

export type AppProps = {
  api: ApiClient;
  role: Role;
  user?: TelegramUser;
  webApp?: TelegramWebApp;
  locale?: Locale;
  /** Поток старта (createStartup): вход по initData, контекст QR, профиль. Нет — режим без сессии (браузер). */
  startup?: () => Promise<StartupState>;
};

type Session = Extract<StartupState, { status: "ready" }>;
type RoutesProps = Omit<AppProps, "startup" | "locale"> & {
  session?: Session;
  onMe: (me: Me) => void;
  /** Явный повтор GET /context после сбоя (один запрос на нажатие); true — загружен. */
  retryContext: () => Promise<boolean>;
};

/**
 * «Назад» (на главную, replace — без новой записи истории): в Telegram — нативная BackButton, в браузере — обычная кнопка.
 * Не history.back(): при входе по прямой ссылке он увёл бы из приложения.
 */
function Back({ webApp }: { webApp?: TelegramWebApp }) {
  const { t } = useT();
  const [, navigate] = useRoute();
  const back = webApp?.BackButton;
  useEffect(() => {
    if (!back) return;
    const onClick = () => navigate("/", { replace: true });
    back.onClick(onClick);
    back.show();
    return () => {
      back.offClick(onClick);
      back.hide();
    };
  }, [back, navigate]);
  if (back) return null;
  return <Button onClick={() => navigate("/", { replace: true })}>{t("common.back")}</Button>;
}

function Home({ api, role, user, webApp, session, onMe, retryContext }: RoutesProps) {
  const { t } = useT();
  return (
    <Stack>
      <h1>{t("app.name")}</h1>
      {user && <p data-testid="tg-user">{t("miniapp.greeting", { name: user.first_name })}</p>}
      {session ? (
        <>
          {session.contextFailed ? (
            <ContextUnavailable retry={retryContext} />
          ) : (
            <ContextView context={session.context} webApp={webApp} />
          )}
          {hasRequiredConsents(session.me) ? (
            <Link to="/profile" style={{ fontSize: "1.25rem", fontWeight: 700 }}>
              {t("miniapp.profile.open")}
            </Link>
          ) : (
            <Onboarding api={api} webApp={webApp} onDone={onMe} />
          )}
        </>
      ) : (
        <p data-testid="browser-notice">{t("miniapp.browser.notice")}</p>
      )}
      <p>{t("miniapp.intro")}</p>
      <p data-testid="role">{t("miniapp.role", { role: t(`miniapp.role.${role}`) })}</p>
      {role === "partner" && (
        // Кабинет партнёра — модуль блока 6: пункт скрыт, пока флаг выключен (T1-22).
        <Feature flag="module.partner_cabinet">
          <Link to="/partner">{t("miniapp.partner.open")}</Link>
        </Feature>
      )}
      <Health api={api} />
    </Stack>
  );
}

function Screen({
  title,
  webApp,
  children,
}: {
  title: string;
  webApp?: TelegramWebApp;
  children?: ReactNode;
}) {
  return (
    <Stack>
      <h1>{title}</h1>
      {children}
      <Back webApp={webApp} />
    </Stack>
  );
}

function Routes(props: RoutesProps) {
  const { api, role, webApp, session, onMe } = props;
  const { t } = useT();
  const [path] = useRoute();
  const partnerCabinet = useFeatureFlag("module.partner_cabinet");
  if (path === "/") return <Home {...props} />;
  if (path === "/profile" && session && hasRequiredConsents(session.me)) {
    return (
      <Screen title={t("miniapp.profile.title")} webApp={webApp}>
        <Profile api={api} me={session.me} webApp={webApp} onChange={onMe} />
      </Screen>
    );
  }
  // Кабинет партнёра (модуль блока 6) при выключенном флаге — как несуществующий путь (T1-22).
  if (path === "/partner" && partnerCabinet) {
    return (
      <Screen title={t("miniapp.partner.title")} webApp={webApp}>
        {role === "partner" ? (
          <p>{t("common.stub")}</p>
        ) : (
          <p role="alert">{t("miniapp.partner.forbidden")}</p>
        )}
      </Screen>
    );
  }
  return (
    <Screen title={t("common.notFound")} webApp={webApp}>
      <Link to="/">{t("common.toHome")}</Link>
    </Screen>
  );
}

function StartupStatus({ state }: { state: StartupState }) {
  const { t } = useT();
  if (state.status === "loading") return <p role="status">{t("miniapp.start.loading")}</p>;
  if (state.status !== "error") return null;
  return (
    <Stack>
      <h1>{t("app.name")}</h1>
      <p role="alert" data-testid="start-error">
        {t(state.messageKey)}
      </p>
      <p>{t("miniapp.start.reopen")}</p>
    </Stack>
  );
}

export function App({ locale = DEFAULT_LOCALE, startup, ...props }: AppProps) {
  const { webApp } = props;
  const [state, setState] = useState<StartupState>(startup ? { status: "loading" } : { status: "browser" });
  // ready() после первого рендера: Telegram снимает заглушку загрузки, когда интерфейс уже есть.
  useEffect(() => webApp?.ready(), [webApp]);
  // startup запоминает промис: повторный эффект (StrictMode) не повторяет вход и GET /context.
  useEffect(() => {
    if (!startup) return;
    let alive = true;
    void startup().then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, [startup]);
  const session = state.status === "ready" ? state : undefined;
  const onMe = (me: Me) => setState((s) => (s.status === "ready" ? { ...s, me } : s));
  const retryContext = async () => {
    const startParam = session?.contextFailed;
    if (!startParam) return true;
    const context = await fetchContext(props.api, startParam);
    if (!context) return false;
    setState((s) => (s.status === "ready" ? { ...s, context, contextFailed: undefined } : s));
    return true;
  };
  const effectiveLocale = session ? resolveLocale(session.me.language, SUPPORTED_LOCALES) : locale;
  const flags = useFeatureFlags(props.api, session?.context?.region?.id);
  return (
    <I18nProvider locale={effectiveLocale}>
      <FeatureFlagsProvider flags={flags}>
        <ThemeStyle />
        <main style={shellStyle} lang={effectiveLocale}>
          {state.status === "loading" || state.status === "error" ? (
            <StartupStatus state={state} />
          ) : (
            <Routes {...props} session={session} onMe={onMe} retryContext={retryContext} />
          )}
        </main>
      </FeatureFlagsProvider>
    </I18nProvider>
  );
}
