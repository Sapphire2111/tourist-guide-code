// C02: 8 кнопок разделов главной + «Що поруч зі мною зараз». «Про заклад» — только при QR заведения (C-13).
import type { CSSProperties } from "react";
import { Link, useT } from "@tg/ui";
import type { MessageKey } from "@tg/i18n";
import { HOME_SECTIONS, type HomeSection } from "./types.js";

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "var(--space)",
  listStyle: "none",
  margin: 0,
  padding: 0,
};

/** Плитка-ссылка: цвета кнопки темы, крупный жирный текст (AA для large text). */
export const tile: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 64,
  padding: "8px 12px",
  borderRadius: "var(--radius)",
  background: "var(--color-button)",
  color: "var(--color-button-text)",
  fontSize: "1.2rem",
  fontWeight: 700,
  textAlign: "center",
  textDecoration: "none",
};

export function sectionPath(section: HomeSection): string {
  if (section === "about") return "/about";
  if (section === "nearby") return "/nearby";
  if (section === "help") return "/help";
  return `/section/${section}`;
}

export function HomeSections({ hasVenue }: { hasVenue: boolean }) {
  const { t } = useT();
  const sections = HOME_SECTIONS.filter((s) => s !== "about" || hasVenue);
  return (
    <nav aria-labelledby="sections-title">
      <h2 id="sections-title" style={{ fontSize: "1.1rem" }}>
        {t("miniapp.home.sections")}
      </h2>
      <Link to="/nearby/me" style={{ ...tile, marginBottom: "var(--space)" }} data-testid="near-me">
        {t("miniapp.home.nearMe")}
      </Link>
      <ul style={grid} data-testid="home-sections">
        {sections.map((s) => (
          <li key={s}>
            <Link to={sectionPath(s)} style={tile}>
              {t(`miniapp.section.${s}` as MessageKey)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
