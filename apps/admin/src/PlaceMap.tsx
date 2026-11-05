// Карта мест каталога для выбора места (ленивый чанк вместе с google-maps.ts): маркеры — места в видимой области
// (GET /admin/places с рамкой карты после остановки карты и при открытии, с задержкой, не больше MAP_PLACES_LIMIT). Клик по маркеру —
// название места и «Обрати»; выбор передаётся форме.
import { useEffect, useRef, useState } from "react";
import { useT } from "@tg/ui";
import { call, type ApiError, type ApiSchemas } from "./api.js";
import { acquireMap, loadMapsApi, onMapsAuthFailure, releaseMap, type MapsLibs } from "./google-maps.js";
import { DEFAULT_CENTER } from "./map-config.js";
import { ErrorBox, SmallButton, useAdmin, useLocalized } from "./ui.js";

type Place = ApiSchemas["PlaceDto"];

/** Сколько мест показывать на карте за раз (максимум limit API). */
export const MAP_PLACES_LIMIT = 100;
/** Задержка запроса после остановки карты: перетаскивание и масштаб не шлют запрос на каждый кадр. */
export const IDLE_DEBOUNCE_MS = 300;

/** Рамка запроса из границ карты; через антимеридиан (или весь мир) — вся долгота. */
export function bboxOf(b: google.maps.LatLngBounds) {
  const ne = b.getNorthEast();
  const sw = b.getSouthWest();
  const clamp = (v: number, lim: number) => Math.min(lim, Math.max(-lim, v));
  const wrapped = sw.lng() > ne.lng();
  return {
    minLat: clamp(sw.lat(), 90),
    maxLat: clamp(ne.lat(), 90),
    minLng: wrapped ? -180 : clamp(sw.lng(), 180),
    maxLng: wrapped ? 180 : clamp(ne.lng(), 180),
  };
}

export default function PlaceMap({
  selected,
  onChoose,
}: {
  selected: Place | null;
  onChoose: (place: Place) => void;
}) {
  const { api } = useAdmin();
  const { t, locale } = useT();
  const l = useLocalized();
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [active, setActive] = useState<Place | null>(null);
  const mapRef = useRef<{ libs: MapsLibs; map: google.maps.Map } | null>(null);

  // Карта: загрузка API, начальный вид (выбранное место или центр региона), запросы мест по рамке.
  useEffect(() => {
    let alive = true;
    let item: ReturnType<typeof acquireMap> | null = null;
    let idle: google.maps.MapsEventListener | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    const offAuth = onMapsAuthFailure(() => {
      if (alive) setStatus("failed");
    });
    const fetchBox = async (map: google.maps.Map) => {
      const bounds = map.getBounds();
      if (!bounds) return;
      const mine = ++seq;
      const res = await call(
        api.GET("/admin/places", { params: { query: { limit: MAP_PLACES_LIMIT, ...bboxOf(bounds) } } }),
      );
      // Ответ устаревшего запроса (карту уже сдвинули) не показываем.
      if (!alive || mine !== seq) return;
      if (!res.ok) return setError(res.error);
      setError(null);
      setPlaces(res.data.items.filter((p) => p.location));
      setTruncated(res.data.nextCursor !== null);
    };
    loadMapsApi(locale).then(
      (libs) => {
        if (!alive || !host.current) return;
        item = acquireMap(libs, host.current);
        const map = item.map;
        mapRef.current = { libs, map };
        const schedule = () => {
          clearTimeout(timer);
          timer = setTimeout(() => void fetchBox(map), IDLE_DEBOUNCE_MS);
        };
        // Подписка — до смены вида: иначе первый idle можно пропустить.
        idle = map.addListener("idle", schedule);
        const loc = selected?.location;
        map.setCenter(loc ? { lat: loc.lat, lng: loc.lon } : DEFAULT_CENTER);
        map.setZoom(loc ? 15 : 12);
        // Повторное открытие на той же карте с тем же видом idle может не прислать — запрос по текущим границам.
        if (map.getBounds()) schedule();
        setStatus("ready");
      },
      () => {
        if (alive) setStatus("failed");
      },
    );
    return () => {
      alive = false;
      offAuth();
      clearTimeout(timer);
      idle?.remove();
      mapRef.current = null;
      if (item) releaseMap(item);
    };
    // Карта создаётся один раз на открытие панели; выбранное место — только начальный вид.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Маркеры текущих мест: по id — новые добавляются, ушедшие из рамки снимаются, оставшиеся не пересоздаются.
  const markers = useRef(
    new Map<string, { marker: google.maps.marker.AdvancedMarkerElement; place: Place }>(),
  );
  useEffect(() => {
    const m = mapRef.current;
    if (!m || !places) return;
    const next = new Set(places.map((p) => p.id));
    for (const [id, entry] of markers.current)
      if (!next.has(id)) {
        entry.marker.map = null;
        markers.current.delete(id);
      }
    for (const p of places) {
      const known = markers.current.get(p.id);
      if (known) {
        known.place = p;
        continue;
      }
      const marker = new m.libs.marker.AdvancedMarkerElement({
        map: m.map,
        position: { lat: p.location!.lat, lng: p.location!.lon },
        title: l(p.name),
        gmpClickable: true,
      });
      const entry = { marker, place: p };
      marker.addEventListener("gmp-click", () => setActive(entry.place));
      markers.current.set(p.id, entry);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places]);
  // Закрытие панели — все маркеры снимаются с карты (сама карта остаётся в кеше).
  useEffect(() => {
    const all = markers.current;
    return () => {
      for (const { marker } of all.values()) marker.map = null;
      all.clear();
    };
  }, []);

  if (status === "failed")
    return (
      <p role="alert" style={{ margin: 0, color: "#b3261e" }}>
        {t("admin.placeMap.failed")}
      </p>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ margin: 0 }}>
        {status === "loading" ? t("admin.placeMap.loading") : t("admin.placeMap.hint")}
      </p>
      <div
        ref={host}
        data-testid="place-map"
        style={{ width: "100%", height: 360, border: "1px solid #c4c7cc", borderRadius: 6 }}
      />
      <ErrorBox error={error} />
      {truncated && <p style={{ margin: 0 }}>{t("admin.placeMap.truncated", { count: MAP_PLACES_LIMIT })}</p>}
      {places && places.length === 0 && <p style={{ margin: 0 }}>{t("admin.placeMap.empty")}</p>}
      {active && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong>{l(active.name)}</strong>
          <SmallButton onClick={() => onChoose(active)}>{t("admin.placeMap.choose")}</SmallButton>
        </div>
      )}
    </div>
  );
}
