// C05 «Що поруч»: места в радиусе от базовой точки (QR) или — по нажатию и с разрешения — от устройства.
// Подпись «Поруч із вами» только при полученной геолокации, иначе «Поруч із <база>».
import { useEffect, useMemo, useRef, useState } from "react";
import { pickLocalized } from "@tg/i18n";
import { useDesign } from "../design/DesignProvider.js";
import { useCategoryIndex } from "./categories.js";
import { ICONS } from "../design/Ornament.js";
import { Button, Stack, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { canOpenLocationSettings, requestLocation, type LatLng } from "./geo.js";
import type { Async } from "./context.js";
import { MapSlot, preloadMap } from "./MapSlot.js";
import { AsyncView, PlaceList } from "./parts.js";
import { OWN_MAP_SECTIONS, type PlaceSummary, type HomeSection } from "./types.js";

/** Ползунок радиуса, м: от 500 м до 10 км шагом 500 м. */
export const RADIUS_MIN = 500;
export const RADIUS_MAX = 10_000;
export const RADIUS_STEP = 500;
export const DEFAULT_RADIUS = 500;
/** Задержка запроса при перетаскивании ползунка, мс. */
export const RADIUS_DEBOUNCE_MS = 350;
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
  const { design } = useDesign();
  const RangePanel = design === "modern" ? "details" : "div";
  const [radius, setRadius] = useState<number>(DEFAULT_RADIUS);
  /** Радиус запроса — значение ползунка после паузы в перетаскивании. */
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
  const radiusText = useRadiusLabel()(radius);
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

  return (
    <div className={design === "modern" ? "modern-nearby" : undefined}>
      <Stack>
        <h1>{t("miniapp.nearby.title")}</h1>
        {caption && <p data-testid="nearby-caption">{caption}</p>}
        {geo.status === "denied" && (
          <p role="alert" data-testid="geo-off">
            {base?.point ? t("miniapp.nearby.geoOff", { base: base.name }) : t("miniapp.nearby.geoOffNoBase")}
          </p>
        )}
        {geo.status === "denied" && canOpenLocationSettings(webApp) && (
          <Button onClick={() => webApp?.LocationManager?.openSettings?.()}>
            {t("miniapp.nearby.openSettings")}
          </Button>
        )}
        <RangePanel className="kosiv-range">
          {design === "modern" && (
            <summary>
              {t("miniapp.nearby.radius")}
              <span>{radiusText}</span>
            </summary>
          )}
          <div className="kosiv-range-head">
            <label htmlFor="nearby-radius">{t("miniapp.nearby.radius")}</label>
            <output htmlFor="nearby-radius" data-testid="radius-value">
              {radiusText}
            </output>
          </div>
          <input
            id="nearby-radius"
            type="range"
            min={RADIUS_MIN}
            max={RADIUS_MAX}
            step={RADIUS_STEP}
            value={radius}
            aria-valuetext={radiusText}
            onChange={(e) => setRadius(Number(e.target.value))}
          />
        </RangePanel>
        {geo.status !== "granted" && (
          <Button
            className={design === "modern" ? "modern-locate" : undefined}
            disabled={geo.status === "locating"}
            onClick={locate}
          >
            {geo.status === "locating" ? t("miniapp.nearby.locating") : t("miniapp.nearby.useLocation")}
          </Button>
        )}
        {point ? (
          <NearbyPlaces
            point={point}
            radius={queryRadius}
            // Карта строится по местам и базовой точке и на устройство не центрируется; позиция устройства — только значок «Ви тут» (me).
            base={geo.status === "granted" ? null : (base?.point ?? null)}
            baseLabel={caption ?? undefined}
            me={geo.status === "granted" ? geo.point : null}
          />
        ) : (
          geo.status !== "locating" &&
          geo.status !== "denied" && <p data-testid="nearby-no-point">{t("miniapp.nearby.noBase")}</p>
        )}
      </Stack>
    </div>
  );
}

function NearbyPlaces({
  point,
  radius,
  base,
  baseLabel,
  me,
}: {
  point: LatLng;
  radius: number;
  base: LatLng | null;
  baseLabel?: string;
  me: LatLng | null;
}) {
  const { t } = useT();
  const { api } = useGuide();
  const { design } = useDesign();
  const label = useRadiusLabel();
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
      {({ list, radius: loaded }) =>
        design === "modern" ? (
          <ModernNearbyResults
            list={list}
            radius={loaded}
            base={base}
            baseLabel={baseLabel}
            me={me}
            loading={fresh.status === "loading"}
          />
        ) : (
          <Stack>
            {/* Круг, пустой текст и подписи — по радиусу загруженных данных, не по ползунку. */}
            <MapSlot
              places={list}
              center={base}
              centerLabel={baseLabel}
              radius={base ? loaded : undefined}
              // По геолокации места окружают устройство: без базовой точки не приближаем карту до двора туриста.
              maxZoom={base ? undefined : DEVICE_MAX_ZOOM}
              // Позиция устройства: только если геолокация уже получена (отдельный запрос не делаем).
              me={me}
            />
            {/* Статус обновления — под картой, в строке фиксированной высоты: карта не сдвигается. */}
            <p role="status" className="kosiv-muted kosiv-status-line" data-testid="nearby-status">
              {fresh.status === "loading"
                ? t("miniapp.guide.loading")
                : list.length >= NEARBY_LIMIT
                  ? t("miniapp.nearby.limited", { n: NEARBY_LIMIT })
                  : ""}
            </p>
            {list.length === 0 ? (
              <p data-testid="nearby-empty">{t("miniapp.nearby.emptyRadius", { r: label(loaded) })}</p>
            ) : (
              <PlaceList places={list} />
            )}
          </Stack>
        )
      }
    </AsyncView>
  );
}

/** Фильтры применяются к одной загруженной выборке: карта и список всегда согласованы. */
export function ModernNearbyResults({
  list,
  radius,
  base,
  baseLabel,
  me,
  loading,
}: {
  list: PlaceSummary[];
  radius: number;
  base: LatLng | null;
  baseLabel?: string;
  me: LatLng | null;
  loading: boolean;
}) {
  const { t, locale } = useT();
  const { api } = useGuide();
  const categories = useCategoryIndex(api);
  const radiusText = useRadiusLabel()(radius);
  const [view, setView] = useState<"map" | "list">("map");
  const [query, setQuery] = useState("");
  const [section, setSection] = useState<HomeSection | "all">("all");
  const sections = Array.from(
    new Set([
      ...(section === "all" ? [] : [section]),
      ...list.map((p) => categories.sectionOf(p.categoryId)).filter((s) => s !== null),
    ]),
  );
  // Стабильная ссылка: иначе карта пересоздаёт маркеры и сбрасывает охват на каждый рендер.
  const visible = useMemo(
    () =>
      list.filter(
        (p) =>
          (section === "all" || categories.sectionOf(p.categoryId) === section) &&
          `${pickLocalized(p.name, locale)} ${p.address ? pickLocalized(p.address, locale) : ""}`
            .toLocaleLowerCase(locale)
            .includes(query.trim().toLocaleLowerCase(locale)),
      ),
    [list, section, query, categories, locale],
  );
  return (
    <div className="modern-nearby-results">
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
      <div className="modern-filters" role="group" aria-label={t("miniapp.modern.filters")}>
        <button type="button" aria-pressed={section === "all"} onClick={() => setSection("all")}>
          {t("miniapp.modern.all")}
        </button>
        {sections.map((s) => (
          <button type="button" key={s} aria-pressed={section === s} onClick={() => setSection(s)}>
            {ICONS[s]}
            {t(`miniapp.section.${s}`)}
          </button>
        ))}
      </div>
      <div className="modern-view-switch" role="group" aria-label={t("miniapp.modern.views")}>
        {(["map", "list"] as const).map((v) => (
          <button type="button" key={v} aria-pressed={view === v} onClick={() => setView(v)}>
            {v === "map" ? ICONS.plan : ICONS.nearby}
            {t(`miniapp.modern.${v}`)}
          </button>
        ))}
      </div>
      {view === "map" && (
        <div className="modern-map-panel">
          <MapSlot
            places={visible}
            center={base}
            centerLabel={baseLabel}
            radius={base ? radius : undefined}
            maxZoom={base ? undefined : DEVICE_MAX_ZOOM}
            me={me}
          />
        </div>
      )}
      <div className="modern-results-sheet" aria-busy={loading}>
        <p role="status" className="modern-results-count" data-testid="nearby-status">
          {loading ? t("miniapp.guide.loading") : t("miniapp.modern.results", { n: visible.length })}
        </p>
        {list.length >= NEARBY_LIMIT && <p>{t("miniapp.nearby.limited", { n: NEARBY_LIMIT })}</p>}
        <p className="modern-origin">{baseLabel ?? t("miniapp.modern.origin")}</p>
        {visible.length ? (
          <PlaceList places={visible} quickRoute routeFrom={me ?? base} />
        ) : (
          <div className="modern-empty" data-testid="nearby-empty">
            <p>
              {list.length === 0
                ? t("miniapp.nearby.emptyRadius", { r: radiusText })
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
