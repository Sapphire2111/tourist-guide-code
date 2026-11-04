// C02: главная по Концепту Б «Мольфарська Ватра» поверх общего фона (AppBackdrop): заголовок над горами, поле ассистента
// с подсказками и сезонными тегами, карточка заведения (при QR), две большие карточки («поесть», «рядом») и блок из
// 8 плиток: 4 в ряд, остальные — вертикальной прокруткой внутри блока. «Про заклад» — только при QR заведения (C-13).
import type { MessageKey } from "@tg/i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useT } from "@tg/ui";
import { useGuide } from "./context.js";
import type { HomeSection } from "./types.js";

export function sectionPath(section: HomeSection): string {
  if (section === "about") return "/about";
  if (section === "nearby") return "/nearby";
  if (section === "help") return "/help";
  return `/section/${section}`;
}

type Tile = {
  to: string;
  icon: string;
  /** Подпись на плитке. */
  name: MessageKey;
  /** Полное имя для скринридера (начинается с видимой подписи). */
  aria?: MessageKey;
  /** Подсказка: доступна скринридеру, на узкой плитке не помещается. */
  hint?: MessageKey;
};

const TILES: readonly Tile[] = [
  {
    to: sectionPath("stay"),
    icon: "🏡",
    name: "miniapp.section.stay",
    hint: "miniapp.section.stayHint",
  },
  {
    to: sectionPath("relax"),
    icon: "♨️",
    name: "miniapp.home.tile.relax",
    aria: "miniapp.modern.relax",
  },
  { to: sectionPath("shop"), icon: "🛍️", name: "miniapp.section.shop" },
  { to: sectionPath("fun"), icon: "🎡", name: "miniapp.home.tile.fun", aria: "miniapp.modern.fun" },
  { to: sectionPath("ski"), icon: "⛷️", name: "miniapp.section.ski" },
  { to: sectionPath("transfer"), icon: "🚕", name: "miniapp.section.transfer" },
  { to: sectionPath("services"), icon: "🛠️", name: "miniapp.section.services" },
  // Без профиля «Обране» в доке; с профилем это единственный путь на экран кроме меню.
  { to: "/favorites", icon: "❤️", name: "miniapp.nav.favorites" },
];

/** Короткий свайп по блоку (px): меньше — касание, больше — человек листает страницу, ряд не трогаем. */
const SWIPE_MIN = 16;
const SWIPE_MAX = 110;

/** Прокрутка плиток на ряд вниз (1) или вверх (-1); край прокрутки ограничивает браузер, ряды держит scroll-snap. */
function moveRow(el: HTMLElement, dir: 1 | -1): void {
  const [first, next] = [el.children[0], el.children[4]] as (HTMLElement | undefined)[];
  const step = first && next ? next.offsetTop - first.offsetTop : el.clientHeight;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollTo?.({ top: el.scrollTop + dir * step, behavior: still ? "auto" : "smooth" });
}

/**
 * Плитки: 4 в ряд, остальные ряды — внутри блока. Жест по блоку всегда листает страницу нативно (инерция, ничего не
 * съедается); ряд меняют стрелка, короткий свайп и фокус клавиатуры. Обработчики пассивные, прокрутку не перехватывают.
 */
function HomeTiles() {
  const { t } = useT();
  const list = useRef<HTMLUListElement>(null);
  // Меняется только на краях прокрутки, не на каждый кадр.
  const [more, setMore] = useState(true);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const sync = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      const p = e.touches[0];
      start = p && e.touches.length === 1 ? { x: p.clientX, y: p.clientY } : null;
    };
    const onEnd = (e: TouchEvent) => {
      const p = e.changedTouches[0];
      if (!start || !p) return;
      const dy = start.y - p.clientY;
      const dx = start.x - p.clientX;
      start = null;
      const size = Math.abs(dy);
      if (size >= SWIPE_MIN && size <= SWIPE_MAX && size > Math.abs(dx)) moveRow(el, dy > 0 ? 1 : -1);
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    // На всём блоке: свайп может начаться и на стрелке.
    const box = el.parentElement ?? el;
    box.addEventListener("touchstart", onStart, { passive: true });
    box.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("scroll", sync);
      box.removeEventListener("touchstart", onStart);
      box.removeEventListener("touchend", onEnd);
    };
  }, []);
  return (
    <nav className="modern-tiles" data-more={more} aria-label={t("miniapp.home.quickSections")}>
      <ul ref={list} id="home-tiles" className="modern-intentions" data-testid="home-sections">
        {TILES.map((item) => (
          <li key={item.to}>
            <Link to={item.to} className="modern-intention" aria-label={item.aria ? t(item.aria) : undefined}>
              <span className="modern-intention-emoji" aria-hidden="true">
                {item.icon}
              </span>
              <span className="modern-intention-label">
                {t(item.name)}
                {item.hint && (
                  <small data-testid="tile-hint-stay" className="kosiv-sr-only">
                    {` ${t(item.hint)}`}
                  </small>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="modern-tiles-more"
        data-testid="tiles-more"
        aria-controls="home-tiles"
        aria-label={t(more ? "miniapp.home.tilesNext" : "miniapp.home.tilesPrev")}
        onClick={() => list.current && moveRow(list.current, more ? 1 : -1)}
      />
    </nav>
  );
}

export function HomeSections({ hasVenue, hero }: { hasVenue: boolean; hero?: ReactNode }) {
  const { t } = useT();
  const { base } = useGuide();
  return (
    <section className="modern-home" aria-labelledby="sections-title">
      <div className="modern-hero" data-testid="modern-hero">
        <div className="modern-hero-head">
          <span className="modern-hero-kicker" aria-hidden="true">
            ✨ {t("miniapp.home.heroKicker")}
          </span>
          <h2 id="sections-title">{t("miniapp.modern.title")}</h2>
        </div>
        {hero && <div className="modern-hero-glass">{hero}</div>}
        {hasVenue && (
          <Link to="/about" className="modern-host">
            <span>
              <small>
                <span aria-hidden="true">🏡 </span>
                {t("miniapp.home.stayToday")}
              </small>
              <strong>{base?.name ?? t("miniapp.modern.hotel")}</strong>
            </span>
            <span className="modern-host-link">
              {t("miniapp.modern.hotel")}
              <span aria-hidden="true"> →</span>
            </span>
          </Link>
        )}
      </div>

      <div className="modern-featured-grid">
        <Link to="/section/eat" className="modern-featured-card" data-testid="featured-eat">
          <div className="modern-featured-top">
            <span className="modern-featured-emoji" aria-hidden="true">
              🍲
            </span>
            <span className="modern-featured-kicker" aria-hidden="true">
              ✦ {t("miniapp.home.eatKicker")}
            </span>
          </div>
          <strong className="modern-featured-title">{t("miniapp.home.eatTitle")}</strong>
          <span className="modern-featured-sub">{t("miniapp.home.eatSub")}</span>
        </Link>

        <Link to="/nearby/me" className="modern-featured-card modern-featured-near" data-testid="near-me">
          <div className="modern-featured-top">
            <span className="modern-featured-emoji" aria-hidden="true">
              🧭
            </span>
            <span className="modern-featured-kicker" aria-hidden="true">
              {t("miniapp.home.nearKicker")}
            </span>
          </div>
          <strong className="modern-featured-title">{t("miniapp.home.nearTitle")}</strong>
          <span className="modern-featured-sub">{t("miniapp.home.nearSub")}</span>
        </Link>
      </div>

      <HomeTiles />
    </section>
  );
}
