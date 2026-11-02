// Карта мест на OSM (D-06) через Leaflet (BSD-2-Clause, ~40 КБ gzip). Модуль грузится лениво (React.lazy) —
// в бюджет первого экрана не входит. Плитки tile.openstreetmap.org с обязательной атрибуцией.
import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { pickLocalized } from "@tg/i18n";
import { useRoute, useT } from "@tg/ui";
import type { LatLng } from "./geo.js";
import type { PlaceSummary } from "./types.js";

export type PlacesMapProps = {
  places: PlaceSummary[];
  center: LatLng | null;
  /** Подпись базовой точки. Координаты устройства сюда не передаются (приватность: карта не центрируется на туристе). */
  centerLabel?: string;
  radius?: number;
  /** Предел приближения при fitBounds (по умолчанию 17). */
  maxZoom?: number;
};

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** Подпись маркера — DOM-узел с textContent: строку Leaflet вставляет как innerHTML (XSS из названия места). */
export function textNode(text: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

export default function PlacesMap({ places, center, centerLabel, radius, maxZoom = 17 }: PlacesMapProps) {
  const { t, locale } = useT();
  const [, navigate] = useRoute();
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, { zoomControl: false, attributionControl: true });
    L.control
      .zoom({ zoomInTitle: t("miniapp.map.zoomIn"), zoomOutTitle: t("miniapp.map.zoomOut") })
      .addTo(map);
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    const bounds: L.LatLngExpression[] = [];
    if (center) {
      L.circleMarker([center.lat, center.lng], { radius: 8, color: "#d93025", fillOpacity: 0.9 })
        .bindTooltip(textNode(centerLabel ?? t("miniapp.map.base")))
        .addTo(map);
      if (radius) L.circle([center.lat, center.lng], { radius, weight: 1, fillOpacity: 0.05 }).addTo(map);
      bounds.push([center.lat, center.lng]);
    }
    for (const p of places) {
      if (!p.location) continue;
      const marker = L.circleMarker([p.location.lat, p.location.lng], { radius: 7, fillOpacity: 0.8 })
        .bindTooltip(textNode(pickLocalized(p.name, locale)))
        .addTo(map);
      marker.on("click", () => navigate(`/place/${p.id}`));
      bounds.push([p.location.lat, p.location.lng]);
    }
    if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom });
    else if (bounds[0]) map.setView(bounds[0], Math.min(16, maxZoom));
    else map.setView([48.45, 24.55], 12);
    return () => {
      map.remove();
    };
  }, [places, center, centerLabel, radius, maxZoom, locale, navigate, t]);

  // Карта дублирует список рядом: маркеры — не единственный путь к месту (клавиатура и чтение с экрана — список).
  return (
    <div
      ref={el}
      role="region"
      aria-label={t("miniapp.map.label")}
      data-testid="places-map"
      style={{ height: 260, borderRadius: "var(--radius)", overflow: "hidden" }}
    />
  );
}
