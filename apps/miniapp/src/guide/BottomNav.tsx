// Нижня навігація в стилі Концепту Б «Мольфарська Ватра»: Ватра (🔥) | Поруч (🧭) | План (✨) | Профіль (👤).
import { Link, useFeatureFlag, useRoute, useT } from "@tg/ui";

export function BottomNav({ profile = false }: { profile?: boolean }) {
  const { t } = useT();
  const items = [
    { to: "/", key: "miniapp.nav.home", short: "Ватра", icon: "🔥" },
    { to: "/nearby", key: "miniapp.modern.nearby", short: "Поруч", icon: "🧭" },
    { to: "/plan", key: "miniapp.nav.plan", short: "План", icon: "✨" },
    profile
      ? ({ to: "/profile", key: "miniapp.nav.profile", short: "Профіль", icon: "👤" } as const)
      : ({ to: "/favorites", key: "miniapp.nav.favorites", short: "Профіль", icon: "👤" } as const),
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
            aria-label={t(i.key)}
            aria-current={active(i.to) ? "page" : undefined}
          >
            <span className="kosiv-nav-icon" aria-hidden="true">
              {i.icon}
            </span>
            <span aria-hidden="true">{i.short}</span>
          </Link>
        ))}
    </nav>
  );
}
