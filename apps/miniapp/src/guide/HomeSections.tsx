// C02: 8 кнопок разделов главной + «Що поруч зі мною зараз». «Про заклад» — только при QR заведения (C-13).
import { Link, useT } from "@tg/ui";
import type { MessageKey } from "@tg/i18n";
import { ICONS } from "../design/Ornament.js";
import { HOME_SECTIONS, type HomeSection } from "./types.js";

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
    <nav aria-labelledby="sections-title" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 id="sections-title" style={{ margin: 0 }}>
        {t("miniapp.home.sections")}
      </h2>
      <Link to="/nearby/me" className="kosiv-cta" data-testid="near-me">
        {ICONS.locate}
        <span>{t("miniapp.home.nearMe")}</span>
      </Link>
      <ul className="kosiv-sections" data-testid="home-sections">
        {sections.map((s) => (
          <li key={s}>
            <Link
              to={sectionPath(s)}
              className="kosiv-card kosiv-tile"
              data-tone={s === "help" ? "alert" : undefined}
            >
              <span className="kosiv-tile-icon">{ICONS[s]}</span>
              <span>{t(`miniapp.section.${s}` as MessageKey)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
