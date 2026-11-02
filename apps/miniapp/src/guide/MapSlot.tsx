// Ленивая карта с запасным состоянием: не загрузилась (сеть, ошибка модуля) — «Карту не вдалося завантажити»,
// список рядом остаётся (C05 «ошибка карты»).
import { Component, lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { useT } from "@tg/ui";
import { TILE_PROVIDER } from "./map-tiles.js";
import type { PlacesMapProps } from "./PlacesMap.js";

type MapModule = { default: ComponentType<PlacesMapProps> };

let mapModule: Promise<MapModule> | null = null;

/**
 * Заранее (экран с картой открылся, места ещё грузятся): модуль Leaflet и соединение с сервером тайлов —
 * параллельно запросу мест, а не после него.
 */
export function preloadMap(): Promise<MapModule> {
  if (!mapModule) {
    if (typeof document !== "undefined" && !document.querySelector(`link[data-map-preconnect]`)) {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = TILE_PROVIDER.origin;
      link.dataset.mapPreconnect = "";
      document.head.appendChild(link);
    }
    mapModule = import("./PlacesMap.js").catch((e: unknown) => {
      mapModule = null;
      throw e;
    });
  }
  return mapModule;
}

const PlacesMap = lazy(preloadMap);

class MapBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function MapSlot(props: PlacesMapProps) {
  const { t } = useT();
  return (
    <MapBoundary fallback={<p role="alert">{t("miniapp.map.error")}</p>}>
      <Suspense fallback={<p role="status">{t("miniapp.guide.loading")}</p>}>
        <PlacesMap {...props} />
      </Suspense>
    </MapBoundary>
  );
}
