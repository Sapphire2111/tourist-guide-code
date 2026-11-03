import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { AppTop, Splash } from "./design/Chrome.js";
import { LocationChip } from "./guide/LocationPicker.js";
import { LocationProvider } from "./guide/LocationProvider.js";
import { HomePlaces, SeasonTags } from "./design/HomeParts.js";
import { SeasonProvider } from "./design/SeasonProvider.js";
import { BottomNav } from "./guide/BottomNav.js";
import { Catalog, PlaceSearch } from "./guide/Catalog.js";
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
import { About } from "./host/About.js";
import { HostProvider, useHost, type HostEnv, type StaffRole } from "./host/context.js";
import { createHostApi } from "./host/host-api.js";
import { MyRequests, StaffRequests } from "./host/Requests.js";
import type { HostApi } from "./host/types.js";
import { MyPlan, NewPlanScreen, SavedPlanScreen, ScenarioScreen } from "./plan/MyPlan.js";
import { PartnerProvider, usePartnerOrgs } from "./partner/context.js";
import { PartnerDashboard } from "./partner/Dashboard.js";
import { AcceptInvite } from "./partner/Invite.js";
import { PartnerOffers } from "./partner/Offers.js";
import { PartnerOnboarding } from "./partner/Onboarding.js";
import { createPartnerApi, type PartnerApi } from "./partner/partner-api.js";
import { ModeSwitch } from "./partner/parts.js";
import { PlaceEditor } from "./partner/PlaceEditor.js";
import { PartnerStaff } from "./partner/Staff.js";
import type { Role } from "./role.js";
import { consumeBack, type TelegramUser, type TelegramWebApp } from "./telegram.js";

// Оболочка — классы design/kosiv.css: safe areas (переменные Telegram Bot API 8.0+, иначе env() браузера) учитывают
// липкая шапка (сверху), отступ содержимого и нижняя навигация (снизу).

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
  /** API блока 5 (тесты подменяют); по умолчанию — поверх api. */
  hostApi?: HostApi;
  /** API кабинета партнёра (блок 6; тесты подменяют); по умолчанию — поверх api. */
  partnerApi?: PartnerApi;
};

type Session = Extract<StartupState, { status: "ready" }>;
type RoutesProps = Omit<
  AppProps,
  "startup" | "locale" | "guideApi" | "analytics" | "hostApi" | "partnerApi"
> & {
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
    // Открыт слой поверх экрана (полноэкранное фото) — «Назад» закрывает его, а не уводит на главную.
    const onClick = () => {
      if (!consumeBack()) navigate("/", { replace: true });
    };
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
function useBasePoint(api: GuideApi, placeId: string | null): { point: LatLng | null; pending: boolean } {
  const [loaded, setLoaded] = useState<{ placeId: string; point: LatLng | null } | null>(null);
  useEffect(() => {
    if (!placeId) return;
    let alive = true;
    api.place(placeId).then(
      (p) => alive && setLoaded({ placeId, point: p.location }),
      () => alive && setLoaded({ placeId, point: null }),
    );
    return () => {
      alive = false;
    };
  }, [api, placeId]);
  if (!placeId) return { point: null, pending: false };
  if (loaded?.placeId !== placeId) return { point: null, pending: true };
  return { point: loaded.point, pending: false };
}

function venueOf(session?: Session) {
  const c = session?.context;
  return c?.status === "ok" && c.entryType === "hotel" ? c.venue : null;
}

/** Одна строка о регионе: «Ви на Прикарпатті.» (место с предлогом по коду региона) или «Ви в регіоні: …». */
function regionLine(
  context: Session["context"],
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: Locale,
): string | null {
  const region = context?.region;
  if (!region) return null;
  const key = `miniapp.region.in.${region.code}`;
  const place = t(key);
  return place !== key
    ? t("miniapp.context.in", { place })
    : t("miniapp.context.region", { region: pickLocalized(region.name, locale) });
}

/**
 * Приветствие и контекст входа в одну строку: «Вітаємо, {name}! Ви на Прикарпатті.» При входе по QR заведения —
 * приветствие и «Ви відкрили гід: <заклад>» (регион не нужен).
 */
function Welcome({ user, session, retryContext }: Pick<RoutesProps, "user" | "session" | "retryContext">) {
  const { t, tDynamic, locale } = useT();
  const context = session && !session.contextFailed ? session.context : null;
  const venue = context?.status === "ok" && context.entryType === "hotel" ? context.venue : null;
  const where = venue ? null : regionLine(context, tDynamic, locale);
  const hello = user ? t("miniapp.greeting", { name: user.first_name }) : null;
  return (
    <div className="kosiv-welcome">
      {(hello || where) && (
        <p className="kosiv-welcome-hello">
          {hello && <span data-testid="tg-user">{hello}</span>}
          {hello && where ? " " : null}
          {where && <span data-testid="neutral-context">{where}</span>}
        </p>
      )}
      {session ? (
        session.contextFailed ? (
          <ContextUnavailable retry={retryContext} />
        ) : venue ? (
          <p data-testid="venue-summary" className="kosiv-welcome-sub">
            {t("miniapp.venue.opened", { name: pickLocalized(venue.name, locale) })}
          </p>
        ) : !context?.region ? (
          <p className="kosiv-welcome-sub">{t("miniapp.context.noRegion")}</p>
        ) : null
      ) : (
        <p data-testid="browser-notice" className="kosiv-welcome-sub">
          {t("miniapp.browser.notice")}
        </p>
      )}
    </div>
  );
}

function Home({ api, role, user, webApp, session, onMe, retryContext }: RoutesProps) {
  const { t } = useT();
  const { staff } = useHost();
  const partnerOrgs = usePartnerOrgs();
  return (
    <>
      <Welcome user={user} session={session} retryContext={retryContext} />
      <LocationChip />
      {session && !hasRequiredConsents(session.me) && (
        <div className="kosiv-card kosiv-panel">
          <Onboarding api={api} webApp={webApp} onDone={onMe} />
        </div>
      )}
      {staff === "yes" && (
        <Link to="/staff" data-testid="staff-link" className="kosiv-cta">
          {t("miniapp.staff.open")}
        </Link>
      )}
      {/* Сразу меню разделов; лента мест и быстрый поиск — ниже. */}
      <HomeSections hasVenue={venueOf(session) !== null} />
      <HomePlaces />
      <SeasonTags />
      <div className="kosiv-meta-block">
        <p data-testid="role">{t("miniapp.role", { role: t(`miniapp.role.${role}`) })}</p>
        {(role === "partner" || partnerOrgs.length > 0) && (
          // Кабинет партнёра — модуль блока 6: пункт скрыт, пока флаг выключен (T1-22).
          <Feature flag="module.partner_cabinet">
            <Link to="/partner" data-testid="partner-link">
              {t("miniapp.partner.open")}
            </Link>
          </Feature>
        )}
        <Health api={api} />
      </div>
    </>
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id места из #/place/<id>: битый или не-UUID — "" (экран «Заклад недоступний» без запроса). */
function placeIdOf(path: string): string | undefined {
  const raw = /^\/place\/([^/]+)$/.exec(path)?.[1];
  if (raw === undefined) return undefined;
  try {
    const id = decodeURIComponent(raw);
    return UUID_RE.test(id) ? id : "";
  } catch {
    return "";
  }
}

function uuidOf(raw: string): string {
  try {
    const id = decodeURIComponent(raw);
    return UUID_RE.test(id) ? id : "";
  } catch {
    return "";
  }
}

/** Смена экрана: фокус на h1 — читалка объявляет новый экран, клавиатура начинает сверху. */
function useFocusHeading(path: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Заголовок может появиться после загрузки данных — пробуем сразу и ещё раз позже.
    const focus = () => {
      const h1 = document.querySelector<HTMLElement>("main h1");
      if (!h1) return false;
      if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
      h1.focus();
      return true;
    };
    if (focus()) return;
    const id = window.setTimeout(focus, 300);
    return () => window.clearTimeout(id);
  }, [path]);
}

const PARTNER_PATH_RE = /^\/partner\/(place|org)\/([^/]+)(\/offers|\/staff)?$/;

/**
 * Экраны кабинета партнёра по пути; null — путь не из кабинета (или неверный id — «не найдено»).
 * Приглашение (P14) — /partner/invite, токен только в памяти (session.invite), не в адресе.
 */
function partnerScreen(path: string, invite: string | undefined): ReactNode {
  if (path === "/partner") return <PartnerDashboard />;
  if (path === "/partner/new") return <PartnerOnboarding />;
  if (path === "/partner/invite") return <AcceptInvite token={invite ?? ""} />;
  const m = PARTNER_PATH_RE.exec(path);
  if (!m) return null;
  const [, kind, raw, sub] = m;
  const id = uuidOf(raw!);
  if (!id) return null;
  if (kind === "place" && !sub) return <PlaceEditor key={id} id={id} />;
  if (kind === "place" && sub === "/offers") return <PartnerOffers key={id} placeId={id} />;
  if (kind === "org" && sub === "/staff") return <PartnerStaff key={id} orgId={id} />;
  return null;
}

/** C15 → P13/P12: переключатель режима для партнёра, иначе «Стати партнером». */
function PartnerEntry() {
  const { t } = useT();
  const orgs = usePartnerOrgs();
  return (
    <div className="kosiv-card kosiv-panel" data-testid="partner-entry">
      <h2>{t("miniapp.partner.title")}</h2>
      {orgs.length ? (
        <ModeSwitch current="tourist" inProfile />
      ) : (
        <Link to="/partner/new" className="kosiv-cta">
          {t("miniapp.partner.become")}
        </Link>
      )}
    </div>
  );
}

/** Открытие по приглашению (start_param inv_<токен>): один раз — на экран P14. */
function useInviteRedirect(invite: string | undefined, enabled: boolean) {
  const [, navigate] = useRoute();
  const done = useRef(false);
  useEffect(() => {
    if (invite === undefined || !enabled || done.current) return;
    done.current = true;
    navigate("/partner/invite", { replace: true });
  }, [invite, enabled, navigate]);
}

function Routes(props: RoutesProps) {
  const { api, role, webApp, session, onMe } = props;
  const { t } = useT();
  const [path] = useRoute();
  useFocusHeading(path);
  const partnerCabinet = useFeatureFlag("module.partner_cabinet");
  useInviteRedirect(session?.invite, partnerCabinet);
  // Заявки отеля и «Мій план» (блок 5) при выключенном флаге — как несуществующий путь.
  const hostRequests = useFeatureFlag("module.host_requests");
  // Режим персонала — снимок /me на старте; на главной (там ссылка в режим персонала) и на экране персонала
  // перечитываем, чтобы назначение или снятие роли в админке подхватывалось без перезапуска. Без входа — не нужно.
  const refreshMe = Boolean(session) && hostRequests && (path === "/" || path === "/staff");
  useEffect(() => {
    if (!refreshMe) return;
    let alive = true;
    api
      .GET("/me")
      .then((res) => {
        if (alive && res.data) onMe(res.data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [refreshMe, path, api, onMe]);
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
  if (path === "/search") {
    // Запрос — из адреса (#/search?q=…): быстрые чипы сезона на главной.
    const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("q") ?? "";
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <PlaceSearch key={q} initialQuery={q.slice(0, 100)} />
        </RequireRegion>
      </Screen>
    );
  }
  const placeId = placeIdOf(path);
  if (placeId !== undefined)
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <PlaceCard key={placeId} id={placeId} />
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
      <Screen webApp={webApp}>
        <About header={<ContextView context={session!.context} webApp={webApp} />} />
      </Screen>
    );
  if (hostRequests && path === "/requests")
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <MyRequests />
        </RequireRegion>
      </Screen>
    );
  if (hostRequests && path === "/staff")
    return (
      <Screen webApp={webApp}>
        <StaffRequests />
      </Screen>
    );
  if (hostRequests && (path === "/plan" || path === "/plan/saved"))
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <MyPlan tab={path === "/plan" ? "scenarios" : "saved"} />
        </RequireRegion>
      </Screen>
    );
  if (hostRequests && path === "/plan/new")
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <NewPlanScreen />
        </RequireRegion>
      </Screen>
    );
  const planRoute = hostRequests && /^\/plan\/(scenario|saved)\/([^/]+)$/.exec(path);
  if (planRoute) {
    const id = uuidOf(planRoute[2]!);
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          {!id ? (
            <p role="alert">{t("common.notFound")}</p>
          ) : planRoute[1] === "scenario" ? (
            <ScenarioScreen key={id} id={id} />
          ) : (
            <SavedPlanScreen key={id} id={id} />
          )}
        </RequireRegion>
      </Screen>
    );
  }
  if (path === "/profile" && session && hasRequiredConsents(session.me)) {
    return (
      <Screen title={t("miniapp.profile.title")} webApp={webApp}>
        <Profile api={api} me={session.me} webApp={webApp} onChange={onMe} />
        <Feature flag="module.partner_cabinet">
          <PartnerEntry />
        </Feature>
      </Screen>
    );
  }
  // Кабинет партнёра (модуль блока 6) при выключенном флаге — как несуществующий путь (T1-22).
  const partner = partnerCabinet ? partnerScreen(path, session?.invite) : null;
  if (partner && !session)
    return (
      <Screen title={t("miniapp.partner.title")} webApp={webApp}>
        <p role="alert">
          {t(role === "partner" ? "miniapp.partner.needsLogin" : "miniapp.partner.forbidden")}
        </p>
      </Screen>
    );
  // Онбординг партнёра и приглашение — только после обязательных согласий (C01); P14 — после формы.
  if (partner && !hasRequiredConsents(session!.me))
    return (
      <Screen title={t("miniapp.partner.title")} webApp={webApp}>
        <div className="kosiv-card kosiv-panel" data-testid="partner-consents">
          <Onboarding api={api} webApp={webApp} onDone={onMe} />
        </div>
      </Screen>
    );
  if (partner) return <Screen webApp={webApp}>{partner}</Screen>;
  return (
    <Screen title={t("common.notFound")} webApp={webApp}>
      <Link to="/">{t("common.toHome")}</Link>
    </Screen>
  );
}

function StartupStatus({ state }: { state: StartupState }) {
  const { t } = useT();
  if (state.status === "loading") return <Splash />;
  if (state.status !== "error") return null;
  return (
    <div className="kosiv-content">
      <div className="kosiv-card kosiv-empty">
        <h1>{t("app.name")}</h1>
        <p role="alert" data-testid="start-error">
          {t(state.messageKey)}
        </p>
        <p>{t("miniapp.start.reopen")}</p>
      </div>
    </div>
  );
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Шапка, содержимое экрана и нижняя навигация. Появление экрана — анимацией того же узла (Web Animations), без
 * пересоздания дерева: фокус на h1, BackButton и состояние экранов при смене пути сохраняются.
 */
function Shell({ routes, profile }: { routes: ReactNode; profile: boolean }) {
  const [path] = useRoute();
  const content = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reducedMotion()) return;
    content.current?.animate?.([{ transform: "translateY(8px)" }, { transform: "none" }], {
      duration: 280,
      easing: "ease-out",
    });
  }, [path]);
  return (
    <>
      <AppTop path={path} profile={profile} />
      <div className="kosiv-content" ref={content}>
        {routes}
      </div>
      <BottomNav />
    </>
  );
}

export function App({
  locale = DEFAULT_LOCALE,
  startup,
  guideApi,
  analytics,
  hostApi,
  partnerApi,
  ...props
}: AppProps) {
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
  const onMe = useCallback((me: Me) => setState((s) => (s.status === "ready" ? { ...s, me } : s)), []);
  const retryContext = async () => {
    const failed = session?.contextFailed;
    if (!failed) return true;
    const context = await fetchContext(props.api, failed.startParam);
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
  // Синхронно в рендере: событие из эффекта того же рендера уже видит новый контекст.
  contextRef.current = context;
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
  // Свой клиент аналитики снимает обработчики страницы при пересоздании и размонтировании.
  useEffect(() => (analytics ? undefined : () => tracker.dispose()), [analytics, tracker]);
  const venue = venueOf(session);
  const venueName = venue ? pickLocalized(venue.name, effectiveLocale) : null;
  const { point: basePoint, pending: basePending } = useBasePoint(api, context?.qrPoint?.placeId ?? null);
  const guide = useMemo<GuideEnv>(
    () => ({
      api,
      analytics: tracker,
      webApp: props.webApp,
      base: venueName ? { name: venueName, point: basePoint, pending: basePending } : null,
      regionId,
      signedIn,
    }),
    [api, tracker, props.webApp, venueName, basePoint, basePending, regionId, signedIn],
  );
  const hApi = useMemo(() => hostApi ?? createHostApi(props.api, regionId), [hostApi, props.api, regionId]);
  // Режим персонала (D-50): признак staffMode из /me (сервер считает роли ORG_STAFF/ORG_OWNER), только при
  // включённом module.host_requests. Отдельный запрос не нужен — «нет доступа» не мелькает до ответа.
  const hostRequests = flags?.["module.host_requests"] === true;
  const staff: StaffRole = session && hostRequests && session.me.staffMode ? "yes" : "no";
  const host = useMemo<HostEnv>(
    () => ({
      api: hApi,
      hotelPlaceId: venue ? (context?.qrPoint?.placeId ?? null) : null,
      entryContextId: context?.entryContextId ?? null,
      staff,
      timeZone: context?.region?.timezone ?? null,
    }),
    [hApi, venue, context, staff],
  );
  const pApi = useMemo(() => partnerApi ?? createPartnerApi(props.api), [partnerApi, props.api]);
  const partnerEnabled = Boolean(session) && flags?.["module.partner_cabinet"] === true;
  return (
    <I18nProvider locale={effectiveLocale}>
      <FeatureFlagsProvider flags={flags}>
        <ThemeStyle />
        <SeasonProvider webApp={webApp}>
          <main className="kosiv-shell" lang={effectiveLocale}>
            {state.status === "loading" || state.status === "error" ? (
              <StartupStatus state={state} />
            ) : (
              <GuideProvider value={guide}>
                <LocationProvider venueEntry={venue !== null}>
                  <HostProvider value={host}>
                    <PartnerProvider api={pApi} regionId={regionId} enabled={partnerEnabled}>
                      <Shell
                        profile={Boolean(session && hasRequiredConsents(session.me))}
                        routes={
                          <Routes {...props} session={session} onMe={onMe} retryContext={retryContext} />
                        }
                      />
                    </PartnerProvider>
                  </HostProvider>
                </LocationProvider>
              </GuideProvider>
            )}
          </main>
        </SeasonProvider>
      </FeatureFlagsProvider>
    </I18nProvider>
  );
}
