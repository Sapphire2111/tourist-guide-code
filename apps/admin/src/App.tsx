// Каркас админки: desktop-first, боковое меню + разделы-заглушки.
// TODO(T1-26): вход и проверка прав (RBAC); сейчас разделы открыты без авторизации.
import type { CSSProperties } from "react";
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

/**
 * Раздел меню: путь → ключ заголовка; `flag` — фича-флаг модуля (T1-22): пока он выключен, раздела нет в меню и
 * по пути. Первый видимый — раздел по умолчанию («/»).
 */
export type Section = { path: string; title: MessageKey; flag?: string };

export const SECTIONS: readonly Section[] = [
  { path: "/regions", title: "admin.regions" },
  { path: "/audit", title: "admin.audit" },
  { path: "/users", title: "admin.users" },
];

const layoutStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "240px 1fr",
  minHeight: "100vh",
};

const asideStyle: CSSProperties = {
  background: "var(--color-surface)",
  padding: "calc(var(--space) * 3)",
};

/** Разделы, видимые при этих флагах: без флага — всегда, с флагом — только включённым. */
export function visibleSections(sections: readonly Section[], flags: FeatureFlags | undefined): Section[] {
  return sections.filter((s) => s.flag === undefined || (flags !== undefined && flags[s.flag] === true));
}

function Layout({ sections }: { sections: readonly Section[] }) {
  const { t } = useT();
  const [path] = useRoute();
  const current = path === "/" ? sections[0] : sections.find((s) => s.path === path);
  return (
    <div style={layoutStyle}>
      <aside style={asideStyle}>
        <Stack>
          <p style={{ fontWeight: 700, margin: 0 }}>
            {t("app.name")} · {t("admin.title")}
          </p>
          <nav aria-label={t("admin.nav")}>
            <Stack gap={1}>
              {sections.map((s) => (
                <Link key={s.path} to={s.path} aria-current={s === current ? "page" : undefined}>
                  {t(s.title)}
                </Link>
              ))}
            </Stack>
          </nav>
        </Stack>
      </aside>
      <main style={{ padding: "calc(var(--space) * 3)" }}>
        <h1>{current ? t(current.title) : t("common.notFound")}</h1>
        <p>{current ? t("common.stub") : <Link to="/">{t("common.toHome")}</Link>}</p>
      </main>
    </div>
  );
}

export type AppProps = {
  locale?: Locale;
  /** Разделы меню (по умолчанию SECTIONS). */
  sections?: readonly Section[];
  /** Эффективные фича-флаги (GET /feature-flags); загрузка — с клиентом API админки (блок 6). */
  flags?: FeatureFlags;
};

export function App({ locale = DEFAULT_LOCALE, sections = SECTIONS, flags }: AppProps) {
  return (
    <I18nProvider locale={locale}>
      <FeatureFlagsProvider flags={flags}>
        <ThemeStyle />
        <Layout sections={visibleSections(sections, flags)} />
      </FeatureFlagsProvider>
    </I18nProvider>
  );
}
