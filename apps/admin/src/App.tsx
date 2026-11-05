// Web-админка (блок 3): вход, выбор региона (SUPERADMIN), боковое меню и экраны каталога, QR, контактов, журнала.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import "@tg/i18n/admin";
import { DEFAULT_LOCALE, type Locale, type MessageKey } from "@tg/i18n";
import {
  FeatureFlagsProvider,
  I18nProvider,
  Link,
  Stack,
  ThemeStyle,
  useRoute,
  useT,
  type FeatureFlags,
} from "@tg/ui";
import {
  call,
  createAdminApi,
  getToken,
  needsRegionChoice,
  setToken,
  setUnauthorizedHandler,
  type ApiClient,
  type ApiError,
  type Session,
} from "./api.js";
import { AuditScreen } from "./Audit.js";
import { EmergencyScreen, LocalitiesScreen, TaxonomyScreen } from "./Dictionaries.js";
import { Login } from "./Login.js";
import { ModerationScreen } from "./Moderation.js";
import { PlaceEditorScreen } from "./PlaceEditor.js";
import { PlacesScreen } from "./Places.js";
import { QrPrintScreen, QrScreen } from "./Qr.js";
import { RegionScreen } from "./Region.js";
import { ReviewsScreen } from "./Reviews.js";
import { ScenariosScreen } from "./Scenarios.js";
import { AdminContext, ErrorBox, inputStyle, SmallButton, useAdmin, useLoad, useLocalized } from "./ui.js";

/**
 * Раздел меню: путь → ключ заголовка; `flag` — фича-флаг модуля (T1-22): пока он выключен, раздела нет в меню и
 * по пути. Первый видимый — раздел по умолчанию («/»).
 */
export type Section = { path: string; title: MessageKey; flag?: string };

export const SECTIONS: readonly Section[] = [
  { path: "/region", title: "admin.region" },
  { path: "/localities", title: "admin.localities" },
  { path: "/taxonomy", title: "admin.taxonomy" },
  { path: "/places", title: "admin.places" },
  { path: "/moderation", title: "admin.moderation" },
  { path: "/reviews", title: "admin.reviews" },
  { path: "/qr", title: "admin.qr" },
  { path: "/scenarios", title: "admin.scenarios" },
  { path: "/emergency", title: "admin.emergency" },
  { path: "/audit", title: "admin.audit" },
];

/** Экран раздела; вложенные пути (`/places/<id>`, `/qr/<id>/print`) разбирает сам раздел. */
function screenFor(section: string, rest: string[]): ReactNode {
  switch (section) {
    case "/region":
      return <RegionScreen />;
    case "/localities":
      return <LocalitiesScreen />;
    case "/taxonomy":
      return <TaxonomyScreen />;
    case "/places":
      return rest.length ? <PlaceEditorScreen id={rest[0] === "new" ? null : rest[0]!} /> : <PlacesScreen />;
    case "/moderation":
      return <ModerationScreen id={rest[0]} sub={rest[1]} />;
    case "/reviews":
      return <ReviewsScreen />;
    case "/qr":
      return rest[1] === "print" && rest[0] ? <QrPrintScreen id={rest[0]} /> : <QrScreen />;
    case "/scenarios":
      return <ScenariosScreen id={rest[0]} />;
    case "/emergency":
      return <EmergencyScreen />;
    case "/audit":
      return <AuditScreen />;
    default:
      return <p>{/* раздел модуля за флагом — экран появится с модулем */}</p>;
  }
}

const layoutStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "240px 1fr",
  minHeight: "100vh",
};

const asideStyle: CSSProperties = {
  background: "var(--color-surface)",
  padding: "calc(var(--space) * 3)",
};

// Печать QR: только сам код, без меню и кнопок.
const PRINT_CSS = "@media print{aside,.no-print{display:none!important}main{padding:0!important}}";

/** Разделы, видимые при этих флагах: без флага — всегда, с флагом — только включённым. */
export function visibleSections(sections: readonly Section[], flags: FeatureFlags | undefined): Section[] {
  return sections.filter((s) => s.flag === undefined || (flags !== undefined && flags[s.flag] === true));
}

/** Выбор региона сессии (SUPERADMIN и админ нескольких регионов): PUT /auth/session/region. */
function RegionPicker() {
  const { api, session, setSession } = useAdmin();
  const { t } = useT();
  const l = useLocalized();
  const [regions] = useLoad(() => call(api.GET("/admin/regions")), [session.activeRegionId]);
  const [draft, setDraft] = useState(session.activeRegionId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  // Применяется по кнопке: одна PUT за раз, не на каждый выбор в списке.
  const apply = async () => {
    if (busy) return;
    setBusy(true);
    const res = await call(api.PUT("/auth/session/region", { body: { regionId: draft || null } }));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    setSession(res.data);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
    >
      <Stack gap={1}>
        <label htmlFor="region-picker">{t("admin.region.current")}</label>
        <select
          id="region-picker"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={inputStyle}
        >
          <option value="">{t("admin.region.platform")}</option>
          {(regions?.ok ? regions.data.items : []).map((r) => (
            <option key={r.id} value={r.id}>
              {l(r.name)}
            </option>
          ))}
        </select>
        <div>
          <SmallButton type="submit" disabled={busy || draft === (session.activeRegionId ?? "")}>
            {t("admin.apply")}
          </SmallButton>
        </div>
        <ErrorBox error={error} />
      </Stack>
    </form>
  );
}

function Layout({ sections, onLogout }: { sections: readonly Section[]; onLogout: () => void }) {
  const { t } = useT();
  const { session } = useAdmin();
  const [path] = useRoute();
  const parts = path.split("/").filter(Boolean);
  const base = `/${parts[0] ?? ""}`;
  const current = path === "/" ? sections[0] : sections.find((s) => s.path === base);
  const chooseRegion = needsRegionChoice(session) && !session.activeRegionId;
  return (
    <div style={layoutStyle}>
      <style>{PRINT_CSS}</style>
      <aside style={asideStyle}>
        <Stack>
          <p style={{ fontWeight: 700, margin: 0 }}>
            {t("app.name")} · {t("admin.title")}
          </p>
          {needsRegionChoice(session) && <RegionPicker />}
          <nav aria-label={t("admin.nav")}>
            <Stack gap={1}>
              {sections.map((s) => (
                <Link key={s.path} to={s.path} aria-current={s === current ? "page" : undefined}>
                  {t(s.title)}
                </Link>
              ))}
            </Stack>
          </nav>
          <div>
            <SmallButton onClick={onLogout}>{t("admin.logout")}</SmallButton>
          </div>
        </Stack>
      </aside>
      <main style={{ padding: "calc(var(--space) * 3)" }} key={session.activeRegionId ?? "platform"}>
        <h1 className="no-print">{current ? t(current.title) : t("common.notFound")}</h1>
        {chooseRegion && current && (
          <p role="note" className="no-print">
            {t("admin.region.choose")}
          </p>
        )}
        {current ? (
          screenFor(current.path, path === "/" ? [] : parts.slice(1))
        ) : (
          <p>
            <Link to="/">{t("common.toHome")}</Link>
          </p>
        )}
      </main>
    </div>
  );
}

function Shell({ api, sections }: { api: ApiClient; sections: readonly Section[] }) {
  const { t } = useT();
  // undefined — проверяем сохранённый токен; null — нужен вход.
  const [session, setSession] = useState<Session | null | undefined>(() => (getToken() ? undefined : null));
  const [startError, setStartError] = useState<ApiError | null>(null);
  const [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (session !== undefined) return;
    let alive = true;
    void call(api.GET("/auth/session")).then((res) => {
      if (!alive) return;
      if (res.ok) return setSession(res.data);
      // Токен недействителен только при 401; сеть/5xx — ошибка и «Повторити», токен остаётся.
      if (res.error.status === 401) {
        setToken(null);
        setSession(null);
      } else setStartError(res.error);
    });
    return () => {
      alive = false;
    };
  }, [api, session, attempt]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setExpired(true);
      setSession(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const ctx = useMemo(
    () => (session ? { api, session, setSession: (s: Session) => setSession(s) } : null),
    [api, session],
  );
  if (session === undefined)
    return startError ? (
      <main style={{ padding: 24 }}>
        <Stack gap={2}>
          <ErrorBox error={startError} />
          <div>
            <SmallButton
              onClick={() => {
                setStartError(null);
                setAttempt((n) => n + 1);
              }}
            >
              {t("admin.retry")}
            </SmallButton>
          </div>
        </Stack>
      </main>
    ) : (
      <p role="status">{t("admin.loading")}</p>
    );
  if (!ctx)
    return (
      <Login
        api={api}
        notice={expired ? t("admin.sessionExpired") : null}
        onLogin={(s) => {
          setExpired(false);
          setSession(s);
        }}
      />
    );
  const logout = () => {
    void call(api.POST("/auth/admin/logout"));
    setToken(null);
    setSession(null);
  };
  return (
    <AdminContext.Provider value={ctx}>
      <Layout sections={sections} onLogout={logout} />
    </AdminContext.Provider>
  );
}

export type AppProps = {
  locale?: Locale;
  /** Разделы меню (по умолчанию SECTIONS). */
  sections?: readonly Section[];
  /** Эффективные фича-флаги (GET /feature-flags). */
  flags?: FeatureFlags;
  /** Клиент API (тесты подставляют свой). */
  api?: ApiClient;
};

const defaultApi = createAdminApi();

export function App({ locale = DEFAULT_LOCALE, sections = SECTIONS, flags, api = defaultApi }: AppProps) {
  return (
    <I18nProvider locale={locale}>
      <FeatureFlagsProvider flags={flags}>
        <ThemeStyle />
        <Shell api={api} sections={visibleSections(sections, flags)} />
      </FeatureFlagsProvider>
    </I18nProvider>
  );
}
