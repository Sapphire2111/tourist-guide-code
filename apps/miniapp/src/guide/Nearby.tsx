// C05 «Що поруч»: места в радиусе от базовой точки (QR) или — по нажатию и с разрешения — от устройства.
// Подпись «Поруч із вами» только при полученной геолокации, иначе «Поруч із <база>».
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useCategoryIndex } from "./categories.js";
import { useScreenState } from "../screen-state.js";
import { ICONS, SECTION_EMOJI } from "../design/Ornament.js";
import { pickLocalized } from "@tg/i18n";
import { Button, Link, useT } from "@tg/ui";
import { useAsync, useGuide } from "./context.js";
import { canOpenLocationSettings, requestLocation, type LatLng } from "./geo.js";
import type { Async } from "./context.js";
import { MapSlot, preloadMap } from "./MapSlot.js";
import { AsyncView, PlaceList, useDistance } from "./parts.js";
import { RadiusSlider } from "./RadiusSlider.js";
import { OWN_MAP_SECTIONS, type Category, type PlaceSummary, type HomeSection } from "./types.js";

export const DEFAULT_RADIUS = 1000;
/** Задержка запроса при смене радиуса, мс. */
export const RADIUS_DEBOUNCE_MS = 350;
/**
 * Не больше стольких ближайших мест в радиусе до 20 км (сервер сортирует по расстоянию). 300 — чтобы на 10–15 км
 * карта покрывала весь круг (50 ближайших давали лишь ~3–5 км); маркеры кластеризуются.
 */
export const NEARBY_LIMIT = 300;
/** Предел масштаба карты для выдачи вокруг устройства (приватность: тайлы OSM выдают район). */
export const DEVICE_MAX_ZOOM = 14;
/** Карточек списка под картой за раз («Показати ще» — ещё столько же); карта получает все места. */
export const NEARBY_PAGE = 50;

/** Подпись радиуса: «500 м», «1,5 км», «10 км». */
export function useRadiusLabel(): (m: number) => string {
  const { t } = useT();
  return (m) =>
    m < 1000
      ? t("miniapp.nearby.meters", { n: m })
      : t("miniapp.place.distanceKm", { n: String(Math.round(m / 100) / 10).replace(".", ",") });
}

type NearbyResult = { list: PlaceSummary[]; radius: number };

/** Подразделы «Що поруч» в фильтрах (водоспади — в «Природа»): порядок и значок по коду категории. */
export const NEARBY_SUBS: Readonly<Record<string, string>> = { nature: "🌲", sights: "🏛️", peaks: "🏔️" };
/** Фильтр: всё, раздел главной или подраздел «Що поруч» (`cat:<id>`). */
type NearbyFilter = HomeSection | "all" | `cat:${string}`;

/** Подразделы «Що поруч» из выборки (природа, пам'ятки, вершини), в порядке NEARBY_SUBS. */
export function nearbySubs(list: readonly PlaceSummary[], byId: ReadonlyMap<string, Category>): Category[] {
  const order = Object.keys(NEARBY_SUBS);
  const found = new Map<string, Category>();
  for (const p of list) {
    const c = byId.get(p.categoryId);
    if (c?.code && c.code in NEARBY_SUBS) found.set(c.id, c);
  }
  return [...found.values()].sort((a, b) => order.indexOf(a.code!) - order.indexOf(b.code!));
}

type Geo = { status: "idle" | "locating" | "denied" } | { status: "granted"; point: LatLng };

export function Nearby({ useMyLocation }: { useMyLocation: boolean }) {
  const { t, locale } = useT();
  const { webApp, base } = useGuide();
  // Карта открывается большой («full»); «Список ↓» уменьшает её и прокручивает к листу, «Розгорнути» возвращает.
  const [mapMode, setMapMode] = useScreenState<"full" | "split">("nearby.mode", "full");
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
  const [radius, setRadius] = useScreenState<number>("nearby.radius", DEFAULT_RADIUS);
  /** Радиус запроса — выбранная пилюля после паузы (быстрые нажатия подряд дают один запрос). */
  const [queryRadius, setQueryRadius] = useState<number>(radius);
  useEffect(() => {
    if (radius === queryRadius) return;
    const timer = window.setTimeout(() => setQueryRadius(radius), RADIUS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [radius, queryRadius]);
  // Модуль карты и скрипт Google Maps — параллельно запросу мест (повторный вызов берёт тот же промис).
  useEffect(() => {
    preloadMap(locale).catch(() => undefined);
  }, [locale]);
  // Координаты устройства — только в памяти; при возврате на экран геолокация не запрашивается заново.
  const [geo, setGeo] = useScreenState<Geo>(
    "nearby.geo",
    { status: useMyLocation ? "locating" : "idle" },
    { inMemoryOnly: true },
  );

  // Запрос уже был: ушли с экрана, пока он шёл, — при возврате не спрашиваем снова без нажатия.
  const [asked, setAsked] = useScreenState("nearby.asked", false, { inMemoryOnly: true });
  const locate = () => {
    setAsked(true);
    setGeo({ status: "locating" });
    void requestLocation(webApp).then((point) =>
      setGeo(point ? { status: "granted", point } : { status: "denied" }),
    );
  };
  // «Що поруч зі мною зараз» с главной — запрос сразу (это и есть нажатие пользователя).
  useEffect(() => {
    if (geo.status !== "locating") return;
    if (asked) setGeo({ status: "idle" });
    else locate();
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
          onLocate={locate}
          locating={locating}
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
  onLocate,
  locating,
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
  onLocate?: () => void;
  locating?: boolean;
}) {
  const { api } = useGuide();
  const [fresh, retry] = useAsync(
    () =>
      api
        .search({ point, radius, excludeSections: OWN_MAP_SECTIONS, limit: NEARBY_LIMIT })
        .then((list) => ({ list, radius })),
    [api, point.lat, point.lng, radius],
    { slot: "nearby.places", key: `${point.lat},${point.lng},${radius}` },
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
          onLocate={onLocate}
          locating={locating}
          loading={fresh.status === "loading"}
        />
      )}
    </AsyncView>
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
  onLocate,
  locating,
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
  /** Кнопка «Ви тут» на карте вызывает определение места экрана (общее с кнопкой шапки). */
  onLocate?: () => void;
  locating?: boolean;
  loading: boolean;
}) {
  const { t, locale } = useT();
  const { api } = useGuide();
  const categories = useCategoryIndex(api);
  const radiusLabel = useRadiusLabel();
  const distanceLabel = useDistance();
  const [section, setSection] = useScreenState<NearbyFilter>("nearby.section", "all");
  const sections = Array.from(
    new Set([
      ...(section === "all" || section.startsWith("cat:") ? [] : [section as HomeSection]),
      // Раздел «Що поруч» — это сам экран: чип дублировал бы его (такие места видны в «Усі поруч»).
      ...list.map((p) => categories.sectionOf(p.categoryId)).filter((s) => s !== null && s !== "nearby"),
    ]),
  );
  // Стабильная ссылка: иначе карта пересоздаёт маркеры и сбрасывает охват на каждый рендер.
  // Места в списке под картой всегда идут от ближайшего к самому дальнему.
  // Природа / Пам'ятки / Вершини — подразделы самого «Що поруч» (выбранный остаётся, даже если выборка без него).
  const subs = nearbySubs(list, categories.byId);
  const selectedSub = section.startsWith("cat:") ? categories.byId.get(section.slice(4)) : undefined;
  if (selectedSub && !subs.some((c) => c.id === selectedSub.id)) subs.push(selectedSub);
  const visible = useMemo(
    () =>
      list
        .filter((p) =>
          section === "all"
            ? true
            : section.startsWith("cat:")
              ? p.categoryId === section.slice(4)
              : categories.sectionOf(p.categoryId) === section,
        )
        .sort(
          (a, b) =>
            (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY),
        ),
    [list, section, categories],
  );
  // Список под картой — страницами по NEARBY_PAGE (300 карточек сразу — тяжело); сброс при новой выборке/фильтре.
  const [page, setPage] = useState({ of: visible, n: NEARBY_PAGE });
  const shownCount = page.of === visible ? page.n : NEARBY_PAGE;
  const pageOf = useMemo(() => visible.slice(0, shownCount), [visible, shownCount]);
  const closest = visible[0];
  const closestDist = closest ? distanceLabel(closest.distanceMeters) : null;
  return (
    <div className="modern-nearby-results">
      <div className="modern-map-stage">
        <div className="modern-map-overlay" data-map-inset="top">
          {onRadius && (
            <RadiusSlider value={selectedRadius} onChange={(m) => m !== null && onRadius(m)} overlay />
          )}
          <div className="modern-filters" role="group" aria-label={t("miniapp.modern.filters")}>
            <button type="button" aria-pressed={section === "all"} onClick={() => setSection("all")}>
              <span aria-hidden="true">✦</span>
              {t("miniapp.modern.all")}
            </button>
            {subs.map((c) => (
              <button
                type="button"
                key={c.id}
                aria-pressed={section === `cat:${c.id}`}
                onClick={() => setSection(`cat:${c.id}`)}
                data-testid={`nearby-sub-${c.code}`}
              >
                <span aria-hidden="true">{NEARBY_SUBS[c.code!]}</span>
                {pickLocalized(c.name, locale)}
              </button>
            ))}
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
            radius={base || me ? radius : undefined}
            radiusCenter={base ?? me}
            maxZoom={base ? undefined : DEVICE_MAX_ZOOM}
            me={me}
            onLocate={onLocate}
            locating={locating}
            closestId={closest?.id}
            legend={false}
            floating
          />
        </div>
      </div>
      <div className="modern-results-sheet" ref={sheetRef} aria-busy={loading}>
        <div className="modern-results-head">
          <div>
            <p className="modern-results-kicker">
              <span aria-hidden="true">🔥</span>{" "}
              {me
                ? t("miniapp.modern.sortKicker")
                : baseTag
                  ? t("miniapp.modern.sortKickerBase", { base: baseTag })
                  : t("miniapp.modern.sortKicker")}
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
        {/* Раздел «Вершини» — из «Що поруч» (вершины — подкатегория этого раздела). */}
        <Link to="/peaks" className="modern-route peak-link" data-testid="nearby-peaks">
          <span aria-hidden="true">🏔️</span>
          {t("miniapp.peaks.link")}
        </Link>
        {list.length >= NEARBY_LIMIT && <p>{t("miniapp.nearby.limited", { n: NEARBY_LIMIT })}</p>}
        {visible.length ? (
          <>
            <PlaceList places={pageOf} quickRoute />
            {visible.length > shownCount && (
              <Button
                data-testid="nearby-more"
                onClick={() => setPage({ of: visible, n: shownCount + NEARBY_PAGE })}
              >
                {t("miniapp.nearby.showMore")}
              </Button>
            )}
          </>
        ) : (
          <div className="modern-empty" data-testid="nearby-empty">
            <p>
              {list.length === 0
                ? t("miniapp.nearby.emptyRadius", { r: radiusLabel(radius) })
                : t("miniapp.modern.noMatches")}
            </p>
            {section !== "all" && (
              <Button onClick={() => setSection("all")}>{t("miniapp.modern.reset")}</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
