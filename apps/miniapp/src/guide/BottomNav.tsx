// Нижняя навигация (ТЗ §4, ярус 4): Головна | Поруч | Мій план | Обране, а при профиле — Профіль вместо Обране
// (тогда «Обране» — плитка на главной и пункт меню). «Мій план» — только при module.host_requests.
import { Link, useFeatureFlag, useRoute, useT } from "@tg/ui";

export function BottomNav({ profile = false }: { profile?: boolean }) {
  const { t } = useT();
  const items = [
    { to: "/", key: "miniapp.nav.home", icon: "🔥" },
    { to: "/nearby", key: "miniapp.modern.nearby", icon: "🧭" },
    { to: "/plan", key: "miniapp.nav.plan", icon: "✨" },
    profile
      ? ({ to: "/profile", key: "miniapp.nav.profile", icon: "👤" } as const)
      : ({ to: "/favorites", key: "miniapp.nav.favorites", icon: "❤️" } as const),
  ] as const;
  const [path] = useRoute();
  const plan = useFeatureFlag("module.host_requests");
  const active = (to: string) => path === to || (to !== "/" && path.startsWith(`${to}/`));
  return (
    <nav aria-label={t("miniapp.nav.label")} className="kosiv-nav" data-testid="bottom-nav">
      {items
        .filter((i) => plan || i.to !== "/plan")
        .map((i) => (
          <Link
            key={i.to}
            to={i.to}
            className="kosiv-nav-item"
            aria-current={active(i.to) ? "page" : undefined}
          >
            <span className="kosiv-nav-icon" aria-hidden="true">
              {i.icon}
            </span>
            <span>{t(i.key)}</span>
          </Link>
        ))}
    </nav>
  );
}
