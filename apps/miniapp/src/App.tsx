import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ApiClient } from "@tg/api-client";
import {
  DEFAULT_LOCALE,
  pickLocalized,
  resolveLocale,
  SUPPORTED_LOCALES,
  type Locale,
  type MessageKey,
} from "@tg/i18n";
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
import { createAssistantApi, type AssistantApi } from "./assistant/assistant-api.js";
import { AssistantBox } from "./assistant/AssistantBox.js";
import { AssistantSessionProvider } from "./assistant/session.js";
import { focusScreenHeading, initNavigation, pressBack, sameHrefLinks, takeReturnFocus } from "./back.js";
import { createBookingsApi, type BookingsApi } from "./bookings/bookings-api.js";
import { BookingsProvider, type BookingsEnv } from "./bookings/context.js";
import { lazyScreen } from "./bookings/lazy.js";
import { ReviewsProvider, type ReviewsEnv } from "./reviews/context.js";
import { createReviewsApi, type ReviewsApi } from "./reviews/reviews-api.js";
import { hasRequiredConsents } from "./consents.js";
import { ContextUnavailable, ContextView, Onboarding } from "./Entry.js";
import { useFeatureFlags } from "./feature-flags.js";
import { Profile } from "./Profile.js";
import { fetchContext, getAnonymousId, type Me, type StartupState } from "./session.js";
import { createAnalytics, type Analytics } from "./guide/analytics.js";
import { AppBackdrop } from "./design/AppBackdrop.js";
import { AppTop, Splash, type ScanControl } from "./design/Chrome.js";
import { resolveScan, type ScanOutcome } from "./scan.js";
import { LocationChip, LocationSheetHost } from "./guide/LocationPicker.js";
import { LocationProvider } from "./guide/LocationProvider.js";
import { SeasonProvider } from "./design/SeasonProvider.js";
import { ThemeProvider } from "./design/ThemeProvider.js";
import { BottomNav } from "./guide/BottomNav.js";
import { Catalog, PlaceSearch } from "./guide/Catalog.js";
import { GuideProvider, RequireRegion, useGuide, type GuideEnv } from "./guide/context.js";
import { Favorites } from "./guide/Favorites.js";
import { createGuideApi } from "./guide/guide-api.js";
import { Help } from "./guide/Help.js";
import { HomeSections } from "./guide/HomeSections.js";
import type { LatLng } from "./guide/geo.js";
import { Nearby } from "./guide/Nearby.js";
import { Peaks } from "./guide/Peaks.js";
import { PlaceCard } from "./guide/PlaceCard.js";
import { CATALOG_SECTIONS, type CatalogSection, type GuideApi } from "./guide/types.js";
import { Health } from "./Health.js";
import { About } from "./host/About.js";
import { HostProvider, useHost, type HostEnv, type StaffRole } from "./host/context.js";
import { createHostApi } from "./host/host-api.js";
import type { HostApi } from "./host/types.js";
import { PartnerProvider, resolveSelection, usePartner } from "./partner/context.js";
import { createPartnerApi, type PartnerApi } from "./partner/partner-api.js";
import { Badge } from "./guide/parts.js";
import { statusKey } from "./partner/parts.js";
import type { Role } from "./role.js";
import {
  canScanQr,
  hasBackIntercept,
  nativeBackButton,
  scanQr,
  subscribeBackIntercept,
  type TelegramUser,
  type TelegramWebApp,
} from "./telegram.js";
import { API_URL } from "./api.js";
import { WeatherChip } from "./weather/Weather.js";
import { createWeatherApi, type WeatherApi } from "./weather/weather-api.js";

// Бронирования (блок 7, флаг module.bookings) — ленивые чанки (в первый экран не входят) с повтором при сбое загрузки.
const BookingFlow = lazyScreen(() => import("./bookings/TouristScreens.js").then((m) => m.BookingFlow));
const MyBookings = lazyScreen(() => import("./bookings/TouristScreens.js").then((m) => m.MyBookings));
// Отзывы (блок 10, флаг module.reviews): форма отзыва и кабинет партнёра P07 — тоже ленивые чанки.
const ReviewScreen = lazyScreen(() => import("./reviews/ReviewScreens.js").then((m) => m.ReviewScreen));
const PartnerReviews = lazyScreen(() => import("./reviews/PartnerReviews.js").then((m) => m.PartnerReviews));
const PartnerBookings = lazyScreen(() =>
  import("./bookings/PartnerScreens.js").then((m) => m.PartnerBookings),
);
const PartnerResources = lazyScreen(() =>
  import("./bookings/PartnerScreens.js").then((m) => m.PartnerResources),
);
// Экраны вне главной (ассистент, план, заявки, кабинет партнёра) — тоже ленивые чанки: основной бандл меньше,
// первый экран быстрее разбирается на слабых Android. Карта — своим чанком (guide/MapSlot.tsx).
const SCREEN_ERROR = "miniapp.screen.loadError";
const Assistant = lazyScreen(() => import("./assistant/Assistant.js").then((m) => m.Assistant), SCREEN_ERROR);
const MyPlan = lazyScreen(() => import("./plan/MyPlan.js").then((m) => m.MyPlan), SCREEN_ERROR);
const NewPlanScreen = lazyScreen(() => import("./plan/MyPlan.js").then((m) => m.NewPlanScreen), SCREEN_ERROR);
const SavedPlanScreen = lazyScreen(
  () => import("./plan/MyPlan.js").then((m) => m.SavedPlanScreen),
  SCREEN_ERROR,
);
const ScenarioScreen = lazyScreen(
  () => import("./plan/MyPlan.js").then((m) => m.ScenarioScreen),
  SCREEN_ERROR,
);
const MyRequests = lazyScreen(() => import("./host/Requests.js").then((m) => m.MyRequests), SCREEN_ERROR);
const StaffRequests = lazyScreen(
  () => import("./host/Requests.js").then((m) => m.StaffRequests),
  SCREEN_ERROR,
);
const PartnerDashboard = lazyScreen(
  () => import("./partner/Dashboard.js").then((m) => m.PartnerDashboard),
  SCREEN_ERROR,
);
const AcceptInvite = lazyScreen(
  () => import("./partner/Invite.js").then((m) => m.AcceptInvite),
  SCREEN_ERROR,
);
const PartnerOffers = lazyScreen(
  () => import("./partner/Offers.js").then((m) => m.PartnerOffers),
  SCREEN_ERROR,
);
const PartnerPriceList = lazyScreen(
  () => import("./partner/PriceList.js").then((m) => m.PartnerPriceList),
  SCREEN_ERROR,
);
const PartnerOnboarding = lazyScreen(
  () => import("./partner/Onboarding.js").then((m) => m.PartnerOnboarding),
  SCREEN_ERROR,
);
const PlaceEditor = lazyScreen(
  () => import("./partner/PlaceEditor.js").then((m) => m.PlaceEditor),
  SCREEN_ERROR,
);
const PartnerStaff = lazyScreen(() => import("./partner/Staff.js").then((m) => m.PartnerStaff), SCREEN_ERROR);
const ClaimPlace = lazyScreen(
  () => import("./partner/ClaimPlace.js").then((m) => m.ClaimPlace),
  SCREEN_ERROR,
);

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
  /** API ассистента (тесты подменяют); по умолчанию — поверх api. */
  assistantApi?: AssistantApi;
  /** API бронирований (блок 7; тесты подменяют); по умолчанию — поверх api. */
  bookingsApi?: BookingsApi;
  /** API отзывов (блок 10; тесты подменяют); по умолчанию — поверх api. */
  reviewsApi?: ReviewsApi;
  /** Погода (флаг module.weather; тесты подменяют); по умолчанию — GET /weather нашего api. */
  weatherApi?: WeatherApi;
};

type Session = Extract<StartupState, { status: "ready" }>;
type RoutesProps = Omit<
  AppProps,
  "startup" | "locale" | "guideApi" | "analytics" | "hostApi" | "partnerApi" | "bookingsApi" | "reviewsApi"
> & {
  session?: Session;
  onMe: (me: Me) => void;
  /** Явный повтор GET /context после сбоя (один запрос на нажатие); true — загружен. */
  retryContext: () => Promise<boolean>;
};

/**
 * Нативная BackButton: одна на приложение, видна на всех экранах, кроме главной, и на главной, пока открыт слой
 * (лист меню, «Локація», прогноз). Логика нажатия — pressBack (back.ts).
 */
function NativeBack({ webApp }: { webApp?: TelegramWebApp }) {
  const [path, navigate] = useRoute();
  const overlay = useSyncExternalStore(subscribeBackIntercept, hasBackIntercept);
  const back = nativeBackButton(webApp);
  const visible = path !== "/" || overlay;
  useEffect(() => {
    if (!back || !visible) return;
    const onClick = () => pressBack(navigate);
    back.onClick(onClick);
    back.show();
    return () => {
      back.offClick(onClick);
      back.hide();
    };
  }, [back, visible, navigate]);
  return null;
}

/** Своя кнопка «Назад» экрана: браузер и старый клиент Telegram без нативной кнопки. */
function ScreenBack({ webApp }: { webApp?: TelegramWebApp }) {
  const { t } = useT();
  const [, navigate] = useRoute();
  if (nativeBackButton(webApp)) return null;
  return <Button onClick={() => pressBack(navigate)}>{t("common.back")}</Button>;
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

/** API ассистента: из пропсов (тесты) или поверх api с регионом гида. */
function useAssistantApi(props: RoutesProps): AssistantApi {
  const { regionId } = useGuide();
  const { api, assistantApi } = props;
  return useMemo(() => assistantApi ?? createAssistantApi(api, regionId), [assistantApi, api, regionId]);
}

/**
 * «Що шукаєте?» на главной (флаг module.assistant): только с регионом и сессией (каждый запрос стоит денег, api —
 * только с входом через Telegram). Реплика ведёт на экран ассистента.
 */
function HomeAssistant(props: RoutesProps) {
  const [, navigate] = useRoute();
  const { regionId } = useGuide();
  const api = useAssistantApi(props);
  const { t } = useT();
  // Без входа или региона запрос не отправить: честная подпись вместо поля, которое не работает.
  if (!regionId || !props.session) {
    return (
      <Feature flag="module.assistant">
        <p className="modern-assistant-off" data-testid="assistant-off">
          <span aria-hidden="true">🎙️ </span>
          {t(props.session ? "miniapp.home.assistantNeedsRegion" : "miniapp.home.assistantNeedsTelegram")}
        </p>
      </Feature>
    );
  }
  return (
    <Feature flag="module.assistant">
      <AssistantBox api={api} examples onSubmit={(q) => navigate(`/assistant?q=${encodeURIComponent(q)}`)} />
    </Feature>
  );
}

/** Погода рядом с «Локація» (флаг module.weather): только регион гида; прогноза нет — ничего. */
function HomeWeather(props: RoutesProps) {
  const { regionId } = useGuide();
  const { api, weatherApi } = props;
  const wx = useMemo(
    () => weatherApi ?? createWeatherApi(api, regionId, API_URL),
    [weatherApi, api, regionId],
  );
  if (!regionId) return null;
  return (
    <Feature flag="module.weather">
      <WeatherChip api={wx} />
    </Feature>
  );
}

function Home(props: RoutesProps) {
  const { api, role, user, webApp, session, onMe, retryContext } = props;
  const { t } = useT();
  const { staff } = useHost();
  // Роль и состояние сервера — служебные: только разработка и персонал, туристу не показываем и /health не запрашиваем.
  const diagnostics = import.meta.env.DEV || staff === "yes";
  return (
    <>
      <div className="home-top-row">
        <Welcome user={user} session={session} retryContext={retryContext} />
        <div className="home-loc-row">
          <HomeWeather {...props} />
        </div>
      </div>
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
      {/* Hero с полем ассистента поверх панорамы, Bento-разделы. */}
      <HomeSections hasVenue={venueOf(session) !== null} hero={<HomeAssistant {...props} />} />
      {diagnostics && (
        <div className="kosiv-meta-block">
          <p data-testid="role">{t("miniapp.role", { role: t(`miniapp.role.${role}`) })}</p>
          <Health api={api} />
        </div>
      )}
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
      <ScreenBack webApp={webApp} />
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
    // Возврат на экран: фокус на ссылку, с которой ушли; её ещё нет (данные грузятся) — заголовок, затем ссылка.
    const target = takeReturnFocus();
    const focusLink = () => {
      if (!target) return false;
      const links = sameHrefLinks(target.href);
      const link = links[target.ordinal] ?? links[0];
      link?.focus({ preventScroll: true });
      return Boolean(link);
    };
    // Экран может перерисоваться после возврата (ответ /me, флаги) — повторы возвращают потерянный фокус.
    let heading = focusLink() || focusScreenHeading();
    const timers = [100, 300, 800, 1500, 3000].map((ms) =>
      window.setTimeout(() => {
        const active = document.activeElement;
        // Пользователь уже перешёл к другому элементу — фокус не отбираем.
        if (active && active !== document.body && active.tagName !== "H1") return;
        if (!focusLink() && !heading) heading = focusScreenHeading();
      }, ms),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [path]);
}

const PARTNER_PATH_RE =
  /^\/partner\/(place|org|claim)\/([^/]+)(\/offers|\/prices|\/staff|\/bookings|\/resources|\/reviews)?$/;

/**
 * Экраны кабинета партнёра по пути; null — путь не из кабинета (или неверный id — «не найдено»).
 * Приглашение (P14) — /partner/invite, токен только в памяти (session.invite), не в адресе.
 */
function partnerScreen(
  path: string,
  invite: string | undefined,
  bookings: boolean,
  reviews: boolean,
): ReactNode {
  if (path === "/partner") return <PartnerDashboard />;
  if (path === "/partner/new") return <PartnerOnboarding />;
  if (path === "/partner/invite") return <AcceptInvite token={invite ?? ""} />;
  const m = PARTNER_PATH_RE.exec(path);
  if (!m) return null;
  const [, kind, raw, sub] = m;
  const id = uuidOf(raw!);
  if (!id) return null;
  if (kind === "place" && !sub) return <PlaceEditor key={id} id={id} />;
  // «Це мій заклад» (0031): заявка на место каталога из его карточки.
  if (kind === "claim" && !sub) return <ClaimPlace key={id} placeId={id} />;
  if (kind === "place" && sub === "/offers") return <PartnerOffers key={id} placeId={id} />;
  if (kind === "place" && sub === "/prices") return <PartnerPriceList key={id} placeId={id} />;
  if (kind === "org" && sub === "/staff") return <PartnerStaff key={id} orgId={id} />;
  if (bookings && kind === "place" && sub === "/bookings") return <PartnerBookings key={id} placeId={id} />;
  if (bookings && kind === "place" && sub === "/resources") return <PartnerResources key={id} placeId={id} />;
  if (reviews && kind === "place" && sub === "/reviews") return <PartnerReviews key={id} placeId={id} />;
  return null;
}

/**
 * C15 → P13/P12: карточка в профиле. Партнёру — «Мій заклад» с тем заведением, что откроет кабинет (сохранённый
 * выбор), иначе «Стати партнером». Пока /partner/me грузится — пусто; сбой — ссылка в кабинет, а не онбординг.
 */
function PartnerEntry() {
  const { t, locale } = useT();
  const { me, selection } = usePartner();
  if (me.status === "loading") return null;
  const orgs = me.status === "ready" ? me.data.organizations : [];
  const { place } = resolveSelection(orgs, selection);
  return (
    <div className="kosiv-card kosiv-panel" data-testid="partner-entry">
      {me.status === "error" ? (
        <Link to="/partner" className="kosiv-cta" data-testid="partner-link">
          {t("miniapp.partner.entry.retry")}
        </Link>
      ) : orgs.length ? (
        <>
          {place && (
            <p style={{ margin: 0 }}>
              <strong>{pickLocalized(place.name, locale)}</strong>{" "}
              <Badge testId="partner-entry-status">{t(statusKey(place.status))}</Badge>
            </p>
          )}
          <Link to="/partner" className="kosiv-cta" data-testid="partner-link">
            {t("miniapp.partner.open")}
          </Link>
        </>
      ) : (
        <>
          <h2>{t("miniapp.partner.entry.title")}</h2>
          <Link to="/partner/new" className="kosiv-cta">
            {t("miniapp.partner.become")}
          </Link>
        </>
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
  const assistantOn = useFeatureFlag("module.assistant");
  const bookingsOn = useFeatureFlag("module.bookings");
  const reviewsOn = useFeatureFlag("module.reviews");
  const assistantApi = useAssistantApi(props);
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
    // claim=1 — из анкеты партнёра: выбор своего заведения ведёт сразу к заявке (#/partner/claim/{id}).
    const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const q = params.get("q") ?? "";
    // Без модуля партнёра или сессии заявка недоступна — обычный поиск.
    const claim = params.get("claim") === "1" && partnerCabinet && Boolean(session);
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <PlaceSearch key={`${q}|${claim}`} initialQuery={q.slice(0, 100)} claim={claim} />
        </RequireRegion>
      </Screen>
    );
  }
  if (path === "/assistant" && assistantOn && session) {
    const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("q") ?? "";
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <Assistant api={assistantApi} initialQuery={q.slice(0, 300)} />
        </RequireRegion>
      </Screen>
    );
  }
  const bookPlace = bookingsOn ? /^\/book\/([^/]+)$/.exec(path)?.[1] : undefined;
  if (bookPlace !== undefined) {
    const id = uuidOf(bookPlace);
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          {id ? <BookingFlow key={id} placeId={id} /> : <p role="alert">{t("common.notFound")}</p>}
        </RequireRegion>
      </Screen>
    );
  }
  if (bookingsOn && path === "/bookings")
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <MyBookings />
        </RequireRegion>
      </Screen>
    );
  const reviewEligibility = reviewsOn ? /^\/review\/([^/]+)$/.exec(path)?.[1] : undefined;
  if (reviewEligibility !== undefined) {
    const id = uuidOf(reviewEligibility);
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          {id ? <ReviewScreen key={id} eligibilityId={id} /> : <p role="alert">{t("common.notFound")}</p>}
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
  if (path === "/peaks")
    return (
      <Screen webApp={webApp}>
        <RequireRegion>
          <Peaks />
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
        <Feature flag="module.bookings">
          <Link to="/bookings" className="kosiv-cta" data-testid="my-bookings-link">
            {t("miniapp.booking.mine")}
          </Link>
        </Feature>
        <Feature flag="module.partner_cabinet">
          <PartnerEntry />
        </Feature>
      </Screen>
    );
  }
  // Кабинет партнёра (модуль блока 6) при выключенном флаге — как несуществующий путь (T1-22).
  const partner = partnerCabinet ? partnerScreen(path, session?.invite, bookingsOn, reviewsOn) : null;
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
function Shell({
  routes,
  profile,
  scan,
  webApp,
}: {
  routes: ReactNode;
  profile: boolean;
  webApp?: TelegramWebApp;
  /** Сканер QR (нет — кнопки не показываются). */
  scan?: (prompt: string, isCurrent: () => boolean) => Promise<ScanOutcome | null>;
}) {
  const [path, navigate] = useRoute();
  // Защита от двойного нажатия (синхронно, до перерисовки). Повторный запуск позже — разрешён:
  // на старых клиентах закрытие сканера не сообщается, и новый запуск завершает прежний.
  const lastScanAt = useRef(0);
  const scanRun = useRef(0);
  const [scanMessage, setScanMessage] = useState<MessageKey | null>(null);
  const { t } = useT();
  // Сообщение о скане: скрыть через ~6 с и при смене маршрута.
  useEffect(() => {
    if (!scanMessage) return;
    const id = setTimeout(() => setScanMessage(null), 6000);
    return () => clearTimeout(id);
  }, [scanMessage]);
  useEffect(() => setScanMessage(null), [path]);
  const scanControl: ScanControl | undefined = scan
    ? {
        message: scanMessage,
        start: () => {
          const now = Date.now();
          if (now - lastScanAt.current < 1000) return;
          lastScanAt.current = now;
          const run = ++scanRun.current;
          setScanMessage(null);
          void scan(t("miniapp.scan.prompt"), () => run === scanRun.current)
            .then((o) => {
              if (!o || run !== scanRun.current) return;
              if (o.kind === "message") setScanMessage(o.messageKey);
              else if (o.kind === "invite") navigate("/partner/invite", { replace: true });
              else
                navigate(o.context.entryType === "hotel" && o.context.venue ? "/about" : "/", {
                  replace: true,
                });
            })
            .catch(() => undefined);
        },
      }
    : undefined;
  // Экран на корне документа: фон страницы и верхняя полоса зависят от него (modern.css), body — вне дерева React.
  const screen = path === "/" ? "home" : path === "/nearby" || path === "/nearby/me" ? "nearby" : "inner";
  useLayoutEffect(() => {
    document.documentElement.dataset.screen = screen;
    return () => {
      delete document.documentElement.dataset.screen;
    };
  }, [screen]);
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
      <AppBackdrop />
      <NativeBack webApp={webApp} />
      <AppTop
        path={path}
        profile={profile}
        scan={scanControl}
        location={path === "/" ? <LocationChip /> : undefined}
      />
      <div className="kosiv-content" ref={content}>
        {routes}
      </div>
      <BottomNav profile={profile} />
      <LocationSheetHost path={path} />
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
  bookingsApi,
  reviewsApi,
  ...props
}: AppProps) {
  const { webApp } = props;
  // Учёт истории — с первого рендера: адрес входа (прямая ссылка, QR) становится первой записью.
  useState(initNavigation);
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
      weather: props.weatherApi ?? createWeatherApi(props.api, regionId, API_URL),
    }),
    [
      api,
      tracker,
      props.webApp,
      venueName,
      basePoint,
      basePending,
      regionId,
      signedIn,
      props.weatherApi,
      props.api,
    ],
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
  const bookings = useMemo<BookingsEnv>(
    () => ({
      api: bookingsApi ?? createBookingsApi(props.api),
      timeZone: context?.region?.timezone ?? "Europe/Kyiv",
      entryContextId: context?.entryContextId ?? null,
    }),
    [bookingsApi, props.api, context?.region?.timezone, context?.entryContextId],
  );
  const reviews = useMemo<ReviewsEnv>(
    () => ({ api: reviewsApi ?? createReviewsApi(props.api) }),
    [reviewsApi, props.api],
  );
  const partnerEnabled = Boolean(session) && flags?.["module.partner_cabinet"] === true;
  // Скан QR из приложения: тот же контекст, что при входе по QR, без перезапуска (регион, заведение, приглашение).
  const scanHandler =
    session && canScanQr(webApp)
      ? async (prompt: string, isCurrent: () => boolean): Promise<ScanOutcome | null> => {
          const text = await scanQr(webApp, prompt);
          if (text === null) return null;
          const outcome = await resolveScan(props.api, text);
          // Поздний ответ прежнего скана не перетирает результат нового.
          if (!isCurrent()) return null;
          if (outcome.kind === "context")
            setState((s) =>
              s.status === "ready" ? { ...s, context: outcome.context, contextFailed: undefined } : s,
            );
          else if (outcome.kind === "invite") {
            // Кабинет партнёра выключен — токен не сохраняем, только сообщение.
            if (!partnerEnabled) return { kind: "message", messageKey: "miniapp.scan.foreign" };
            setState((s) => (s.status === "ready" ? { ...s, invite: outcome.token } : s));
          }
          return outcome;
        }
      : undefined;
  return (
    <I18nProvider locale={effectiveLocale}>
      <FeatureFlagsProvider flags={flags}>
        <ThemeStyle />
        <ThemeProvider>
          <SeasonProvider webApp={webApp}>
            <main className="kosiv-shell" lang={effectiveLocale}>
              {state.status === "loading" || state.status === "error" ? (
                <StartupStatus state={state} />
              ) : (
                <GuideProvider value={guide}>
                  <LocationProvider
                    venueEntry={venue !== null}
                    entryKey={context?.entryContextId ?? undefined}
                  >
                    <HostProvider value={host}>
                      <PartnerProvider api={pApi} regionId={regionId} enabled={partnerEnabled}>
                        <BookingsProvider value={bookings}>
                          <ReviewsProvider value={reviews}>
                            <Shell
                              profile={Boolean(session && hasRequiredConsents(session.me))}
                              scan={scanHandler}
                              webApp={webApp}
                              routes={
                                // Диалог ассистента — выше маршрутов: «Назад» из карточки места возвращает его как был.
                                <AssistantSessionProvider>
                                  <Routes
                                    {...props}
                                    session={session}
                                    onMe={onMe}
                                    retryContext={retryContext}
                                  />
                                </AssistantSessionProvider>
                              }
                            />
                          </ReviewsProvider>
                        </BookingsProvider>
                      </PartnerProvider>
                    </HostProvider>
                  </LocationProvider>
                </GuideProvider>
              )}
            </main>
          </SeasonProvider>
        </ThemeProvider>
      </FeatureFlagsProvider>
    </I18nProvider>
  );
}
