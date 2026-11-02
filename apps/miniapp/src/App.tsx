import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ApiClient } from "@tg/api-client";
import { DEFAULT_LOCALE, pickLocalized, resolveLocale, SUPPORTED_LOCALES, type Locale } from "@tg/i18n";
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
import { fetchContext, getAnonymousId, type Me, type StartupState } from "./session.js";
import { createAnalytics, type Analytics } from "./guide/analytics.js";
import { BottomNav, BOTTOM_NAV_HEIGHT } from "./guide/BottomNav.js";
import { Catalog } from "./guide/Catalog.js";
import { GuideProvider, RequireRegion, type GuideEnv } from "./guide/context.js";
import { Favorites } from "./guide/Favorites.js";
import { createGuideApi } from "./guide/guide-api.js";
import { Help } from "./guide/Help.js";
import { HomeSections } from "./guide/HomeSections.js";
import type { LatLng } from "./guide/geo.js";
import { Nearby } from "./guide/Nearby.js";
import { PlaceCard } from "./guide/PlaceCard.js";
import { CATALOG_SECTIONS, type CatalogSection, type GuideApi } from "./guide/types.js";
import { Health } from "./Health.js";
import type { Role } from "./role.js";
import type { TelegramUser, TelegramWebApp } from "./telegram.js";

// Safe areas: переменные Telegram (Bot API 8.0+, их ставит telegram-web-app.js), иначе env() браузера.
const inset = (side: "top" | "bottom" | "left" | "right") =>
  `calc(var(--tg-safe-area-inset-${side}, env(safe-area-inset-${side}, 0px)) + var(--tg-content-safe-area-inset-${side}, 0px) + 16px)`;

const shellStyle: CSSProperties = {
  minHeight: "var(--tg-viewport-stable-height, 100vh)",
  paddingTop: inset("top"),
  // Снизу — место под фиксированную нижнюю навигацию (у неё свой отступ safe area).
  paddingBottom: `calc(${inset("bottom")} + ${BOTTOM_NAV_HEIGHT}px)`,
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
  /** Данные гида (тесты подменяют); по умолчанию — поверх api. */
  guideApi?: GuideApi;
  /** Аналитика (тесты подменяют); по умолчанию — POST /analytics/events. */
  analytics?: Analytics;
};

type Session = Extract<StartupState, { status: "ready" }>;
type RoutesProps = Omit<AppProps, "startup" | "locale" | "guideApi" | "analytics"> & {
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

/**
 * Базовая точка «Що поруч»: координаты места QR-точки (qrPoint.placeId → GET /places/{id}); в контексте входа
 * координат нет. Не загрузилась — null (режим без базовой точки).
 */
function useBasePoint(api: GuideApi, placeId: string | null): LatLng | null {
  const [point, setPoint] = useState<LatLng | null>(null);
  useEffect(() => {
    if (!placeId) return;
    let alive = true;
    api.place(placeId).then(
      (p) => alive && setPoint(p.location),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, placeId]);
  return placeId ? point : null;
}

function venueOf(session?: Session) {
  const c = session?.context;
  return c?.status === "ok" && c.entryType === "hotel" ? c.venue : null;
}

/** Шапка главной: «Ви відкрили гід: <заклад>» или регион; полная карточка заведения — «Про заклад» (/about). */
function ContextSummary({ context }: { context: Session["context"] }) {
  const { t, locale } = useT();
  const venue = context?.status === "ok" && context.entryType === "hotel" ? context.venue : null;
  if (venue)
    return (
      <p data-testid="venue-summary">
        {t("miniapp.venue.opened", { name: pickLocalized(venue.name, locale) })}
      </p>
    );
  return <ContextView context={context} />;
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
            <ContextSummary context={session.context} />
          )}
          {!hasRequiredConsents(session.me) && <Onboarding api={api} webApp={webApp} onDone={onMe} />}
        </>
      ) : (
        <p data-testid="browser-notice">{t("miniapp.browser.notice")}</p>
      )}
      <HomeSections hasVenue={venueOf(session) !== null} />
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
  /** Заголовок h1; экраны гида ставят его сами. */
  title?: string;
  webApp?: TelegramWebApp;
  children?: ReactNode;
}) {
  return (
    <Stack>
      {title && <h1>{title}</h1>}
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
  const section = /^\/section\/([a-z]+)$/.exec(path)?.[1];
  if (section && (CATALOG_SECTIONS as readonly string[]).includes(section))
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <Catalog key={section} section={section as CatalogSection} />
        </RequireRegion>
      </Screen>
    );
  const placeId = /^\/place\/([^/]+)$/.exec(path)?.[1];
  if (placeId)
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <PlaceCard key={placeId} id={decodeURIComponent(placeId)} />
        </RequireRegion>
      </Screen>
    );
  if (path === "/nearby" || path === "/nearby/me")
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <Nearby key={path} useMyLocation={path === "/nearby/me"} />
        </RequireRegion>
      </Screen>
    );
  if (path === "/help")
    return (
      <Screen webApp={webApp}>
        <Help />
      </Screen>
    );
  if (path === "/favorites")
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <Favorites />
        </RequireRegion>
      </Screen>
    );
  if (path === "/about" && venueOf(session))
    return (
      <Screen title={t("miniapp.venue.title")} webApp={webApp}>
        <ContextView context={session!.context} webApp={webApp} />
      </Screen>
    );
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

export function App({ locale = DEFAULT_LOCALE, startup, guideApi, analytics, ...props }: AppProps) {
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
  const context = session?.context ?? null;
  const signedIn = Boolean(session);
  const regionId = context?.region?.id ?? null;
  const api = useMemo(() => guideApi ?? createGuideApi(props.api, regionId), [guideApi, props.api, regionId]);
  // Конверт аналитики берёт контекст входа на момент события.
  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);
  const tracker = useMemo(
    () =>
      analytics ??
      createAnalytics(props.api, () => ({
        anonymousId: contextRef.current?.anonymousId ?? getAnonymousId(),
        regionId: contextRef.current?.region?.id ?? null,
        entryContextId: contextRef.current?.entryContextId ?? null,
        source: contextRef.current?.qrPoint ? "qr" : "direct",
      })),
    [analytics, props.api],
  );
  const venue = venueOf(session);
  const venueName = venue ? pickLocalized(venue.name, effectiveLocale) : null;
  const basePoint = useBasePoint(api, context?.qrPoint?.placeId ?? null);
  const guide = useMemo<GuideEnv>(
    () => ({
      api,
      analytics: tracker,
      webApp: props.webApp,
      base: venueName ? { name: venueName, point: basePoint } : null,
      regionId,
      signedIn,
    }),
    [api, tracker, props.webApp, venueName, basePoint, regionId, signedIn],
  );
  return (
    <I18nProvider locale={effectiveLocale}>
      <FeatureFlagsProvider flags={flags}>
        <ThemeStyle />
        <main style={shellStyle} lang={effectiveLocale}>
          {state.status === "loading" || state.status === "error" ? (
            <StartupStatus state={state} />
          ) : (
            <GuideProvider value={guide}>
              <Routes {...props} session={session} onMe={onMe} retryContext={retryContext} />
              <BottomNav profile={Boolean(session && hasRequiredConsents(session.me))} />
            </GuideProvider>
          )}
        </main>
      </FeatureFlagsProvider>
    </I18nProvider>
  );
}
