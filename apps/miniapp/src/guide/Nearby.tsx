// C05 «Що поруч»: места в радиусе от базовой точки (QR) или — по нажатию и с разрешения — от устройства.
// Подпись «Поруч із вами» только при полученной геолокации, иначе «Поруч із <база>».
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { pickLocalized } from "@tg/i18n";
import { useCategoryIndex } from "./categories.js";
import { ICONS, SECTION_EMOJI } from "../design/Ornament.js";
import { Button, Link, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { canOpenLocationSettings, requestLocation, routeUrl, type LatLng } from "./geo.js";
import type { Async } from "./context.js";
import { MapSlot, preloadMap } from "./MapSlot.js";
import { AsyncView, ExtLink, PlaceList, useDistance } from "./parts.js";
import { OWN_MAP_SECTIONS, type PlaceSummary, type HomeSection } from "./types.js";

/** Пилюли радиуса, м, поверх карты (эталон «Що поруч»). */
export const RADIUS_PILLS = [300, 500, 1000, 3000, 5000, 10_000] as const;
export const RADIUS_MIN = RADIUS_PILLS[0];
export const RADIUS_MAX = RADIUS_PILLS[RADIUS_PILLS.length - 1]!;
export const DEFAULT_RADIUS = 500;
/** Задержка запроса при смене радиуса, мс. */
export const RADIUS_DEBOUNCE_MS = 350;
/** Значение вне шага — ближайшая пилюля (границы уже внутри набора). */
export function snapRadius(m: number): number {
  return RADIUS_PILLS.reduce<number>(
    (best, p) => (Math.abs(p - m) < Math.abs(best - m) ? p : best),
    DEFAULT_RADIUS,
  );
}
/** Не больше стольких ближайших мест на 10 км (сервер сортирует по расстоянию). */
export const NEARBY_LIMIT = 50;
/** Предел масштаба карты для выдачи вокруг устройства (приватность: тайлы OSM выдают район). */
export const DEVICE_MAX_ZOOM = 14;

/** Подпись радиуса: «500 м», «1,5 км», «10 км». */
export function useRadiusLabel(): (m: number) => string {
  const { t } = useT();
  return (m) =>
    m < 1000
      ? t("miniapp.nearby.meters", { n: m })
      : t("miniapp.place.distanceKm", { n: String(Math.round(m / 100) / 10).replace(".", ",") });
}

type NearbyResult = { list: PlaceSummary[]; radius: number };

type Geo = { status: "idle" | "locating" | "denied" } | { status: "granted"; point: LatLng };

export function Nearby({ useMyLocation }: { useMyLocation: boolean }) {
  const { t, locale } = useT();
  const { webApp, base } = useGuide();
  // Карта открывается большой («full»); «Список ↓» уменьшает её и прокручивает к листу, «Розгорнути» возвращает.
  const [mapMode, setMapMode] = useState<"full" | "split">("full");
  const sheet = useRef<HTMLDivElement>(null);
  const modeChanged = useRef(false);
  useEffect(() => {
    if (!modeChanged.current) {
      modeChanged.current = true;
      return;
    }
    const behavior = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    if (mapMode === "split") sheet.current?.scrollIntoView?.({ block: "start", behavior });
    else window.scrollTo?.({ top: 0, behavior });
  }, [mapMode]);
  const [radius, setRadius] = useState<number>(DEFAULT_RADIUS);
  /** Радиус запроса — выбранная пилюля после паузы (быстрые нажатия подряд дают один запрос). */
  const [queryRadius, setQueryRadius] = useState<number>(DEFAULT_RADIUS);
  useEffect(() => {
    if (radius === queryRadius) return;
    const timer = window.setTimeout(() => setQueryRadius(radius), RADIUS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [radius, queryRadius]);
  // Модуль карты и скрипт Google Maps — параллельно запросу мест (повторный вызов берёт тот же промис).
  useEffect(() => {
    preloadMap(locale).catch(() => undefined);
  }, [locale]);
  const [geo, setGeo] = useState<Geo>({ status: useMyLocation ? "locating" : "idle" });

  const locate = () => {
    setGeo({ status: "locating" });
    void requestLocation(webApp).then((point) =>
      setGeo(point ? { status: "granted", point } : { status: "denied" }),
    );
  };
  // «Що поруч зі мною зараз» с главной — запрос сразу (это и есть нажатие пользователя).
  useEffect(() => {
    if (useMyLocation) locate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useMyLocation]);

  const point = geo.status === "granted" ? geo.point : (base?.point ?? null);
  const caption =
    geo.status === "granted"
      ? t("miniapp.nearby.nearYou")
      : base?.point
        ? t("miniapp.nearby.nearBase", { base: base.name })
        : null;
  // Название базы в надзаголовке — золотым акцентом; текст подписи целиком остаётся одной строкой i18n.
  const accent = geo.status !== "granted" && base?.point && caption ? caption.indexOf(base.name) : -1;
  const locating = geo.status === "locating";

  return (
    <div className="modern-nearby" data-map-mode={mapMode}>
      <div className="modern-nearby-head">
        <svg className="modern-nearby-art" viewBox="0 0 400 90" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 75 L55 28 L115 58 L195 14 L270 55 L335 24 L400 52 L400 90 L0 90 Z" />
          <path d="M0 82 L85 45 L165 70 L255 36 L345 68 L400 48 L400 90 L0 90 Z" />
          <ellipse cx="200" cy="76" rx="170" ry="12" />
        </svg>
        <div className="modern-nearby-titles">
          <span className="modern-nearby-badge" aria-hidden="true">
            {SECTION_EMOJI.nearby}
          </span>
          <div className="modern-nearby-heading">
            {caption && (
              <p data-testid="nearby-caption">
                {accent >= 0 && base ? (
                  <>
                    {caption.slice(0, accent)}
                    <b>{base.name}</b>
                    {caption.slice(accent + base.name.length)}
                  </>
                ) : (
                  caption
                )}
              </p>
            )}
            <h1>{t("miniapp.modern.heading")}</h1>
          </div>
          {geo.status !== "granted" && (
            <button
              type="button"
              className="modern-locate"
              data-testid="nearby-locate"
              aria-label={locating ? t("miniapp.nearby.locating") : t("miniapp.nearby.useLocation")}
              aria-busy={locating}
              disabled={locating}
              onClick={locate}
            >
              {ICONS.locate}
            </button>
          )}
          <button
            type="button"
            className="modern-nearby-size"
            onClick={() => setMapMode((m) => (m === "full" ? "split" : "full"))}
          >
            <span aria-hidden="true">{mapMode === "full" ? "📋" : "🗺️"}</span>
            {t(mapMode === "full" ? "miniapp.modern.listDown" : "miniapp.modern.expand")}
          </button>
        </div>
        {geo.status === "denied" && (
          <p role="alert" className="modern-nearby-note" data-testid="geo-off">
            {base?.point ? t("miniapp.nearby.geoOff", { base: base.name }) : t("miniapp.nearby.geoOffNoBase")}
          </p>
        )}
        {geo.status === "denied" && canOpenLocationSettings(webApp) && (
          <Button onClick={() => webApp?.LocationManager?.openSettings?.()}>
            {t("miniapp.nearby.openSettings")}
          </Button>
        )}
      </div>
      {point ? (
        <NearbyPlaces
          point={point}
          radius={queryRadius}
          selectedRadius={radius}
          onRadius={setRadius}
          sheetRef={sheet}
          // Карта строится по местам и базовой точке и на устройство не центрируется; позиция устройства — только значок «Ви тут» (me).
          base={geo.status === "granted" ? null : (base?.point ?? null)}
          baseLabel={caption ?? undefined}
          baseTag={base?.name}
          me={geo.status === "granted" ? geo.point : null}
        />
      ) : (
        geo.status !== "locating" &&
        geo.status !== "denied" && <p data-testid="nearby-no-point">{t("miniapp.nearby.noBase")}</p>
      )}
    </div>
  );
}

function NearbyPlaces({
  point,
  radius,
  selectedRadius,
  onRadius,
  sheetRef,
  base,
  baseLabel,
  baseTag,
  me,
}: {
  point: LatLng;
  radius: number;
  selectedRadius: number;
  onRadius: (m: number) => void;
  sheetRef: RefObject<HTMLDivElement | null>;
  base: LatLng | null;
  baseLabel?: string;
  baseTag?: string;
  me: LatLng | null;
}) {
  const { api } = useGuide();
  const [fresh, retry] = useAsync(
    () =>
      api
        .search({ point, radius, excludeSections: OWN_MAP_SECTIONS, limit: NEARBY_LIMIT })
        .then((list) => ({ list, radius })),
    [api, point.lat, point.lng, radius],
  );
  // Смена радиуса: прежний список и карта остаются до ответа (карта не пересоздаётся, тайлы не грузятся заново).
  const last = useRef<Async<NearbyResult>>(fresh);
  if (fresh.status !== "loading") last.current = fresh;
  const shown = fresh.status === "loading" && last.current.status === "ready" ? last.current : fresh;
  return (
    <AsyncView state={shown} retry={retry}>
      {({ list, radius: loaded }) => (
        <ModernNearbyResults
          list={list}
          radius={loaded}
          selectedRadius={selectedRadius}
          onRadius={onRadius}
          sheetRef={sheetRef}
          base={base}
          baseLabel={baseLabel}
          baseTag={baseTag}
          me={me}
          loading={fresh.status === "loading"}
        />
      )}
    </AsyncView>
  );
}

/** Капсула радиуса поверх карты: пилюли прокручиваются, активная видна сразу. */
function RadiusPills({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  const { t } = useT();
  const label = useRadiusLabel();
  const active = snapRadius(value);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    const pill = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !pill) return;
    // Видна с начала ряда — без прокрутки, как на эталоне; иначе активная у левого края (без обрезка «00 м»).
    el.scrollLeft = pill.offsetLeft + pill.offsetWidth + 3 <= el.clientWidth ? 0 : pill.offsetLeft - 3;
  }, [active]);
  return (
    <div ref={box} className="modern-radius" role="group" aria-label={t("miniapp.nearby.radius")}>
      {RADIUS_PILLS.map((m) => (
        <button type="button" key={m} aria-pressed={m === active} onClick={() => onChange(m)}>
          {label(m)}
        </button>
      ))}
    </div>
  );
}

/** Фильтры применяются к одной загруженной выборке: карта и список всегда согласованы. */
export function ModernNearbyResults({
  list,
  radius,
  selectedRadius = radius,
  onRadius,
  sheetRef,
  base,
  baseLabel,
  baseTag,
  me,
  loading,
}: {
  list: PlaceSummary[];
  /** Радиус загруженной выборки. */
  radius: number;
  /** Выбранный радиус (запрос может ещё идти). */
  selectedRadius?: number;
  onRadius?: (m: number) => void;
  sheetRef?: RefObject<HTMLDivElement | null>;
  base: LatLng | null;
  baseLabel?: string;
  baseTag?: string;
  me: LatLng | null;
  loading: boolean;
}) {
  const { t, locale } = useT();
  const { api, analytics } = useGuide();
  const categories = useCategoryIndex(api);
  const radiusLabel = useRadiusLabel();
  const distanceLabel = useDistance();
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<HomeSection | "all">("all");
  const sections = Array.from(
    new Set([
      ...(section === "all" ? [] : [section]),
      ...list.map((p) => categories.sectionOf(p.categoryId)).filter((s) => s !== null),
    ]),
  );
  // Стабильная ссылка: иначе карта пересоздаёт маркеры и сбрасывает охват на каждый рендер.
  // Места в списке под картой всегда идут от ближайшего к самому дальнему.
  const visible = useMemo(
    () =>
      list
        .filter(
          (p) =>
            (section === "all" || categories.sectionOf(p.categoryId) === section) &&
            `${pickLocalized(p.name, locale)} ${p.address ? pickLocalized(p.address, locale) : ""}`
              .toLocaleLowerCase(locale)
              .includes(query.trim().toLocaleLowerCase(locale)),
        )
        .sort(
          (a, b) =>
            (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY),
        ),
    [list, section, query, categories, locale],
  );
  const closest = visible[0];
  const closestSection = closest ? categories.sectionOf(closest.categoryId) : null;
  const closestDist = closest ? distanceLabel(closest.distanceMeters) : null;
  return (
    <div className="modern-nearby-results">
      <div className="modern-map-stage">
        <div className="modern-map-overlay" data-map-inset="top">
          <div className="modern-toolbar">
            <label className="modern-search">
              {ICONS.search}
              <input
                type="search"
                value={query}
                aria-label={t("miniapp.modern.search")}
                placeholder={t("miniapp.modern.search")}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {onRadius && <RadiusPills value={selectedRadius} onChange={onRadius} />}
          </div>
          <div className="modern-filters" role="group" aria-label={t("miniapp.modern.filters")}>
            <button type="button" aria-pressed={section === "all"} onClick={() => setSection("all")}>
              <span aria-hidden="true">✦</span>
              {t("miniapp.modern.all")}
            </button>
            {sections.map((s) => (
              <button type="button" key={s} aria-pressed={section === s} onClick={() => setSection(s)}>
                <span aria-hidden="true">{SECTION_EMOJI[s] ?? SECTION_EMOJI.other}</span>
                {t(`miniapp.section.${s}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="modern-map-panel">
          <MapSlot
            places={visible}
            center={base}
            centerLabel={baseLabel}
            centerTag={baseTag}
            radius={base ? radius : undefined}
            maxZoom={base ? undefined : DEVICE_MAX_ZOOM}
            me={me}
            closestId={closest?.id}
            legend={false}
            overlay={
              closest && (
                <div className="modern-map-spot" data-map-inset="bottom">
                  <Link to={`/place/${encodeURIComponent(closest.id)}`} className="modern-map-spot-main">
                    <span className="modern-map-spot-icon" aria-hidden="true">
                      {SECTION_EMOJI[closestSection ?? "other"] ?? SECTION_EMOJI.other}
                    </span>
                    <span className="modern-map-spot-body">
                      {closestDist && <span className="modern-map-spot-dist">{closestDist}</span>}
                      <span className="modern-map-spot-title">{pickLocalized(closest.name, locale)}</span>
                    </span>
                  </Link>
                  {closest.location && (
                    <ExtLink
                      className="modern-map-spot-route"
                      href={routeUrl(closest.location, me ?? base)}
                      label={t("miniapp.modern.routeTo", { name: pickLocalized(closest.name, locale) })}
                      onOpen={() => analytics.track("route_clicked", { placeId: closest.id })}
                    >
                      <span aria-hidden="true">🧭</span>
                      {t("miniapp.modern.route")}
                    </ExtLink>
                  )}
                </div>
              )
            }
          />
        </div>
      </div>
      <div className="modern-results-sheet" ref={sheetRef} aria-busy={loading}>
        <div className="modern-results-head">
          <div>
            <p className="modern-results-kicker">
              <span aria-hidden="true">🔥</span> {t("miniapp.modern.sortKicker")}
            </p>
            <p role="status" className="modern-results-count" data-testid="nearby-status">
              {loading
                ? t("miniapp.guide.loading")
                : closestDist
                  ? t("miniapp.modern.nearest", { n: visible.length, d: closestDist })
                  : t("miniapp.modern.results", { n: visible.length })}
            </p>
          </div>
          <p className="modern-results-radius" data-testid="radius-value">
            {t("miniapp.modern.radiusUpTo", { r: radiusLabel(selectedRadius) })}
          </p>
        </div>
        {list.length >= NEARBY_LIMIT && <p>{t("miniapp.nearby.limited", { n: NEARBY_LIMIT })}</p>}
        {visible.length ? (
          <PlaceList places={visible} quickRoute routeFrom={me ?? base} />
        ) : (
          <div className="modern-empty" data-testid="nearby-empty">
            <p>
              {list.length === 0
                ? t("miniapp.nearby.emptyRadius", { r: radiusLabel(radius) })
                : t("miniapp.modern.noMatches")}
            </p>
            {(query || section !== "all") && (
              <Button
                onClick={() => {
                  setQuery("");
                  setSection("all");
                }}
              >
                {t("miniapp.modern.reset")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
