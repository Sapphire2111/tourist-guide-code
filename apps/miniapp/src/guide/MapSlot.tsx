// Ленивая карта с запасным состоянием: не загрузилась (сеть, ошибка модуля) — «Карту не вдалося завантажити»,
// список рядом остаётся (C05 «ошибка карты»).
import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { useT } from "@tg/ui";
import { TILE_PROVIDER } from "./map-tiles.js";
import type { PlacesMapProps } from "./PlacesMap.js";

type MapModule = { default: ComponentType<PlacesMapProps> };

let mapModule: Promise<MapModule> | null = null;
let loadModule = (): Promise<MapModule> => import("./PlacesMap.js");

/** Только для тестов: подмена загрузчика модуля карты и сброс состояния. */
export function setMapLoaderForTests(loader: () => Promise<MapModule>): void {
  loadModule = loader;
  mapModule = null;
  lazyMap = null;
}

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
    mapModule = loadModule().catch((e: unknown) => {
      // Повтор после сбоя: и промис, и lazy (он запомнил отказ) сбрасываются — следующий монтаж создаст новый.
      mapModule = null;
      lazyMap = null;
      throw e;
    });
  }
  return mapModule;
}

// React.lazy запоминает отказ навсегда: после сбоя загрузки следующий экран с картой берёт новый lazy —
// настоящий повтор (сеть вернулась — карта появится), а не вечное «не вдалося».
let lazyMap: ComponentType<PlacesMapProps> | null = null;
function currentLazyMap(): ComponentType<PlacesMapProps> {
  if (!lazyMap) lazyMap = lazy(preloadMap);
  return lazyMap;
}

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
  const [PlacesMap] = useState(currentLazyMap);
  return (
    <MapBoundary fallback={<p role="alert">{t("miniapp.map.error")}</p>}>
      <Suspense fallback={<p role="status">{t("miniapp.guide.loading")}</p>}>
        <PlacesMap {...props} />
      </Suspense>
    </MapBoundary>
  );
}
