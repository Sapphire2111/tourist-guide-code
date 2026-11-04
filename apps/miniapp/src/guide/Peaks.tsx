// Раздел «Вершини»: список вершин (фото, высота, значок сложности, хребет, время), фильтр по сложности и сортировка
// (від легких / ближчі / вищі); блок вершины в картке місця — параметры маршрута из источников, старт в Google Карты,
// погода на вершине (горная точка прогноза рядом), «Спланувати похід» (ассистент). Сложность — цвет + форма + текст.
import { useEffect, useState } from "react";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { Link, Stack, useFeatureFlag, useT } from "@tg/ui";
import { useBackStep, useScreenState } from "../screen-state.js";
import { formatTemp, WarningList, WeatherAttribution } from "../weather/Weather.js";
import type { Forecast } from "../weather/weather-api.js";
import { loadCategories } from "./categories.js";
import { useAsync, useGuide } from "./context.js";
import { googleRouteUrl } from "./geo.js";
import { useLocations } from "./LocationProvider.js";
import { AsyncView, ExtLink, PlaceMedia, useDistance } from "./parts.js";
import {
  availableFilters,
  filterPeaks,
  heightText,
  asPeakPlace,
  hoursText,
  sortPeaks,
  type PeakFilter,
  type PeakPlace,
  type PeakSort,
} from "./peak-list.js";
import type { Peak, PeakDifficulty } from "./types.js";
import { SubcategorySelect } from "./SubcategorySelect.js";
import "./peaks.css";

/** Код подкатегории «Вершини» (api: places-import/peaks.ts). */
export const PEAKS_CATEGORY = "peaks";
/** Вершин в разделе немного — одной выдачей (api — до 50 за страницу, догрузка до этого числа). */
const PEAKS_MAX = 100;

/** Значок сложности: форма (круг, квадрат, треугольник, два ромба) + цвет + текст — не только цвет. */
export function PeakBadge({
  difficulty,
  compact = false,
}: {
  difficulty: PeakDifficulty | null;
  compact?: boolean;
}) {
  const { t } = useT();
  const level = difficulty ?? "unknown";
  const label = t(`miniapp.peaks.difficulty.${level}` as MessageKey);
  return (
    <span
      className="peak-badge"
      data-level={level}
      data-testid="peak-badge"
      title={t("miniapp.peaks.difficultyLabel", { level: label })}
    >
      <span className="peak-shape" data-shape={level} aria-hidden="true" />
      {compact ? <span className="pc-sr">{label}</span> : label}
    </span>
  );
}

/** «набір ~731 м · 5 год» / «7 км · набір ~460 м» — то, что известно; ничего — null. */
export function peakRouteSummary(peak: Peak, t: ReturnType<typeof useT>["t"]): string | null {
  const r = peak.route;
  if (!r) return null;
  const parts = [
    r.elevationGainM != null ? t("miniapp.peaks.gain", { m: r.elevationGainM }) : null,
    r.roundTripKm != null ? t("miniapp.peaks.km", { km: hoursText(r.roundTripKm) }) : null,
    r.totalHours != null
      ? t("miniapp.peaks.hours", { h: hoursText(r.totalHours) })
      : r.upHours != null
        ? t("miniapp.peaks.upHours", { h: hoursText(r.upHours) })
        : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function PeakItem({ place }: { place: PeakPlace }) {
  const { t, locale } = useT();
  const distance = useDistance()(place.distanceMeters);
  const { peak } = place;
  const summary = peakRouteSummary(peak, t);
  return (
    <li className="kosiv-card kosiv-place kosiv-row peak-item" data-testid="peak-item" data-slug={peak.slug}>
      <PlaceMedia
        place={place}
        icon={
          <span className="peak-fallback" aria-hidden="true">
            ⛰️
          </span>
        }
      />
      <div className="kosiv-place-body">
        <Link to={`/place/${encodeURIComponent(place.id)}`} className="kosiv-place-title">
          {pickLocalized(place.name, locale)}
        </Link>
        <span className="kosiv-place-cat">
          {[
            peak.heightM != null ? heightText(peak.heightM) : t("miniapp.peaks.heightUnknown"),
            peak.range ? t(`miniapp.peaks.range.${peak.range}` as MessageKey) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span className="kosiv-place-meta">
          <PeakBadge difficulty={peak.difficulty} />
          {summary && <span className="kosiv-chip">{summary}</span>}
          {distance && <span className="kosiv-chip">{distance}</span>}
        </span>
      </div>
    </li>
  );
}

const SORTS: readonly PeakSort[] = ["difficulty", "distance", "height"];

/** Список вершин с фильтром и сортировкой (без загрузки — для экрана и тестов). */
export function PeakList({ places }: { places: PeakPlace[] }) {
  const { t } = useT();
  const [filter, setFilter] = useScreenState<PeakFilter>("peaks.filter", "all");
  const [sort, setSort] = useScreenState<PeakSort>("peaks.sort", "difficulty");
  useBackStep(filter !== "all", () => setFilter("all"));
  const hasDistance = places.some((p) => p.distanceMeters != null);
  const filters = availableFilters(places);
  const shown = sortPeaks(filterPeaks(places, filters.includes(filter) ? filter : "all"), sort);
  return (
    <Stack>
      <SubcategorySelect
        title={t("miniapp.peaks.filter")}
        testId="peak-filter"
        options={filters.map((f) => ({
          id: f,
          label:
            f === "all" ? t("miniapp.peaks.filter.all") : t(`miniapp.peaks.difficulty.${f}` as MessageKey),
          icon: f === "all" ? undefined : <span className="peak-shape" data-shape={f} />,
        }))}
        value={filters.includes(filter) ? filter : "all"}
        onChange={(f) => setFilter(f as PeakFilter)}
      />
      <div role="group" aria-label={t("miniapp.peaks.sort")} className="peak-chips">
        {SORTS.filter((s) => s !== "distance" || hasDistance).map((s) => (
          <button
            key={s}
            type="button"
            className="kosiv-toggle peak-toggle"
            aria-pressed={s === sort}
            data-testid={`peak-sort-${s}`}
            onClick={() => setSort(s)}
          >
            {t(`miniapp.peaks.sort.${s}` as MessageKey)}
          </button>
        ))}
      </div>
      <p role="status" className="kosiv-muted" data-testid="peak-count">
        {t("miniapp.peaks.count", { n: shown.length })}
      </p>
      {shown.length === 0 ? (
        <p className="kosiv-muted" data-testid="peak-empty">
          {t("miniapp.peaks.empty")}
        </p>
      ) : (
        <ul className="peak-list" data-testid="peak-list">
          {shown.map((p) => (
            <PeakItem key={p.id} place={p} />
          ))}
        </ul>
      )}
    </Stack>
  );
}

function DifficultyRule() {
  const { t } = useT();
  return (
    <details className="kosiv-card peak-rule" data-testid="peak-rule">
      <summary>{t("miniapp.peaks.ruleTitle")}</summary>
      <p className="kosiv-muted">{t("miniapp.peaks.rule")}</p>
      <p className="peak-rule-legend">
        {(["easy", "moderate", "hard", "expert", null] as const).map((d) => (
          <PeakBadge key={d ?? "unknown"} difficulty={d} />
        ))}
      </p>
    </details>
  );
}

/** Экран «Вершини» (#/peaks). */
export function Peaks() {
  const { t } = useT();
  const { api, base } = useGuide();
  const { gps } = useLocations();
  const point = gps ?? base?.point ?? null;
  const [state, retry] = useAsync(
    async () => {
      const categories = await loadCategories(api);
      const cat = categories.find((c) => c.code === PEAKS_CATEGORY);
      if (!cat) return [];
      const list = await api.search({ categoryId: cat.id, point, max: PEAKS_MAX });
      // Место раздела без данных в peaks.ts — тоже в списке, «складність невідома».
      return list.map(asPeakPlace);
    },
    [api, point?.lat, point?.lng],
    { slot: "peaks.list", key: JSON.stringify(point) },
  );
  return (
    <Stack>
      <h1>{t("miniapp.section.peaks")}</h1>
      <p className="kosiv-muted">{t("miniapp.peaks.intro")}</p>
      <DifficultyRule />
      <AsyncView state={state} retry={retry}>
        {(list) =>
          list.length ? (
            <PeakList places={list} />
          ) : (
            <p className="kosiv-muted" data-testid="peaks-none">
              {t("miniapp.peaks.none")}
            </p>
          )
        }
      </AsyncView>
    </Stack>
  );
}

function PeakWeather({ point }: { point: { lat: number; lng: number } }) {
  const { t } = useT();
  const weather = useGuide().weather;
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const { lat, lng } = point;
  useEffect(() => {
    if (!weather) return;
    const ctrl = new AbortController();
    weather
      .forecast({ lat, lng }, ctrl.signal)
      .then((f) => {
        if (!ctrl.signal.aborted) setForecast(f);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [weather, lat, lng]);
  const now = forecast?.current ?? null;
  const today = forecast?.days[0] ?? null;
  if (!forecast || (!now && !today)) return null;
  const temp = formatTemp(now?.temperature ?? null);
  return (
    <div className="peak-weather" data-testid="peak-weather">
      <h3 className="peak-h3">{t("miniapp.peaks.card.weather")}</h3>
      <p className="pc-m0">
        {temp && <strong>{temp}</strong>}
        {today && (
          <span className="pc-muted">
            {" "}
            {[formatTemp(today.temperatureMin), formatTemp(today.temperatureMax)].filter(Boolean).join(" … ")}
          </span>
        )}
      </p>
      {today && today.warnings.length > 0 && <WarningList warnings={today.warnings} testId="peak-warnings" />}
      <WeatherAttribution source={forecast.source} />
    </div>
  );
}

/** Блок вершины в картке місця. */
export function PeakDetails({
  peak,
  placeId,
  name,
  placeLocation,
}: {
  peak: Peak;
  /** id места (uuid) — для аналитики route_clicked (схема требует uuid, не slug). */
  placeId: string;
  name: string;
  placeLocation: { lat: number; lng: number } | null;
}) {
  const { t, locale } = useT();
  const { analytics, signedIn } = useGuide();
  const assistant = useFeatureFlag("module.assistant");
  const r = peak.route;
  const unknown = t("miniapp.peaks.card.unknownValue");
  const start = r?.startLocation ?? null;
  const routeHref = start ? googleRouteUrl(start) : placeLocation ? googleRouteUrl(placeLocation) : null;
  const time =
    r?.upHours != null && r.downHours != null && r.totalHours != null
      ? t("miniapp.peaks.card.timeBoth", {
          up: hoursText(r.upHours),
          down: hoursText(r.downHours),
          total: hoursText(r.totalHours),
        })
      : r?.upHours != null
        ? t("miniapp.peaks.card.timeUp", { up: hoursText(r.upHours) })
        : unknown;
  const gain =
    r?.elevationGainM != null
      ? t(r.gainKind === "stated" ? "miniapp.peaks.card.gainStated" : "miniapp.peaks.card.gainDifference", {
          m: r.elevationGainM,
        })
      : unknown;
  const summary = peakRouteSummary(peak, t);
  return (
    <section className="pc-section peak-card" data-testid="peak-details">
      <header className="pc-section-head">
        <h2 className="pc-h2">{t("miniapp.peaks.card.title")}</h2>
        <PeakBadge difficulty={peak.difficulty} />
      </header>
      {summary ? (
        <p className="pc-lead" data-testid="peak-summary">
          {summary}
        </p>
      ) : (
        <p className="pc-muted pc-m0" data-testid="peak-no-data">
          {t("miniapp.peaks.card.noData")}
        </p>
      )}
      <dl className="pc-contacts peak-facts">
        <dt>{t("miniapp.peaks.card.height")}</dt>
        <dd>{peak.heightM != null ? heightText(peak.heightM) : unknown}</dd>
        {peak.range && (
          <>
            <dt>{t("miniapp.peaks.card.range")}</dt>
            <dd>{t(`miniapp.peaks.range.${peak.range}` as MessageKey)}</dd>
          </>
        )}
        {r && (
          <>
            <dt>{t("miniapp.peaks.card.start")}</dt>
            <dd data-testid="peak-start">{pickLocalized(r.start, locale)}</dd>
            {r.trail && (
              <>
                <dt>{t("miniapp.peaks.card.trail")}</dt>
                <dd>{pickLocalized(r.trail, locale)}</dd>
              </>
            )}
            <dt>{t("miniapp.peaks.card.distance")}</dt>
            <dd>
              {r.roundTripKm != null ? t("miniapp.peaks.km", { km: hoursText(r.roundTripKm) }) : unknown}
            </dd>
            <dt>{t("miniapp.peaks.card.gain")}</dt>
            <dd>{gain}</dd>
            <dt>{t("miniapp.peaks.card.time")}</dt>
            <dd>{time}</dd>
          </>
        )}
      </dl>
      {peak.note && <p className="pc-small">{pickLocalized(peak.note, locale)}</p>}
      {peak.warnings.length > 0 && (
        <div className="peak-warn" role="note" data-testid="peak-season">
          <h3 className="peak-h3">{t("miniapp.peaks.card.warnings")}</h3>
          <ul>
            {peak.warnings.map((w, i) => (
              <li key={i}>{pickLocalized(w, locale)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="kosiv-actions">
        {routeHref && (
          <ExtLink
            href={routeHref}
            className="kosiv-action"
            testId="peak-route"
            onOpen={() => analytics.track("route_clicked", { placeId })}
          >
            {t(start ? "miniapp.peaks.card.routeToStart" : "miniapp.peaks.card.routeToPeak")}
          </ExtLink>
        )}
        {assistant && signedIn && (
          <Link
            to={`/assistant?q=${encodeURIComponent(t("miniapp.peaks.card.planQuery", { name }))}`}
            className="kosiv-action"
            data-variant="ghost"
            data-testid="peak-plan"
          >
            {t("miniapp.peaks.card.plan")}
          </Link>
        )}
      </div>
      {peak.weatherPoint && <PeakWeather point={peak.weatherPoint} />}
      {peak.sources.length > 0 && (
        <p className="pc-source" data-testid="peak-sources">
          {t("miniapp.peaks.card.sources")}:{" "}
          {peak.sources.map((s, i) => (
            <span key={s.url}>
              {i > 0 && ", "}
              <ExtLink href={s.url}>{s.title}</ExtLink>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
