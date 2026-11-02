// Оболочка «Сучасна Косівщина»: заставка старта, липкая шапка с волной и свайпером курортов, переключатель сезона.
import { Link, useT } from "@tg/ui";
import { ICONS, KosivWave, VaseIcon } from "./Ornament.js";
import { ResortSwiper } from "./ResortProvider.js";
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

/** Пути, где свайпер курортов фильтрует выдачу. */
export function hasResortFilter(path: string): boolean {
  return path === "/" || path === "/search" || path.startsWith("/section/");
}

/**
 * Липкая шапка: оберег и название (на главной — заголовок экрана h1, на остальных — ссылка на главную), профиль,
 * «Косівська хвиля»; под ней — свайпер курортов там, где он фильтрует места.
 */
export function AppTop({ path, profile }: { path: string; profile: boolean }) {
  const { t } = useT();
  const home = path === "/";
  return (
    <div className="kosiv-top" data-testid="app-top">
      <header className="kosiv-header">
        {home ? (
          <h1 className="kosiv-brand">
            <VaseIcon />
            <span>{t("app.name")}</span>
          </h1>
        ) : (
          <Link to="/" className="kosiv-brand" aria-label={t("miniapp.header.toHome")}>
            <VaseIcon />
            <span>{t("app.name")}</span>
          </Link>
        )}
        {profile && (
          <Link
            to="/profile"
            className="kosiv-icon-btn"
            aria-label={t("miniapp.nav.profile")}
            aria-current={path === "/profile" ? "page" : undefined}
          >
            {ICONS.user}
          </Link>
        )}
      </header>
      <KosivWave />
      {hasResortFilter(path) && <ResortSwiper />}
    </div>
  );
}

/** Компактный переключатель сезонов (❄️ Зима | 🌱 Весна | ☀️ Літо | 🍂 Осінь). */
export function SeasonSwitcher() {
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
          onClick={() => setSeason(s)}
        >
          <span aria-hidden="true">{SEASON_CONFIG[s].icon}</span>
          {t(SEASON_CONFIG[s].name)}
        </button>
      ))}
    </div>
  );
}
