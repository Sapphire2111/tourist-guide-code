// Карта мест на Google Maps JavaScript API (векторная карта, Map ID). Модуль грузится лениво (MapSlot, preloadMap) —
// в бюджет первого экрана не входит; скрипт API — google-maps.ts (один раз на сессию).
// Карта берётся из пула и не пересоздаётся: смена мест/радиуса перестраивает только маркеры, круг и линию.
// Маркеры — AdvancedMarker с цветом и значком раздела категории, рядом стоящие собираются в кластеры
// (@googlemaps/markerclusterer); подпись — по нажатию (InfoWindow), легенда — под картой.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { useRoute, useT } from "@tg/ui";
import { SECTION_EMOJI } from "../design/Ornament.js";
import { useTheme } from "../design/ThemeProvider.js";
import { useCategoryIndex } from "./categories.js";
import { useGuide } from "./context.js";
import type { LatLng } from "./geo.js";
import {
  acquireMap,
  loadMapsApi,
  mapsAuthFailed,
  onMapsAuthFailure,
  releaseMap,
  type MapsLibs,
  type PooledMap,
} from "./google-maps.js";
import type { HomeSection, PlaceSummary } from "./types.js";

export type PlacesMapProps = {
  places: PlaceSummary[];
  center: LatLng | null;
  /** Подпись базовой точки. Координаты устройства сюда не передаются (приватность: карта не центрируется на туристе). */
  centerLabel?: string;
  /** false — только центрировать карту, без метки/круга/пункта легенды (середина выбранных локаций — не точка). */
  centerMarker?: boolean;
  radius?: number;
  /** Предел приближения при fitBounds (по умолчанию 17). */
  maxZoom?: number;
  /** Маршрут: линия через места в порядке списка, номера остановок на маркерах (ассистент, план дня). */
  route?: boolean;
  /** Позиция устройства («Ви тут»), если геолокация уже получена. Карту не центрирует и границы не меняет. */
  me?: LatLng | null;
  /** Место, подсвеченное как ближайшее («Поруч»): только оно получает акцент; в каталоге и маршрутах не задаётся. */
  closestId?: string;
  /** Плавающий элемент поверх нижней части карты («Поруч»): его размеры, как и верхней панели [data-map-inset], учитываются в fitBounds. */
  overlay?: ReactNode;
  /** Короткая подпись базовой точки на карте («Поруч»: название; подпись значка для читалки — centerLabel). */
  centerTag?: string;
  /** false — без легенды под картой («Поруч»: значок категории уже на капсуле маркера). */
  legend?: boolean;
  /** Карта-сцена («Поруч»): оранжевый круг радиуса, кнопки масштаба посередине справа. Не зависит от того, есть ли плашка. */
  floating?: boolean;
};

/** Группа маркера: раздел главной категории места или «Інше». */
export type MarkerGroup =
  | Extract<HomeSection, "stay" | "eat" | "shop" | "relax" | "fun" | "ski" | "transfer" | "services">
  | "other";

/** Цвета групп (контраст ≥ 3:1 к светлой подложке карты — графический объект, WCAG 1.4.11). */
export const MARKER_COLORS: Record<MarkerGroup, string> = {
  stay: "#0e7490",
  eat: "#c2410c",
  shop: "#7c3aed",
  relax: "#1d4ed8",
  fun: "#be185d",
  ski: "#0369a1",
  transfer: "#047857",
  services: "#4d7c0f",
  other: "#57534e",
};
const BASE_COLOR = "#111827";
/** Линия маршрута: тёмный пунктир на светлой карте, светлый — на тёмной («Ніч»). */
export const ROUTE_COLOR = { day: BASE_COLOR, night: "#fde68a" } as const;
/** Подложка до загрузки тайлов. */
export const MAP_BACKDROP = { day: "#e5e3df", night: "#0e231b" } as const;

/** Значки групп: контур 24×24 (stroke белым по цвету группы). Константы, не пользовательские данные. */
const MARKER_ICONS: Record<MarkerGroup, string> = {
  stay: "M3 18v-7h18v7M3 11V6M21 11a3 3 0 0 0-3-3h-6v3M7 8.5h.01",
  eat: "M7 3v18M5 3v5a2 2 0 0 0 4 0V3M17 21V3c-2 0-3 2-3 6s1 4 3 4",
  shop: "M6 8h12l-1 13H7L6 8zM9 8V6a3 3 0 0 1 6 0v2",
  relax: "M12 3l5 8h-3l4 6H6l4-6H7l5-8zM12 17v4",
  fun: "M12 3l2.6 5.6 6 .7-4.4 4.1 1.2 6L12 16.5 6.6 19.4l1.2-6L3.4 9.3l6-.7L12 3z",
  ski: "M3 20l6-11 4 6 2-3 6 8H3z",
  transfer: "M5 17V9l2-4h10l2 4v8M5 13h14M8 17v2M16 17v2",
  services: "M12 11v6M12 7.5h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  other: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
};

export function markerGroup(section: HomeSection | null): MarkerGroup {
  return section && section in MARKER_COLORS ? (section as MarkerGroup) : "other";
}

function groupLabel(g: MarkerGroup): MessageKey {
  return g === "other" ? "miniapp.map.other" : (`miniapp.section.${g}` as MessageKey);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Значок маркера места: круг цвета группы, внутри значок раздела или номер остановки маршрута. */
export function pinNode(
  group: MarkerGroup,
  stop: number | null,
  distance?: string,
  closest?: boolean,
): HTMLElement {
  const pin = document.createElement("div");
  pin.className = "kosiv-pin";
  pin.dataset.group = group;
  // Цвет группы — переменная: фон круга и акценты капсулы расстояния (modern.css) берут её, а не inline background.
  pin.style.setProperty("--pin-color", MARKER_COLORS[group]);
  if (stop !== null) {
    pin.textContent = String(stop);
    return pin;
  }
  if (distance) {
    // Капсула с расстоянием («Поруч»): значок раздела и метраж (текст — data-distance, modern.css).
    pin.dataset.distance = distance;
    if (closest) pin.dataset.closest = "true";
    const emoji = document.createElement("span");
    emoji.setAttribute("aria-hidden", "true");
    emoji.textContent = SECTION_EMOJI[group] ?? SECTION_EMOJI.other!;
    pin.appendChild(emoji);
    return pin;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", MARKER_ICONS[group]);
  svg.appendChild(path);
  pin.appendChild(svg);
  return pin;
}

/** Содержимое подписи маркера: название, категория, ссылка на карточку (только textContent — XSS из названия места). */
export function popupNode(
  name: string,
  category: string,
  id: string,
  openText: string,
  navigate: (to: string) => void,
): HTMLElement {
  const box = document.createElement("div");
  box.className = "kosiv-map-popup";
  const title = document.createElement("strong");
  title.textContent = name;
  const cat = document.createElement("span");
  cat.textContent = category;
  const link = document.createElement("a");
  link.href = `#/place/${encodeURIComponent(id)}`;
  link.textContent = openText;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    navigate(`/place/${encodeURIComponent(id)}`);
  });
  box.append(title, cat, link);
  return box;
}

/** Цвет акцента сезона (--app-accent) для кругов карты: у Circle нет CSS, только значение. */
function accentColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--app-accent").trim();
  return v || "#2d6a4f";
}

/** С какого числа маркеров рядом стоящие собираются в кластеры. */
export const CLUSTER_MIN = 12;

type Libs = { status: "loading" } | { status: "ready"; libs: MapsLibs } | { status: "error" };

/** Объекты карты одного экрана: убираются при смене данных и при уходе (карта возвращается в пул чистой). */
type Overlays = {
  clusterer: MarkerClusterer | null;
  markers: { marker: google.maps.marker.AdvancedMarkerElement; place: PlaceSummary; stop: number | null }[];
  /** Снятие прочих объектов (база, круг, линия). */
  other: (() => void)[];
  listeners: google.maps.MapsEventListener[];
  /** Отложенная установка вида (requestAnimationFrame). */
  frame: number | null;
};

export default function PlacesMap({
  places,
  center,
  centerLabel,
  centerMarker = true,
  radius,
  maxZoom = 17,
  route = false,
  me,
  closestId,
  overlay,
  centerTag,
  legend = true,
  floating = false,
}: PlacesMapProps) {
  const { t, locale } = useT();
  // Тема — из контекста, а не из DOM: data-theme ставится эффектом ThemeProvider, то есть после эффектов детей.
  const night = useTheme().theme === "night";
  const [, navigate] = useRoute();
  const { api } = useGuide();
  const index = useCategoryIndex(api);
  const el = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<Libs>({ status: "loading" });
  const [map, setMap] = useState<PooledMap | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  const overlays = useRef<Overlays>({ clusterer: null, markers: [], other: [], listeners: [], frame: null });
  /** Установка вида под текущий размер карты (задаёт эффект маркеров); вызывается и при смене размера контейнера. */
  const applyView = useRef<(() => void) | null>(null);
  /** Пользователь сам двигал карту (dragstart): автоподгонка при смене размера её не сбрасывает. */
  const userMoved = useRef(false);
  // Тексты подписи читаются при открытии: смена языка не требует пересоздавать маркеры.
  const tRef = useRef(t);
  tRef.current = t;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const indexRef = useRef(index);
  indexRef.current = index;

  // API — один раз на сессию; язык подписей карты — язык интерфейса при первой загрузке.
  useEffect(() => {
    let alive = true;
    loadMapsApi(localeRef.current).then(
      // Ключ уже отклонён (gm_authFailure на прошлом экране) — API «загружен», но карта была бы серой заглушкой Google.
      (libs) => alive && setState(mapsAuthFailed() ? { status: "error" } : { status: "ready", libs }),
      () => alive && setState({ status: "error" }),
    );
    const off = onMapsAuthFailure(() => alive && setState({ status: "error" }));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Карта из пула — одна на экран; при уходе возвращается в пул (новой платной загрузки не будет).
  // Смена темы на открытом экране — другая карта из пула (схема задаётся при создании), маркеры строятся на ней заново.
  const libs = state.status === "ready" ? state.libs : null;
  useEffect(() => {
    if (!libs || !el.current) return;
    const item = acquireMap(libs, el.current, night);
    const info = new libs.maps.InfoWindow();
    infoRef.current = info;
    const o = overlays.current;
    setMap(item);
    return () => {
      info.close();
      infoRef.current = null;
      clearOverlays(o);
      o.clusterer?.setMap(null);
      o.clusterer = null;
      setMap(null);
      releaseMap(item);
    };
  }, [libs, night]);

  // Карточка поверх низа карты закрыла бы кнопки масштаба (по умолчанию справа внизу) — на этом экране они посередине справа.
  useEffect(() => {
    if (!libs || !map || !floating) return;
    const m = map.map;
    m.setOptions({ zoomControlOptions: { position: libs.core.ControlPosition.RIGHT_CENTER } });
    return () => m.setOptions({ zoomControlOptions: { position: libs.core.ControlPosition.RIGHT_BOTTOM } });
  }, [libs, map, floating]);

  useEffect(() => {
    if (!map) return;
    const l = map.map.addListener("dragstart", () => {
      userMoved.current = true;
    });
    return () => l.remove();
  }, [map]);

  // Маркеры, круг, линия и границы — только при смене мест, базы, радиуса или режима маршрута.
  useEffect(() => {
    // Тема сменилась, а карта в состоянии ещё прежней схемы (эффект выбора карты поставит новую следующим проходом):
    // ничего не строим — иначе кластеризатор окажется на карте, которую уже сняли с экрана.
    if (!libs || !map || map.night !== night) return;
    userMoved.current = false;
    const o = overlays.current;
    const m = map.map;
    infoRef.current?.close();
    clearOverlays(o);
    const bounds = new libs.core.LatLngBounds();
    let points = 0;
    if (center && centerMarker) {
      const base = document.createElement("div");
      base.className = "kosiv-pin kosiv-pin-base";
      base.style.setProperty("--pin-color", BASE_COLOR);
      // Не нажимается: подпись — на значке (role=img), а не title маркера (aria-label без роли — нарушение a11y).
      base.setAttribute("role", "img");
      base.setAttribute("aria-label", centerLabel ?? tRef.current("miniapp.map.base"));
      if (centerTag) base.dataset.label = centerTag;
      const baseMarker = new libs.marker.AdvancedMarkerElement({
        map: m,
        position: center,
        content: base,
        zIndex: 900,
      });
      o.other.push(() => (baseMarker.map = null));
      if (radius) {
        o.other.push(
          detach(
            new libs.maps.Circle({
              map: m,
              center,
              radius,
              strokeColor: floating ? "#E06D2B" : "#1d4ed8",
              strokeWeight: floating ? 1.5 : 1,
              fillColor: floating ? "#E06D2B" : "#1d4ed8",
              fillOpacity: floating ? 0.08 : 0.05,
              clickable: false,
            }),
          ),
        );
      }
    }
    if (center) {
      bounds.extend(center);
      points++;
    }
    const located = places.filter((p) => p.location);
    if (route && located.length > 1) {
      // Пунктир под маркерами: порядок обхода — номера на маркерах и в списке под картой.
      o.other.push(
        detach(
          new libs.maps.Polyline({
            map: m,
            path: located.map((p) => ({ lat: p.location!.lat, lng: p.location!.lng })),
            strokeOpacity: 0,
            clickable: false,
            icons: [
              {
                icon: {
                  path: "M 0,-1 0,1",
                  strokeOpacity: 0.8,
                  strokeColor: night ? ROUTE_COLOR.night : ROUTE_COLOR.day,
                  scale: 3,
                },
                offset: "0",
                repeat: "12px",
              },
            ],
          }),
        ),
      );
    }
    const fmtDist = (m?: number | null) =>
      m == null
        ? undefined
        : m < 1000
          ? tRef.current("miniapp.place.distance", { n: Math.round(m) })
          : tRef.current("miniapp.place.distanceKm", { n: (m / 1000).toFixed(1).replace(".", ",") });
    located.forEach((p, i) => {
      const group = markerGroup(indexRef.current.sectionOf(p.categoryId));
      const stop = route ? i + 1 : null;
      const marker = new libs.marker.AdvancedMarkerElement({
        position: { lat: p.location!.lat, lng: p.location!.lng },
        title: pickLocalized(p.name, localeRef.current),
        content: pinNode(
          group,
          stop,
          fmtDist(p.distanceMeters),
          p.id === closestId && p.distanceMeters != null,
        ),
        gmpClickable: true,
      });
      marker.addEventListener("gmp-click", () => {
        const idx = indexRef.current;
        const cat = idx.byId.get(p.categoryId);
        const g = markerGroup(idx.sectionOf(p.categoryId));
        const lc = localeRef.current;
        const tr = tRef.current;
        const catName = cat ? pickLocalized(cat.name, lc) : tr(groupLabel(g));
        const info = infoRef.current;
        if (!info) return;
        info.setContent(
          popupNode(pickLocalized(p.name, lc), catName, p.id, tr("miniapp.map.open"), (to) =>
            navigateRef.current(to),
          ),
        );
        info.open({ map: m, anchor: marker });
      });
      o.markers.push({ marker, place: p, stop });
      bounds.extend(p.location!);
      points++;
    });
    // Кластеры — только когда маркеров много; маршрут не кластеризуется (видны все остановки по порядку).
    if (!route && o.markers.length >= CLUSTER_MIN) {
      o.clusterer ??= new MarkerClusterer({ map: m });
      o.clusterer.addMarkers(o.markers.map((x) => x.marker));
    } else for (const { marker } of o.markers) marker.map = m;

    // Вид — в следующем кадре: карта из пула только что вставлена в новый узел, сначала она должна увидеть его
    // размер (resize), иначе fitBounds посчитает границы по старому (или нулевому) размеру.
    const core = libs.core;
    const view = () => {
      if (points > 1) {
        // fitBounds без предела: приближение ограничиваем один раз после подгонки (пользователь может приблизить сам).
        o.listeners.push(
          core.event.addListenerOnce(m, "idle", () => {
            if ((m.getZoom() ?? 0) > maxZoom) m.setZoom(maxZoom);
          }),
        );
        m.fitBounds(bounds, fitPadding(el.current));
      } else if (points === 1) {
        m.setCenter(bounds.getCenter());
        m.setZoom(Math.min(16, maxZoom));
      } else {
        m.setCenter({ lat: 48.45, lng: 24.55 });
        m.setZoom(12);
      }
    };
    applyView.current = view;
    o.frame = requestAnimationFrame(() => {
      o.frame = null;
      core.event.trigger(m, "resize");
      view();
    });
    // Тексты подписей, справочник и navigate — через ref (читаются при открытии; перекраска — ниже).
  }, [
    libs,
    map,
    places,
    center,
    centerLabel,
    centerTag,
    centerMarker,
    radius,
    maxZoom,
    route,
    closestId,
    floating,
    night,
  ]);

  // Размер окна карты изменился («Список ↓» / «Розгорнути», поворот, низкий экран): карте сообщается новый размер и
  // границы подгоняются заново — с актуальными отступами под панели (они читаются в момент подгонки). Пауза 120 мс —
  // чтобы не подгонять на каждом кадре анимации высоты.
  useEffect(() => {
    const host = el.current;
    if (!libs || !map || !host || typeof ResizeObserver === "undefined") return;
    let w = host.clientWidth;
    let h = host.clientHeight;
    let timer: number | undefined;
    // Явная смена размера — «Список ↓» / «Розгорнути» (data-map-mode предка «Поруч»): подгоняем всегда.
    // Прочая (клавиатура, dvh, поворот) — только если пользователь не двигал карту сам.
    const modeOf = () => host.closest<HTMLElement>("[data-map-mode]")?.dataset.mapMode ?? "";
    let mode = modeOf();
    let explicit = false;
    const observer = new ResizeObserver(() => {
      if (Math.abs(host.clientWidth - w) < 2 && Math.abs(host.clientHeight - h) < 2) return;
      w = host.clientWidth;
      h = host.clientHeight;
      if (modeOf() !== mode) {
        mode = modeOf();
        explicit = true;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        libs.core.event.trigger(map.map, "resize");
        if (explicit) userMoved.current = false;
        if (!userMoved.current) applyView.current?.();
        explicit = false;
      }, 120);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [libs, map]);

  // Значок «Ви тут»: перестраивается только он и круг точности (карта, маркеры мест и границы не трогаются).
  const meLat = me?.lat;
  const meLng = me?.lng;
  const meAccuracy = me?.accuracy;
  const meLabel = t("miniapp.map.me");
  useEffect(() => {
    if (!libs || !map || meLat === undefined || meLng === undefined) return;
    const position = { lat: meLat, lng: meLng };
    const items: (() => void)[] = [];
    if (meAccuracy) {
      const color = accentColor();
      items.push(
        detach(
          new libs.maps.Circle({
            map: map.map,
            center: position,
            radius: meAccuracy,
            strokeColor: color,
            strokeWeight: 1,
            fillColor: color,
            fillOpacity: 0.12,
            clickable: false,
          }),
        ),
      );
    }
    const node = document.createElement("div");
    node.className = "kosiv-me";
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", meLabel);
    node.dataset.testid = "map-me";
    node.dataset.label = meLabel;
    const pulse = document.createElement("span");
    pulse.className = "kosiv-me-pulse";
    const dot = document.createElement("span");
    dot.className = "kosiv-me-dot";
    node.append(pulse, dot);
    const marker = new libs.marker.AdvancedMarkerElement({
      map: map.map,
      position,
      content: node,
      zIndex: 1000,
    });
    items.push(() => (marker.map = null));
    return () => {
      for (const off of items) off();
    };
  }, [libs, map, meLat, meLng, meAccuracy, meLabel]);

  // Пришёл справочник категорий — перекраска без пересоздания маркеров и без закрытия открытой подписи.
  useEffect(() => {
    for (const { marker, place, stop } of overlays.current.markers) {
      const group = markerGroup(index.sectionOf(place.categoryId));
      const prev = marker.content as HTMLElement | null;
      if (prev?.dataset?.group !== group)
        marker.content = pinNode(group, stop, prev?.dataset?.distance, prev?.dataset?.closest === "true");
    }
  }, [index]);

  const groups = [
    ...new Set(places.filter((p) => p.location).map((p) => markerGroup(index.sectionOf(p.categoryId)))),
  ];

  // Карта не загрузилась: заглушка, а плашка с ближайшим местом и маршрутом остаётся (список рядом тоже).
  if (state.status === "error")
    return (
      <>
        <p role="alert">{t("miniapp.map.error")}</p>
        {overlay}
      </>
    );

  // Карта дублирует список рядом: маркеры — не единственный путь к месту (клавиатура и чтение с экрана — список).
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="kosiv-map-frame" style={{ position: "relative" }}>
        <div
          ref={el}
          role="region"
          aria-label={t("miniapp.map.label")}
          aria-busy={map ? undefined : true}
          data-testid="places-map"
          style={{
            height: 260,
            borderRadius: "var(--radius)",
            overflow: "hidden",
            background: night ? MAP_BACKDROP.night : MAP_BACKDROP.day,
          }}
        />
        {overlay}
      </div>
      {legend && (groups.length > 0 || (center && centerMarker)) && (
        <ul className="kosiv-map-legend" aria-label={t("miniapp.map.legend")} data-testid="map-legend">
          {center && centerMarker && (
            <li>
              <i aria-hidden="true" style={{ background: BASE_COLOR }} />
              {centerLabel ?? t("miniapp.map.base")}
            </li>
          )}
          {groups.map((g) => (
            <li key={g} data-group={g}>
              <i aria-hidden="true" style={{ background: MARKER_COLORS[g] }} />
              {t(groupLabel(g))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const FIT_PADDING = 24;

/** Отступы fitBounds: 24 px, а под плавающие панели «Поруч» (верх — поиск и фильтры, низ — карточка) — их фактический размер. */
function fitPadding(host: HTMLElement | null): google.maps.Padding {
  const base = { top: FIT_PADDING, right: FIT_PADDING, bottom: FIT_PADDING, left: FIT_PADDING };
  const stage = host?.closest(".modern-map-stage");
  if (!host || !stage) return base;
  const map = host.getBoundingClientRect();
  const top = stage.querySelector('[data-map-inset="top"]')?.getBoundingClientRect();
  const bottom = stage.querySelector('[data-map-inset="bottom"]')?.getBoundingClientRect();
  // Запас 16 px: маркер (капсула 30 px высотой привязана центром к точке) не должен касаться края панели.
  if (top) base.top = Math.max(base.top, Math.ceil(top.bottom - map.top) + 16);
  if (bottom) base.bottom = Math.max(base.bottom, Math.ceil(map.bottom - bottom.top) + 16);
  // Панели не должны съесть карту: вместе не больше 70% высоты, иначе fitBounds нечего вписывать.
  const room = map.height * 0.7;
  const used = base.top + base.bottom;
  if (used > room) {
    base.top = Math.round((base.top * room) / used);
    base.bottom = Math.round((base.bottom * room) / used);
  }
  return base;
}

function clearOverlays(o: Overlays): void {
  if (o.frame !== null) cancelAnimationFrame(o.frame);
  o.frame = null;
  for (const l of o.listeners) l.remove();
  o.listeners = [];
  o.clusterer?.clearMarkers();
  for (const { marker } of o.markers) marker.map = null;
  o.markers = [];
  for (const off of o.other) off();
  o.other = [];
}

/** Предзагрузка скрипта API (MapSlot.preloadMap): параллельно запросу мест. */
export function preloadApi(language?: string): Promise<unknown> {
  return loadMapsApi(language);
}

function detach(overlay: { setMap(map: null): void }): () => void {
  return () => overlay.setMap(null);
}
