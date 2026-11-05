// Карта выбора точки заведения: тап по карте ставит маркер, маркер можно перетащить. Грузится лениво (из LocationPicker
// при открытии листа) вместе с загрузчиком Google Maps — в бюджет первого экрана и самого редактора не входит.
// Карта берётся из общего пула (google-maps.ts) и возвращается в него при закрытии: новой платной загрузки нет.
import { useEffect, useRef, useState } from "react";
import { useT } from "@tg/ui";
import { useTheme } from "../design/ThemeProvider.js";
import {
  acquireMap,
  loadMapsApi,
  mapsAuthFailed,
  onMapsAuthFailure,
  releaseMap,
  type MapsLibs,
} from "../guide/google-maps.js";

export type MapPoint = { lat: number; lng: number };

/** Центр до первой отметки — Косів (как у карты гида). */
const DEFAULT_CENTER: MapPoint = { lat: 48.31, lng: 25.09 };

export default function LocationMap({
  point,
  onPick,
}: {
  /** Начальная точка (дальше маркер ведёт сама карта). */
  point: MapPoint | null;
  onPick: (p: MapPoint) => void;
}) {
  const { t, locale } = useT();
  const night = useTheme().theme === "night";
  const host = useRef<HTMLDivElement>(null);
  const [libs, setLibs] = useState<MapsLibs | null>(null);
  const [failed, setFailed] = useState(false);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const initial = useRef(point);

  useEffect(() => {
    let alive = true;
    loadMapsApi(locale).then(
      (l) => alive && (mapsAuthFailed() ? setFailed(true) : setLibs(l)),
      () => alive && setFailed(true),
    );
    const off = onMapsAuthFailure(() => alive && setFailed(true));
    return () => {
      alive = false;
      off();
    };
  }, [locale]);

  useEffect(() => {
    if (!libs || !host.current) return;
    const item = acquireMap(libs, host.current, night);
    const start = initial.current;
    item.map.setCenter(start ?? DEFAULT_CENTER);
    item.map.setZoom(start ? 16 : 13);
    let marker: google.maps.marker.AdvancedMarkerElement | null = null;
    const place = (p: MapPoint) => {
      if (!marker) {
        marker = new libs.marker.AdvancedMarkerElement({
          map: item.map,
          position: p,
          gmpDraggable: true,
          title: t("miniapp.partner.location.mapHint"),
        });
        marker.addListener("dragend", () => {
          const pos = marker?.position;
          if (!pos) return;
          const lat = typeof pos.lat === "function" ? pos.lat() : pos.lat;
          const lng = typeof pos.lng === "function" ? pos.lng() : pos.lng;
          initial.current = { lat, lng };
          onPickRef.current({ lat, lng });
        });
      } else marker.position = p;
    };
    if (start) place(start);
    const click = item.map.addListener("click", (e: google.maps.MapMouseEvent) => {
      const ll = e.latLng;
      if (!ll) return;
      const p = { lat: ll.lat(), lng: ll.lng() };
      place(p);
      initial.current = p;
      onPickRef.current(p);
    });
    return () => {
      click.remove();
      if (marker) marker.map = null;
      releaseMap(item);
    };
    // t — стабильная подпись маркера; перестраивать карту при её смене не нужно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libs, night]);

  if (failed) return <p role="alert">{t("miniapp.partner.location.mapError")}</p>;
  return (
    <div
      ref={host}
      role="region"
      aria-label={t("miniapp.map.label")}
      aria-busy={libs ? undefined : true}
      data-testid="location-map"
      className="partner-map"
    />
  );
}
