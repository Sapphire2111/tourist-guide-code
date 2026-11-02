// Нижняя навигация (C02): Головна | Мій план | Обране | Халепа? | Профіль. «Бонуси» — блок 9.
import type { CSSProperties } from "react";
import { Link, useRoute, useT } from "@tg/ui";

/** Высота панели без safe area — столько же отступа снизу резервирует оболочка. */
export const BOTTOM_NAV_HEIGHT = 64;

const bar: CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  background: "var(--color-surface)",
  borderTop: "1px solid var(--color-hint)",
  paddingBottom: "var(--tg-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
  paddingLeft: "var(--tg-safe-area-inset-left, env(safe-area-inset-left, 0px))",
  paddingRight: "var(--tg-safe-area-inset-right, env(safe-area-inset-right, 0px))",
  zIndex: 1000,
};

const item = (active: boolean): CSSProperties => ({
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: BOTTOM_NAV_HEIGHT,
  color: "var(--color-text)",
  fontWeight: active ? 700 : 500,
  textDecoration: active ? "underline" : "none",
  textAlign: "center",
});

const ITEMS = [
  { to: "/", key: "miniapp.nav.home" },
  { to: "/plan", key: "miniapp.nav.plan" },
  { to: "/favorites", key: "miniapp.nav.favorites" },
  { to: "/help", key: "miniapp.nav.help" },
  { to: "/profile", key: "miniapp.nav.profile" },
] as const;

export function BottomNav({ profile }: { profile: boolean }) {
  const { t } = useT();
  const [path] = useRoute();
  const active = (to: string) => path === to || (to !== "/" && path.startsWith(`${to}/`));
  return (
    <nav aria-label={t("miniapp.nav.label")} style={bar} data-testid="bottom-nav">
      {ITEMS.filter((i) => profile || i.to !== "/profile").map((i) => (
        <Link
          key={i.to}
          to={i.to}
          style={item(active(i.to))}
          aria-current={active(i.to) ? "page" : undefined}
        >
          {t(i.key)}
        </Link>
      ))}
    </nav>
  );
}
