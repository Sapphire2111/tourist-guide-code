// C02: Головна в стилі Концепту Б «Мольфарська Ватра & Нічні Карпати»:
// статична панорама гір на фоні, бейдж «✨ Жива Ватра Карпат», заголовок «Запитай у гір, чого бажаєш»,
// голосовий пошук з вогником 🔥, картка садиби, 2 великі картки («Де смачно поїсти» та «Що поруч зараз»)
// і горизонтальна карусель швидких категорій унизу.
import type { ReactNode } from "react";
import { Link, useT } from "@tg/ui";
import { HeroPanorama } from "../design/HeroPanorama.js";
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
  const carouselTiles = [
    { section: "relax", icon: "♨️", short: "Чани", label: t("miniapp.modern.relax") },
    { section: "fun", icon: "⛰️", short: "Вершини", label: t("miniapp.modern.fun") },
    { section: "shop", icon: "🧀", short: "Крафт", label: t("miniapp.section.shop") },
    { section: "transfer", icon: "🚕", short: "Авто", label: t("miniapp.section.transfer") },
    {
      section: "stay",
      icon: "🏡",
      short: "Оселі",
      label: t("miniapp.section.stay"),
      hint: t("miniapp.section.stayHint"),
    },
    { section: "ski", icon: "⛷️", short: "Лижі", label: t("miniapp.section.ski") },
    { section: "services", icon: "🛠️", short: "Сервіси", label: t("miniapp.section.services") },
    { section: "eat", icon: "🍲", short: "Колиби", label: t("miniapp.modern.eat") },
  ] as const;

  return (
    <section className="modern-home" aria-labelledby="sections-title">
      <div className="modern-hero" data-testid="modern-hero">
        <HeroPanorama />
        <div className="modern-hero-head">
          <span className="modern-hero-kicker" aria-hidden="true">
            ✨ Жива Ватра Карпат
          </span>
          <h2 id="sections-title" aria-label={t("miniapp.modern.title")}>
            Запитай у гір, чого бажаєш
          </h2>
        </div>
        {hero && <div className="modern-hero-glass">{hero}</div>}
        {hasVenue && (
          <Link to="/about" className="modern-host">
            <span>
              <small>🏡 Ваша оселя сьогодні:</small>
              <strong>{base?.name ?? t("miniapp.modern.hotel")}</strong>
            </span>
            <span className="modern-host-link">
              <span aria-hidden="true">Wi-Fi · Чан →</span>
              <span className="kosiv-sr-only">{t("miniapp.modern.hotel")}</span>
            </span>
          </Link>
        )}
      </div>

      {/* Дві великі акцентні картки як на референсі Концепту Б */}
      <div className="modern-featured-grid">
        <Link to="/section/eat" className="modern-featured-card" data-testid="featured-eat">
          <div className="modern-featured-top">
            <span className="modern-featured-emoji" aria-hidden="true">
              🍲
            </span>
            <span className="modern-featured-kicker" aria-hidden="true">
              ✦ Трапеза
            </span>
          </div>
          <strong className="modern-featured-title">Де смачно поїсти</strong>
          <span className="modern-featured-sub">Бограч на вогні, гриби, форель</span>
        </Link>

        <Link
          to="/nearby/me"
          className="modern-featured-card modern-featured-near"
          data-testid="near-me"
          aria-label={t("miniapp.home.nearMe")}
        >
          <div className="modern-featured-top">
            <span className="modern-featured-emoji" aria-hidden="true">
              🧭
            </span>
            <span className="modern-featured-kicker" aria-hidden="true">
              300–1000 м
            </span>
          </div>
          <strong className="modern-featured-title">Що поруч зараз</strong>
          <span className="modern-featured-sub">Відкриті місця на карті</span>
        </Link>
      </div>

      {/* Горизонтальна карусель швидких категорій унизу */}
      <nav aria-labelledby="sections-title">
        <ul className="modern-intentions" data-testid="home-sections">
          {carouselTiles.map((item) => (
            <li key={item.section}>
              <Link to={sectionPath(item.section)} className="modern-intention" aria-label={item.label}>
                <span className="modern-intention-emoji" aria-hidden="true">
                  {item.icon}
                </span>
                <span className="modern-intention-label">
                  {item.short}
                  {"hint" in item && item.hint && (
                    <small data-testid="tile-hint-stay" className="kosiv-sr-only">
                      {item.hint}
                    </small>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}
