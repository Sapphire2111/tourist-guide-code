// C02: Hero с панорамой (заголовок, поле ассистента, сезонные теги, карточка заведения поверх гор), кнопка «Що поруч зі мною зараз» и сетка из восьми разделов. «Про заклад» — только при QR заведения (C-13).
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
  // Одна сетка 2×4 одинаковых плиток; тон — шахматным порядком (тёмные: кофейный и изумрудный, светлые: крем и мята).
  // «Допомога» — кнопка со щитом в верхней полосе (Chrome.tsx), не плитка.
  const tiles = [
    { section: "stay", label: t("miniapp.section.stay"), tone: "emerald" },
    { section: "eat", label: t("miniapp.modern.eat"), tone: "cream" },
    { section: "relax", label: t("miniapp.modern.relax"), tone: "mint" },
    { section: "shop", label: t("miniapp.section.shop"), tone: "coffee" },
    { section: "fun", label: t("miniapp.modern.fun"), tone: "emerald" },
    { section: "ski", label: t("miniapp.section.ski"), tone: "cream" },
    { section: "transfer", label: t("miniapp.section.transfer"), tone: "mint" },
    { section: "services", label: t("miniapp.section.services"), tone: "coffee" },
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
      <Link to="/nearby/me" className="modern-location-action" data-testid="near-me">
        {ICONS.locate}
        {t("miniapp.home.nearMe")}
        {ICONS.arrow}
      </Link>
      <nav aria-labelledby="sections-title">
        <ul className="modern-intentions" data-testid="home-sections">
          {tiles.map(({ section, label, tone }) => (
            <li key={section}>
              <Link to={sectionPath(section)} className="modern-intention" data-tone={tone}>
                {ICONS[section]}
                <span>
                  {label}
                  {section === "stay" && (
                    <small data-testid="tile-hint-stay">{t("miniapp.section.stayHint")}</small>
                  )}
                </span>
                {ICONS.arrow}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}
