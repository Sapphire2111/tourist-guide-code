// Карта мест на Google Maps JavaScript API (векторная карта, Map ID). Модуль грузится лениво (MapSlot, preloadMap) —
// в бюджет первого экрана не входит; скрипт API — google-maps.ts (один раз на сессию).
// Карта берётся из пула и не пересоздаётся: смена мест/радиуса перестраивает только маркеры, круг и линию.
// Маркеры — AdvancedMarker с цветом и значком раздела категории, рядом стоящие собираются в кластеры
// (@googlemaps/markerclusterer); подпись — по нажатию (InfoWindow), легенда — под картой.
import { useEffect, useRef, useState } from "react";
import { MarkerClusterer } from "@googlemaps/markerclusterer";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { useRoute, useT } from "@tg/ui";
import { ICONS, SECTION_EMOJI } from "../design/Ornament.js";
import { useTheme } from "../design/ThemeProvider.js";
import { useCategoryIndex } from "./categories.js";
import { useGuide } from "./context.js";
import { googleRouteUrl, requestLocation, type LatLng } from "./geo.js";
import { useLocations } from "./LocationProvider.js";
import { DEVICE_MAX_ZOOM } from "./Nearby.js";
import {
  acquireMap,
  loadMapsApi,
  mapsAuthFailed,
  onMapsAuthFailure,
  releaseMap,
  type MapsLibs,
  type PooledMap,
} from "./google-maps.js";
import { coverCreditText } from "./parts.js";
import type { HomeSection, Photo, PlaceSummary } from "./types.js";

export type PlacesMapProps = {
  places: PlaceSummary[];
  center: LatLng | null;
  /** Подпись базовой точки. Автоматически карта на устройство не центрируется (приватность); только по кнопке «Ви тут». */
  centerLabel?: string;
  /** false — только центрировать карту, без метки/круга/пункта легенды (середина выбранных локаций — не точка). */
  centerMarker?: boolean;
  radius?: number;
  /** Центр круга радиуса, если базовой метки нет («Поруч» по геолокации — круг вокруг «Ви тут»). По умолчанию — center. */
  radiusCenter?: LatLng | null;
  /** Предел приближения при fitBounds (по умолчанию 17). */
  maxZoom?: number;
  /** Маршрут: линия через места в порядке списка, номера остановок на маркерах (ассистент, план дня). */
  route?: boolean;
  /** Позиция устройства («Ви тут»), если геолокация уже получена. Сама карту не центрирует и границы не меняет — только кнопка «Ви тут». */
  me?: LatLng | null;
  /** Кнопка «Ви тут», когда позиции ещё нет: родитель сам определяет место (список, радиус и подпись переключаются на пользователя). */
  onLocate?: () => void;
  /** Родитель определяет место сейчас (кнопка занята). */
  locating?: boolean;
  /** Место, подсвеченное как ближайшее («Поруч»): только оно получает акцент; в каталоге и маршрутах не задаётся. */
  closestId?: string;
  /** Короткая подпись базовой точки на карте («Поруч»: название; подпись значка для читалки — centerLabel). */
  centerTag?: string;
  /** false — без легенды под картой («Поруч»: значок категории уже на капсуле маркера). */
  legend?: boolean;
  /** Карта-сцена («Поруч»): оранжевый круг радиуса, кнопки масштаба посередине справа. */
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

export type PopupData = {
  name: string;
  category: string;
  id: string;
  /** Подпись расстояния («524 м»), если сервер его вернул. */
  distance?: string;
  /** Значок раздела: вместо фото, если обложки нет или она не загрузилась. */
  icon: string;
  /** Обложка места; null — компактный вид со значком, без пустого прямоугольника. */
  cover?: Photo | null;
  coverAlt: string;
  /** Подпись автора и лицензии обложки (обязательна для Google и Wikimedia). */
  creditText?: string;
  openText: string;
  routeText: string;
  routeLabel: string;
  routeHref: string;
  closeText: string;
  navigate: (to: string) => void;
  /** Нажатие на внешнюю ссылку: Telegram открывает её через openLink. */
  openExternal: (e: Event, href: string) => void;
  onRoute: () => void;
  onClose: () => void;
};

/** Содержимое окна маркера: обложка, название, категория, расстояние, «Маршрут» и карточка (только textContent — XSS из данных места). */
export function popupNode(d: PopupData): HTMLElement {
  const box = document.createElement("div");
  box.className = "kosiv-map-popup";
  const head = document.createElement("div");
  head.className = "kosiv-map-popup-head";
  const showIcon = () => {
    box.dataset.cover = "none";
    const icon = document.createElement("span");
    icon.className = "kosiv-map-popup-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = d.icon;
    head.prepend(icon);
  };
  const close = document.createElement("button");
  close.type = "button";
  close.className = "kosiv-map-popup-close";
  close.setAttribute("aria-label", d.closeText);
  close.textContent = "×";
  close.addEventListener("click", d.onClose);
  // Первой в порядке Tab: на экране она поверх фото (z-index в kosiv.css).
  box.append(close);
  const titles = document.createElement("div");
  titles.className = "kosiv-map-popup-titles";
  const title = document.createElement("strong");
  title.textContent = d.name;
  const cat = document.createElement("span");
  cat.textContent = d.distance ? `${d.category} · ${d.distance}` : d.category;
  titles.append(title, cat);
  head.append(titles);
  if (d.cover) {
    box.dataset.cover = "photo";
    const media = document.createElement("div");
    media.className = "kosiv-map-popup-media";
    const img = document.createElement("img");
    img.alt = d.coverAlt;
    img.setAttribute("loading", "lazy");
    img.setAttribute("decoding", "async");
    // Файл не загрузился: окно без картинки и без её подписи, со значком раздела.
    img.addEventListener("error", () => {
      media.remove();
      showIcon();
    });
    img.src = d.cover.url;
    media.append(img);
    if (d.creditText) {
      const credit = document.createElement("span");
      credit.className = "kosiv-map-popup-credit";
      credit.dataset.testid = "cover-credit";
      const source = d.cover.credit;
      if (source?.source === "wikimedia" && source.sourceUrl) {
        const href = source.sourceUrl;
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = d.creditText;
        a.addEventListener("click", (e) => d.openExternal(e, href));
        credit.append(a);
      } else credit.textContent = d.creditText;
      media.append(credit);
    }
    box.append(media);
  } else showIcon();
  const actions = document.createElement("div");
  actions.className = "kosiv-map-popup-actions";
  const route = document.createElement("a");
  route.className = "kosiv-map-popup-route";
  route.href = d.routeHref;
  route.target = "_blank";
  route.rel = "noopener noreferrer";
  route.textContent = d.routeText;
  route.setAttribute("aria-label", d.routeLabel);
  route.addEventListener("click", (e) => {
    d.onRoute();
    d.openExternal(e, d.routeHref);
  });
  const link = document.createElement("a");
  link.className = "kosiv-map-popup-open";
  link.href = `#/place/${encodeURIComponent(d.id)}`;
  link.textContent = d.openText;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    d.navigate(`/place/${encodeURIComponent(d.id)}`);
  });
  actions.append(route, link);
  box.append(head, actions);
  return box;
}

/** Меньше свободной высоты под панелью — окно без фото: иначе оно не поместится и закроет маркер. */
export const POPUP_PHOTO_MIN_FREE = 220;

/** Цвет акцента сезона (--app-accent) для кругов карты: у Circle нет CSS, только значение. */
function accentColor(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--app-accent").trim();
  return v || "#2d6a4f";
}

/** Цвет пунктирного круга радиуса на тёмной карте («Ніч»). */
const RING_COLOR_NIGHT = "#fde68a";
const EARTH_R = 6_371_000;

/** Точка на расстоянии dist м от center по азимуту bearing (рад) — сферическая формула. */
function offsetPoint(center: LatLng, dist: number, bearing: number): LatLng {
  const rad = Math.PI / 180;
  const d = dist / EARTH_R;
  const lat1 = center.lat * rad;
  const lng1 = center.lng * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: lat2 / rad, lng: lng2 / rad };
}

/** Окружность радиуса radius м вокруг center: RING_POINTS вершин, замкнутая. */
export const RING_POINTS = 72;
export function circlePath(center: LatLng, radius: number): LatLng[] {
  return Array.from({ length: RING_POINTS + 1 }, (_, i) =>
    offsetPoint(center, radius, ((i % RING_POINTS) / RING_POINTS) * 2 * Math.PI),
  );
}

/** Север, восток, юг, запад круга — для fitBounds. */
function circleExtremes(center: LatLng, radius: number): LatLng[] {
  return [0, 1, 2, 3].map((k) => offsetPoint(center, radius, (k * Math.PI) / 2));
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
  radiusCenter,
  maxZoom = 17,
  route = false,
  me,
  onLocate,
  locating: parentLocating = false,
  closestId,
  centerTag,
  legend = true,
  floating = false,
}: PlacesMapProps) {
  const { t, locale } = useT();
  // Тема — из контекста, а не из DOM: data-theme ставится эффектом ThemeProvider, то есть после эффектов детей.
  const night = useTheme().theme === "night";
  const [, navigate] = useRoute();
  const guide = useGuide();
  const { api } = guide;
  const guideRef = useRef(guide);
  guideRef.current = guide;
  const index = useCategoryIndex(api);
  const el = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<Libs>({ status: "loading" });
  const [map, setMap] = useState<PooledMap | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  // Кнопка «Ви тут»: позиция, полученная по нажатию (если родитель её не передал), подсказка и состояние поиска.
  const { gps } = useLocations();
  const [located, setLocated] = useState<LatLng | null>(null);
  const [ownLocating, setLocating] = useState(false);
  const locating = ownLocating || parentLocating;
  /** Подсказка при отказе: "center" — карта показывает точку поиска; "none" — карта не сдвинута. */
  const [hint, setHint] = useState<"center" | "none" | null>(null);
  /** Карта этого экрана (пул): после долгого запроса геолокации она могла уйти другому экрану. */
  const liveMap = useRef<PooledMap | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const shownMe = me ?? located;
  /** Откуда открыто окно маркера: туда возвращается фокус при закрытии. */
  const openerRef = useRef<HTMLElement | null>(null);
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
    // Без служебной строки заголовка (своя кнопка закрытия поверх окна) и без автосдвига Google: он не знает о панели над картой.
    const info = new libs.maps.InfoWindow({ headerDisabled: true, disableAutoPan: true });
    infoRef.current = info;
    const ready = info.addListener("domready", () => {
      setPopupOpen(true);
      requestAnimationFrame(() => panPopupIntoView(item.map, el.current));
    });
    const o = overlays.current;
    setMap(item);
    liveMap.current = item;
    // Кнопки масштаба лежат выше окна: на узкой карте они прячутся на время, пока окно открыто (panPopupIntoView).
    const closed = info.addListener("close", () => {
      setPopupOpen(false);
      item.map.setOptions({ zoomControl: true });
      // Фокус был в окне (или пропал вместе с ним) — обратно на маркер; маркер уже снят с карты — некуда, остаётся как есть.
      const opener = openerRef.current;
      openerRef.current = null;
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || active.closest(".kosiv-map-popup")))
        opener.focus({ preventScroll: true });
    });
    return () => {
      liveMap.current = null;
      setPopupOpen(false);
      ready.remove();
      closed.remove();
      item.map.setOptions({ zoomControl: true });
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
    }
    // Круг — вокруг базы или (без базы) вокруг точки запроса: при геолокации базы нет, а круг нужен.
    const ringCenter = radiusCenter ?? (centerMarker ? center : null);
    if (radius && ringCenter) {
      const dayColor = floating ? "#B8430F" : "#1d4ed8";
      const ringColor = night ? RING_COLOR_NIGHT : dayColor;
      // Лёгкая заливка — отдельный Circle без обводки; граница — пунктирная линия по точкам окружности
      // (google.maps.Circle штрихов не умеет): видно, почему за кругом нет мест.
      o.other.push(
        detach(
          new libs.maps.Circle({
            map: m,
            center: ringCenter,
            radius,
            strokeOpacity: 0,
            strokeWeight: 0,
            fillColor: night ? RING_COLOR_NIGHT : floating ? "#E06D2B" : "#1d4ed8",
            fillOpacity: night ? 0.06 : floating ? 0.08 : 0.05,
            clickable: false,
          }),
        ),
        detach(
          new libs.maps.Polyline({
            map: m,
            path: circlePath(ringCenter, radius),
            strokeOpacity: 0,
            clickable: false,
            icons: [
              {
                icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: ringColor, scale: 2 },
                offset: "0",
                repeat: "10px",
              },
            ],
          }),
        ),
      );
      // Карта подгоняется так, чтобы круг был виден целиком.
      for (const p of circleExtremes(ringCenter, radius)) bounds.extend(p);
      points++;
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
        const name = pickLocalized(p.name, lc);
        const cover = p.cover && freeMapHeight(el.current) >= POPUP_PHOTO_MIN_FREE ? p.cover : null;
        // Окно одно на карту: новое содержимое сразу заменяет прежнее, два окна открытыми не бывают.
        info.setContent(
          popupNode({
            name,
            category: catName,
            id: p.id,
            distance: fmtDist(p.distanceMeters),
            icon: SECTION_EMOJI[g] ?? SECTION_EMOJI.other!,
            cover,
            coverAlt: cover?.alt ? pickLocalized(cover.alt, lc) : tr("miniapp.map.coverAlt", { name }),
            creditText: cover?.credit ? coverCreditText(cover.credit, tr) : undefined,
            openText: tr("miniapp.map.open"),
            routeText: tr("miniapp.modern.route"),
            routeLabel: tr("miniapp.modern.routeTo", { name }),
            routeHref: googleRouteUrl(p.location!, p.googlePlaceId),
            closeText: tr("miniapp.map.close"),
            navigate: (to) => navigateRef.current(to),
            openExternal: (e, href) => {
              const webApp = guideRef.current.webApp;
              if (webApp?.openLink) {
                e.preventDefault();
                webApp.openLink(href);
              }
            },
            onRoute: () => guideRef.current.analytics.track("route_clicked", { placeId: p.id }),
            onClose: () => infoRef.current?.close(),
          }),
        );
        const active = document.activeElement;
        // Нажатие на другой маркер при открытом окне: фокус уже на нём; иначе — сам маркер (настоящий маркер — HTML-элемент).
        openerRef.current =
          active instanceof HTMLElement && active !== document.body && !active.closest(".kosiv-map-popup")
            ? active
            : (marker as unknown) instanceof HTMLElement
              ? (marker as unknown as HTMLElement)
              : null;
        info.setOptions({ ariaLabel: name });
        info.open({ map: m, anchor: marker, shouldFocus: true });
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
    radiusCenter,
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
        if (!userMoved.current) {
          // Окно привязано к маркеру и после новой подгонки ушло бы за панель: закрываем (кнопки масштаба возвращаются).
          infoRef.current?.close();
          applyView.current?.();
        }
        explicit = false;
      }, 120);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [libs, map]);

  // «Ви тут»: центр карты — на устройстве. Позиция: переданная родителем, режим «Моє місцезнаходження», иначе запрос
  // геолокации (как на «Поруч»). Отказ — центр точки поиска и короткая подсказка.
  const hintTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);
  // Первое нажатие на «Поруч» без позиции: ждём, пока родитель получит её, и тогда центрируем карту.
  const waitingMe = useRef(false);
  const meLatNow = me?.lat;
  const meLngNow = me?.lng;
  useEffect(() => {
    if (!waitingMe.current || !map || meLatNow === undefined || meLngNow === undefined) return;
    waitingMe.current = false;
    userMoved.current = true;
    map.map.panTo({ lat: meLatNow, lng: meLngNow });
    const zoom = Math.min(DEVICE_MAX_ZOOM, maxZoom);
    if ((map.map.getZoom() ?? 0) < zoom) map.map.setZoom(zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, meLatNow, meLngNow]);
  useEffect(() => {
    // Родитель закончил определение без позиции (отказ): ждать больше нечего.
    if (!parentLocating && meLatNow === undefined) waitingMe.current = false;
  }, [parentLocating, meLatNow]);
  const locate = async () => {
    if (!map || locating) return;
    // Позиция известна — просто центрируем. Иначе: родитель («Поруч») определяет место сам, либо запрос здесь.
    // Прежний результат запроса не кэшируется: при каждом нажатии без me/gps позиция запрашивается заново.
    let target: LatLng | null = me ?? gps;
    if (!target && onLocate) {
      waitingMe.current = true;
      onLocate();
      return;
    }
    setHint(null);
    if (!target) {
      setLocating(true);
      target = await requestLocation(guideRef.current.webApp).catch(() => null);
      // Пока шёл запрос (до 11 с), экран закрыт или карта ушла в пул другому экрану — ничего не трогаем.
      setLocating(false);
      if (liveMap.current !== map) return;
      if (target) setLocated(target);
    }
    const m = map.map;
    // Карту двигал сам пользователь: автоподгонка (смена размера) его вид не сбрасывает.
    userMoved.current = true;
    const to = target ?? center;
    // Приближение не ближе предела для устройства (приватность): DEVICE_MAX_ZOOM.
    const zoom = Math.min(DEVICE_MAX_ZOOM, maxZoom);
    if (to) {
      m.panTo({ lat: to.lat, lng: to.lng });
      if ((m.getZoom() ?? 0) < zoom) m.setZoom(zoom);
    }
    if (!target) {
      setHint(to ? "center" : "none");
      window.clearTimeout(hintTimer.current);
      hintTimer.current = window.setTimeout(() => setHint(null), 5_000);
    }
  };

  // Значок «Ви тут»: перестраивается только он и круг точности (карта, маркеры мест и границы не трогаются).
  const meLat = shownMe?.lat;
  const meLng = shownMe?.lng;
  const meAccuracy = shownMe?.accuracy;
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

  // Карта не загрузилась: заглушка; места и их кнопки «Маршрут» остаются в списке рядом.
  if (state.status === "error") return <p role="alert">{t("miniapp.map.error")}</p>;

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
        {map && !popupOpen && (
          <button
            type="button"
            className="kosiv-map-locate"
            data-testid="map-locate"
            data-floating={floating ? "true" : undefined}
            aria-label={t("miniapp.map.locate")}
            aria-busy={locating || undefined}
            disabled={locating}
            onClick={() => void locate()}
          >
            {ICONS.locate}
          </button>
        )}
        {/* Постоянная live-область: подсказка появляется внутри неё и объявляется читалками. */}
        <div role="status" className="kosiv-map-locate-live">
          {hint && (
            <p className="kosiv-map-locate-hint" data-testid="map-locate-hint">
              {t(hint === "center" ? "miniapp.map.locateFailed" : "miniapp.map.locateFailedNoCenter")}
            </p>
          )}
        </div>
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
/** Снизу на карте «Поруч» — логотип и условия Google (~30 px): маркер не должен на них лежать. */
const FIT_PADDING_LOGO = 40;

/** Отступы fitBounds: 24 px, на сцене «Поруч» сверху — фактическая высота панели (радиус и категории), снизу — под логотип. */
function fitPadding(host: HTMLElement | null): google.maps.Padding {
  const base = { top: FIT_PADDING, right: FIT_PADDING, bottom: FIT_PADDING, left: FIT_PADDING };
  const stage = host?.closest(".modern-map-stage");
  if (!host || !stage) return base;
  const map = host.getBoundingClientRect();
  const top = stage.querySelector('[data-map-inset="top"]')?.getBoundingClientRect();
  base.bottom = FIT_PADDING_LOGO;
  // Запас 16 px: маркер (капсула 30 px высотой привязана центром к точке) не должен касаться края панели.
  // Минус 0,01: шум плавающей точки в координатах (91,00001) не должен давать лишний пиксель.
  if (top) base.top = Math.max(base.top, Math.ceil(top.bottom - map.top - 0.01) + 16);
  // Панель не должна съесть карту: вместе не больше 70% высоты, иначе fitBounds нечего вписывать.
  const room = map.height * 0.7;
  const used = base.top + base.bottom;
  if (used > room) {
    base.top = Math.round((base.top * room) / used);
    base.bottom = Math.round((base.bottom * room) / used);
  }
  return base;
}

/** Нижняя граница панели над картой («Поруч») или верх карты. */
function panelBottom(host: HTMLElement): number {
  const panel = host.closest(".modern-map-stage")?.querySelector('[data-map-inset="top"]');
  return panel ? panel.getBoundingClientRect().bottom : host.getBoundingClientRect().top;
}

/** Свободная высота карты под панелью: помещается ли окно с фото. */
function freeMapHeight(host: HTMLElement | null): number {
  return host ? host.getBoundingClientRect().bottom - panelBottom(host) : 0;
}

/** Полоса кнопок масштаба у правого края карты (40 px и отступ 10 px) с зазором до окна. */
const ZOOM_RESERVE = 58;

/**
 * Окно маркера целиком в свободной части карты: не под панелью и не за краем (автосдвиг Google о панели не знает).
 * Кнопки масштаба выше окна и закрыли бы его действия: окно сдвигается левее них, а если места нет (320 px) — кнопки скрыты, пока окно открыто.
 */
function panPopupIntoView(map: google.maps.Map, host: HTMLElement | null): void {
  const popup = host?.querySelector(".kosiv-map-popup");
  if (!host || !popup) return;
  const box = (popup.closest(".gm-style-iw-c") ?? popup).getBoundingClientRect();
  const area = host.getBoundingClientRect();
  const top = panelBottom(host) + 4;
  const bottom = area.bottom - 30;
  const dy = box.top < top ? box.top - top : box.bottom > bottom ? box.bottom - bottom : 0;
  const left = area.left + 8;
  const roomy = area.width >= box.width + ZOOM_RESERVE + 8;
  map.setOptions({ zoomControl: roomy });
  const right = area.right - (roomy ? ZOOM_RESERVE : 8);
  const dx = box.left < left ? box.left - left : box.right > right ? box.right - right : 0;
  if (dx || dy) map.panBy(dx, dy);
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
