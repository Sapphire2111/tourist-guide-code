// Карта мест через Leaflet (BSD-2-Clause, ~44 КБ gzip). Модуль грузится лениво (MapSlot, preloadMap) — в бюджет
// первого экрана не входит. Поставщик тайлов — map-tiles.ts (обязательная атрибуция).
// Карта создаётся один раз; смена мест/радиуса перестраивает только слой маркеров (без пересоздания карты и
// повторной загрузки тайлов). Маркеры окрашены по разделу категории, подпись — по нажатию, легенда — под картой.
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { pickLocalized, type MessageKey } from "@tg/i18n";
import { useRoute, useT } from "@tg/ui";
import { useCategoryIndex } from "./categories.js";
import { useGuide } from "./context.js";
import type { LatLng } from "./geo.js";
import { TILE_PROVIDER } from "./map-tiles.js";
import type { HomeSection, PlaceSummary } from "./types.js";

export type PlacesMapProps = {
  places: PlaceSummary[];
  center: LatLng | null;
  /** Подпись базовой точки. Координаты устройства сюда не передаются (приватность: карта не центрируется на туристе). */
  centerLabel?: string;
  radius?: number;
  /** Предел приближения при fitBounds (по умолчанию 17). */
  maxZoom?: number;
};

/** Группа маркера: раздел главной категории места или «інше». */
export type MarkerGroup = Extract<HomeSection, "eat" | "shop" | "relax" | "fun" | "transfer"> | "other";

/** Цвета групп (контраст ≥ 3:1 к светлой подложке карты — графический объект, WCAG 1.4.11). */
export const MARKER_COLORS: Record<MarkerGroup, string> = {
  eat: "#c2410c",
  shop: "#7c3aed",
  relax: "#1d4ed8",
  fun: "#be185d",
  transfer: "#047857",
  other: "#57534e",
};
const BASE_COLOR = "#111827";

export function markerGroup(section: HomeSection | null): MarkerGroup {
  return section && section in MARKER_COLORS ? (section as MarkerGroup) : "other";
}

/** Подпись маркера — DOM-узел с textContent: строку Leaflet вставляет как innerHTML (XSS из названия места). */
export function textNode(text: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function groupLabel(g: MarkerGroup): MessageKey {
  return g === "other" ? "miniapp.map.other" : (`miniapp.section.${g}` as MessageKey);
}

/** Содержимое подписи маркера: название, категория, ссылка на карточку (только textContent). */
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
    navigate(`/place/${id}`);
  });
  box.append(title, cat, link);
  return box;
}

export default function PlacesMap({ places, center, centerLabel, radius, maxZoom = 17 }: PlacesMapProps) {
  const { t, locale } = useT();
  const [, navigate] = useRoute();
  const { api } = useGuide();
  const index = useCategoryIndex(api);
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  // Карта и слой тайлов — один раз на экран.
  useEffect(() => {
    if (!el.current) return;
    const tr = tRef.current;
    const map = L.map(el.current, { zoomControl: false, attributionControl: true });
    L.control
      .zoom({ zoomInTitle: tr("miniapp.map.zoomIn"), zoomOutTitle: tr("miniapp.map.zoomOut") })
      .addTo(map);
    L.tileLayer(TILE_PROVIDER.url, {
      maxZoom: TILE_PROVIDER.maxZoom,
      attribution: TILE_PROVIDER.attribution,
      ...(TILE_PROVIDER.subdomains ? { subdomains: TILE_PROVIDER.subdomains } : {}),
      // Меньше запросов тайлов при перетаскивании и зуме на телефоне.
      updateWhenIdle: true,
      keepBuffer: 1,
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Маркеры — при смене мест, базы, радиуса или справочника категорий.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    if (center) {
      L.circleMarker([center.lat, center.lng], {
        radius: 9,
        color: "#ffffff",
        weight: 3,
        fillColor: BASE_COLOR,
        fillOpacity: 1,
      })
        .bindTooltip(textNode(centerLabel ?? t("miniapp.map.base")))
        .addTo(layer);
      if (radius) L.circle([center.lat, center.lng], { radius, weight: 1, fillOpacity: 0.05 }).addTo(layer);
      bounds.push([center.lat, center.lng]);
    }
    for (const p of places) {
      if (!p.location) continue;
      const name = pickLocalized(p.name, locale);
      const cat = index.byId.get(p.categoryId);
      const group = markerGroup(index.sectionOf(p.categoryId));
      const catName = cat ? pickLocalized(cat.name, locale) : t(groupLabel(group));
      const marker = L.circleMarker([p.location.lat, p.location.lng], {
        radius: 8,
        color: "#ffffff",
        weight: 2,
        fillColor: MARKER_COLORS[group],
        fillOpacity: 0.95,
      })
        .bindTooltip(textNode(name))
        .bindPopup(() => popupNode(name, catName, p.id, t("miniapp.map.open"), navigate))
        .addTo(layer);
      marker.getElement()?.setAttribute("data-group", group);
      bounds.push([p.location.lat, p.location.lng]);
    }
    if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom });
    else if (bounds[0]) map.setView(bounds[0], Math.min(16, maxZoom));
    else map.setView([48.45, 24.55], 12);
  }, [places, center, centerLabel, radius, maxZoom, locale, navigate, t, index]);

  const groups = [
    ...new Set(places.filter((p) => p.location).map((p) => markerGroup(index.sectionOf(p.categoryId)))),
  ];

  // Карта дублирует список рядом: маркеры — не единственный путь к месту (клавиатура и чтение с экрана — список).
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        ref={el}
        role="region"
        aria-label={t("miniapp.map.label")}
        data-testid="places-map"
        style={{ height: 260, borderRadius: "var(--radius)", overflow: "hidden" }}
      />
      {(groups.length > 0 || center) && (
        <ul className="kosiv-map-legend" aria-label={t("miniapp.map.legend")} data-testid="map-legend">
          {center && (
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
