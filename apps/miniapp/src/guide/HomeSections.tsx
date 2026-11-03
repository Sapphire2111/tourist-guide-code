// C02: Hero с панорамой (заголовок, поле ассистента, сезонные теги, карточка заведения поверх гор), Bento из 4 разделов,
// «Що поруч зі мною зараз» и служебные разделы. «Про заклад» — только при QR заведения (C-13).
import type { ReactNode } from "react";
import { Link, useT } from "@tg/ui";
import { HeroPanorama } from "../design/HeroPanorama.js";
import { ICONS } from "../design/Ornament.js";
import { useGuide } from "./context.js";
import type { HomeSection } from "./types.js";

export function sectionPath(section: HomeSection): string {
  if (section === "about") return "/about";
  if (section === "nearby") return "/nearby";
  if (section === "help") return "/help";
  return `/section/${section}`;
}

export function HomeSections({ hasVenue, hero }: { hasVenue: boolean; hero?: ReactNode }) {
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
      <div className="modern-hero" data-testid="modern-hero">
        <HeroPanorama />
        <div className="modern-hero-head">
          <h2 id="sections-title">{t("miniapp.modern.title")}</h2>
          <p>{t("miniapp.modern.subtitle")}</p>
        </div>
        {hero && <div className="modern-hero-glass">{hero}</div>}
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
      </div>
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
            {section === "stay" && (
              <small data-testid="tile-hint-stay">{t("miniapp.section.stayHint")}</small>
            )}
          </Link>
        ))}
      </nav>
    </section>
  );
}
