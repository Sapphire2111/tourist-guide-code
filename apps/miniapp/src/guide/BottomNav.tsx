// Нижняя навигация (C02, дизайн «Сучасна Косівщина» — 4 вкладки): Головна | Мій план | Обране | Халепа?.
// Профіль — кнопка в шапке (AppTop). «Мій план» — только при module.host_requests. «Бонуси» — блок 9.
import { Link, useFeatureFlag, useRoute, useT } from "@tg/ui";
import { useDesign } from "../design/DesignProvider.js";
import { ICONS } from "../design/Ornament.js";

const ITEMS = [
  { to: "/", key: "miniapp.nav.home", icon: ICONS.home },
  { to: "/plan", key: "miniapp.nav.plan", icon: ICONS.plan },
  { to: "/favorites", key: "miniapp.nav.favorites", icon: ICONS.heart },
  { to: "/help", key: "miniapp.nav.help", icon: ICONS.sos },
] as const;

export function BottomNav({ profile = false }: { profile?: boolean }) {
  const { t } = useT();
  const { design } = useDesign();
  const items =
    design === "modern"
      ? ([
          ITEMS[0],
          { to: "/nearby", key: "miniapp.modern.nearby", icon: ICONS.nearby },
          ITEMS[1],
          profile ? ({ to: "/profile", key: "miniapp.nav.profile", icon: ICONS.user } as const) : ITEMS[2],
        ] as const)
      : ITEMS;
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
            <span className="kosiv-nav-icon">{i.icon}</span>
            <span>{t(i.key)}</span>
          </Link>
        ))}
    </nav>
  );
}
