// C02: кнопки разделов главной (HOME_SECTIONS) + «Що поруч зі мною зараз». «Про заклад» — только при QR заведения (C-13).
import { Link, useT } from "@tg/ui";
import type { MessageKey } from "@tg/i18n";
import { ICONS } from "../design/Ornament.js";
import { useDesign } from "../design/DesignProvider.js";
import { useGuide } from "./context.js";
import { HOME_SECTIONS, type HomeSection } from "./types.js";

export function sectionPath(section: HomeSection): string {
  if (section === "about") return "/about";
  if (section === "nearby") return "/nearby";
  if (section === "help") return "/help";
  return `/section/${section}`;
}

export function HomeSections({ hasVenue }: { hasVenue: boolean }) {
  const { t } = useT();
  const { design } = useDesign();
  if (design === "modern") return <ModernSections hasVenue={hasVenue} />;
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
              {s === "stay" && (
                <small className="kosiv-tile-hint" data-testid="tile-hint-stay">
                  {t("miniapp.section.stayHint")}
                </small>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ModernSections({ hasVenue }: { hasVenue: boolean }) {
  const { t } = useT();
  const { base } = useGuide();
  const intentions = [
    { section: "eat", key: "miniapp.modern.eat" },
    { section: "nearby", key: "miniapp.modern.explore" },
    { section: "relax", key: "miniapp.modern.relax" },
    { section: "fun", key: "miniapp.modern.fun" },
  ] as const;
  return (
    <section className="modern-home" aria-labelledby="sections-title">
      <div className="modern-intro">
        <div>
          <h2 id="sections-title">{t("miniapp.modern.title")}</h2>
          <p>{t("miniapp.modern.subtitle")}</p>
        </div>
        <svg className="modern-mountains" viewBox="0 0 160 100" fill="none" aria-hidden="true">
          <path
            d="M4 83 55 20 89 62 111 36 157 84"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <path d="m37 43 18-23 17 22-12-5-7 9-7-8Z" fill="currentColor" opacity=".14" />
          <path
            d="m89 88 13-25h-8l15-25 15 25h-8l13 25M109 88v10M130 95l10-20h-6l11-19 11 19h-6l10 20"
            stroke="#456044"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {hasVenue && (
        <Link to="/about" className="modern-host">
          <span className="modern-host-icon">{ICONS.stay}</span>
          <span>
            <small>{t("miniapp.modern.hotelNote")}</small>
            <strong>{base?.name ?? t("miniapp.modern.hotel")}</strong>
          </span>
          <span className="modern-host-link">
            {t("miniapp.modern.hotel")}
            {ICONS.arrow}
          </span>
        </Link>
      )}
      <nav aria-labelledby="sections-title">
        <ul className="modern-intentions" data-testid="home-sections">
          {intentions.map(({ section, key }) => (
            <li key={section}>
              <Link to={sectionPath(section)} className="modern-intention" data-kind={section}>
                {ICONS[section]}
                <span>{t(key)}</span>
                {ICONS.arrow}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Link to="/nearby/me" className="modern-location-action" data-testid="near-me">
        {ICONS.locate}
        {t("miniapp.home.nearMe")}
        {ICONS.arrow}
      </Link>
      <nav aria-label={t("miniapp.modern.more")} className="modern-utilities">
        {(["transfer", "shop", "help", "stay", "ski", "services"] as const).map((section) => (
          <Link key={section} to={sectionPath(section)}>
            {ICONS[section]}
            <span>{section === "help" ? t("miniapp.modern.help") : t(`miniapp.section.${section}`)}</span>
          </Link>
        ))}
      </nav>
    </section>
  );
}
