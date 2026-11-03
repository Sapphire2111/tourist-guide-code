// Оболочка «Сучасна Косівщина»: заставка старта, кнопка меню (настройки и профиль) и переключатель сезона.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKey } from "@tg/i18n";
import { Link, useT } from "@tg/ui";
import { interceptBack } from "../telegram.js";
import { ICONS, VaseIcon } from "./Ornament.js";
import { SEASON_CONFIG, SEASONS } from "./season.js";
import { useSeason } from "./SeasonProvider.js";

/**
 * Заставка, пока идут вход и GET /context: та же разметка, что статическая в index.html (до загрузки бандла), —
 * подмена без мигания. Бейдж — текущий сезон.
 */
export function Splash() {
  const { t } = useT();
  const { season } = useSeason();
  const cfg = SEASON_CONFIG[season];
  return (
    <div className="kosiv-splash" data-testid="splash">
      <VaseIcon size={44} />
      <p className="kosiv-splash-title">{t("app.name")}</p>
      <svg className="kosiv-splash-wave" viewBox="0 0 400 14" preserveAspectRatio="none" aria-hidden="true">
        <path
          d="M0 7 Q 12 1, 25 7 T 50 7 T 75 7 T 100 7 T 125 7 T 150 7 T 175 7 T 200 7 T 225 7 T 250 7 T 275 7 T 300 7 T 325 7 T 350 7 T 375 7 T 400 7"
          fill="none"
          stroke="var(--app-accent-2)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {[75, 200, 325].map((cx) => (
          <circle key={cx} cx={cx} cy="7" r="2.5" fill="var(--app-accent)" />
        ))}
      </svg>
      <p className="kosiv-splash-badge">{`${cfg.icon} ${t(cfg.badge)}`}</p>
      <p className="kosiv-splash-note">{t("miniapp.splash.welcome")}</p>
      <span className="kosiv-dots" role="status" aria-label={t("miniapp.start.loading")}>
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

const MENU_ICON = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

const SCAN_ICON = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16" />
  </svg>
);

/** Сканер QR: запуск, занятость (сканер открыт) и сообщение о результате («Це не QR-код…»). */
export type ScanControl = { start: () => void; busy: boolean; message: MessageKey | null };

const FOCUSABLE = "a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * Тонкая липкая полоса с одной маленькой кнопкой «Меню» (справа). Кнопка открывает лист с настройками (сезон
 * оформления) и профилем — одинаково на всех экранах. Лист: role=dialog, фокус внутрь и возврат на кнопку,
 * Tab не выходит за лист, закрытие по Escape, тапу вне листа, кнопке «Закрити» и при смене экрана.
 * На главной — скрытый для глаз h1 с названием приложения (заголовок экрана для скринридеров).
 */
export function AppTop({ path, profile, scan }: { path: string; profile: boolean; scan?: ScanControl }) {
  const { t } = useT();
  const home = path === "/";
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    sheet.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
    // Фон не прокручивается, «Назад» Telegram закрывает лист (как просмотр фото).
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const releaseBack = interceptBack(close);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key !== "Tab" || !sheet.current) return;
      const items = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      releaseBack();
    };
  }, [open, close]);
  return (
    <div className="kosiv-top" data-testid="app-top">
      {home && <h1 className="kosiv-sr-only">{t("app.name")}</h1>}
      {scan?.message && (
        <p className="kosiv-top-note" role="status" data-testid="scan-message">
          {t(scan.message)}
        </p>
      )}
      {scan && home && (
        <button
          type="button"
          className="kosiv-menu-btn"
          aria-label={t("miniapp.scan.open")}
          data-testid="scan-btn"
          disabled={scan.busy}
          onClick={scan.start}
        >
          {SCAN_ICON}
        </button>
      )}
      <button
        ref={button}
        type="button"
        className="kosiv-menu-btn"
        aria-label={t("miniapp.menu.open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="menu-btn"
        onClick={() => setOpen((v) => !v)}
      >
        {MENU_ICON}
      </button>
      {open && (
        <div
          className="kosiv-sheet-backdrop"
          data-testid="menu-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            ref={sheet}
            id="app-settings"
            className="kosiv-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t("miniapp.menu.title")}
            data-testid="app-settings"
          >
            <div className="kosiv-sheet-head">
              <p className="kosiv-sheet-title">{t("miniapp.menu.title")}</p>
              <button
                type="button"
                className="kosiv-icon-btn"
                aria-label={t("miniapp.menu.close")}
                onClick={close}
              >
                ✕
              </button>
            </div>
            <SeasonSwitcher onPicked={close} />
            {scan && (
              <button
                type="button"
                className="kosiv-sheet-link"
                data-testid="scan-menu-item"
                disabled={scan.busy}
                onClick={() => {
                  setOpen(false);
                  scan.start();
                }}
              >
                <span aria-hidden="true">{SCAN_ICON}</span>
                {t("miniapp.scan.open")}
              </button>
            )}
            {profile && (
              <Link
                to="/profile"
                className="kosiv-sheet-link"
                aria-current={path === "/profile" ? "page" : undefined}
              >
                <span aria-hidden="true">{ICONS.user}</span>
                {t("miniapp.nav.profile")}
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Компактный переключатель сезонов (❄️ Зима | 🌱 Весна | ☀️ Літо | 🍂 Осінь). */
export function SeasonSwitcher({ onPicked }: { onPicked?: () => void } = {}) {
  const { t } = useT();
  const { season, setSeason } = useSeason();
  return (
    <div
      className="kosiv-seasons"
      role="group"
      aria-label={t("miniapp.season.switcher")}
      data-testid="season-switcher"
    >
      {SEASONS.map((s) => (
        <button
          key={s}
          type="button"
          className="kosiv-season"
          aria-pressed={s === season}
          onClick={() => {
            setSeason(s);
            onPicked?.();
          }}
        >
          <span aria-hidden="true">{SEASON_CONFIG[s].icon}</span>
          {t(SEASON_CONFIG[s].name)}
        </button>
      ))}
    </div>
  );
}
