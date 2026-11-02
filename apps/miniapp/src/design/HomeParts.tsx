// Главная в стиле «Сучасна Косівщина»: места региона (курорта), быстрый поиск сезона.
// Только реальные данные мест (GET /places/search); сезонные слоганы — общий текст спецификации.
import { Link, useT } from "@tg/ui";
import { useEffect, useState } from "react";
import { useGuide, type Async } from "../guide/context.js";
import { OWN_MAP_SECTIONS, type PlaceSummary } from "../guide/types.js";
import { PlaceSummaryCard } from "../guide/parts.js";
import { ICONS } from "./Ornament.js";
import { useResort, useResortCaption } from "./ResortProvider.js";
import { SEASON_CONFIG } from "./season.js";
import { useSeason } from "./SeasonProvider.js";

/** Сколько мест в ленте главной. */
export const HOME_PLACES = 8;

/** Ссылка поиска мест по запросу (экран /search). */
export function searchPath(q?: string): string {
  return q ? `/search?q=${encodeURIComponent(q)}` : "/search";
}

/** Быстрый поиск сезона: чипы priorityTags ведут в поиск мест с коротким запросом. */
export function SeasonTags() {
  const { t } = useT();
  const { season } = useSeason();
  return (
    <section
      aria-labelledby="season-tags-title"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <h2 id="season-tags-title" style={{ margin: 0 }}>
        {t("miniapp.home.tags")}
      </h2>
      <ul className="kosiv-tags" data-testid="season-tags">
        {SEASON_CONFIG[season].tags.map((tag) => (
          <li key={tag.label}>
            <Link to={searchPath(tag.query)} className="kosiv-tag">
              <span aria-hidden="true">{tag.icon}</span>
              {t(tag.label)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Лента мест выбранного курорта (весь регион — рекомендованные первыми, порядок сервера). */
export function ResortPlaces() {
  const { t } = useT();
  const { api, regionId } = useGuide();
  const { resort } = useResort();
  const caption = useResortCaption();
  const area = resort.area;
  const [places, setPlaces] = useState<Async<PlaceSummary[]>>({ status: "loading" });
  useEffect(() => {
    if (!regionId) return;
    let alive = true;
    // Смена курорта: прежняя лента остаётся до ответа (без «Завантажуємо…» и прыжка вёрстки).
    setPlaces((p) => (p.status === "ready" ? p : { status: "loading" }));
    api
      .search({
        ...(area ? { point: area.center, radius: area.radius } : {}),
        excludeSections: OWN_MAP_SECTIONS,
        limit: HOME_PLACES,
      })
      .then(
        (data) => alive && setPlaces({ status: "ready", data }),
        (error: unknown) => alive && setPlaces({ status: "error", error }),
      );
    return () => {
      alive = false;
    };
    // area определяется resort.id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, regionId, resort.id]);
  if (!regionId) return null;
  // Сбой ленты не мешает главной: разделы ниже работают, лента просто не показывается.
  if (places.status === "error") return null;
  return (
    <section aria-labelledby="home-places-title" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="kosiv-section-head">
        <h2 id="home-places-title">{t("miniapp.home.popular")}</h2>
        <Link to={searchPath()} className="kosiv-section-link">
          {t("miniapp.home.allPlaces")}
          {ICONS.arrow}
        </Link>
      </div>
      {caption && (
        <p className="kosiv-muted" style={{ fontSize: "0.875rem" }}>
          {caption}
        </p>
      )}
      {places.status === "loading" ? (
        <p role="status" className="kosiv-muted">
          {t("miniapp.guide.loading")}
        </p>
      ) : places.data.length === 0 ? (
        <p className="kosiv-card kosiv-empty" data-testid="home-places-empty">
          {t("miniapp.home.popularEmpty")}
        </p>
      ) : (
        <ul className="kosiv-rail" data-testid="home-places">
          {places.data.map((p) => (
            <PlaceSummaryCard
              key={p.id}
              place={p}
              layout="tile"
              testId="home-place"
              distanceFrom={area ? t(resort.name) : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
