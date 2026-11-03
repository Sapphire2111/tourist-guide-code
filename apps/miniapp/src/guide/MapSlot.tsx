// Ленивая карта с запасным состоянием: не загрузилась (сеть, ошибка модуля) — «Карту не вдалося завантажити»,
// список рядом остаётся (C05 «ошибка карты»).
import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { useT } from "@tg/ui";
import { isChunkLoadError, reloadOnceForChunkError } from "../chunk-reload.js";
import { MAPS_ORIGIN, mapsAvailable } from "./map-config.js";
import type { PlacesMapProps } from "./PlacesMap.js";

type MapModule = {
  default: ComponentType<PlacesMapProps>;
  /** Начать загрузку скрипта Google Maps заранее (язык подписей карты). */
  preloadApi?: (language?: string) => Promise<unknown>;
};

let mapModule: Promise<MapModule> | null = null;
let loadModule = (): Promise<MapModule> => import("./PlacesMap.js");
/** Тесты с подменённым модулем карты: ключ не нужен. */
let forceAvailable = false;

function available(): boolean {
  return forceAvailable || mapsAvailable();
}

/** Только для тестов: подмена загрузчика модуля карты и сброс состояния. */
export function setMapLoaderForTests(loader: () => Promise<MapModule>): void {
  loadModule = loader;
  forceAvailable = true;
  mapModule = null;
  lazyMap = null;
}

/**
 * Заранее (экран с картой открылся, места ещё грузятся): модуль карты, соединение с Google и скрипт API —
 * параллельно запросу мест, а не после него. Без ключа — ничего не грузит (на экране заглушка).
 */
export function preloadMap(language?: string): Promise<MapModule> {
  if (!available()) return Promise.reject(new Error("Google Maps key is not configured"));
  if (!mapModule) {
    if (typeof document !== "undefined" && !document.querySelector(`link[data-map-preconnect]`)) {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = MAPS_ORIGIN;
      link.dataset.mapPreconnect = "";
      document.head.appendChild(link);
    }
    mapModule = loadModule().then(
      (m) => {
        m.preloadApi?.(language).catch(() => undefined);
        return m;
      },
      (e: unknown) => {
        // Повтор после сбоя: и промис, и lazy (он запомнил отказ) сбрасываются — следующий монтаж создаст новый.
        mapModule = null;
        lazyMap = null;
        throw e;
      },
    );
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
  componentDidCatch(error: unknown) {
    // Карту реально показываем и чанк потерян после деплоя — один раз обновляем страницу. Фоновая предзагрузка
    // (preloadMap) ошибки молча глотает: перезагрузка посреди запроса ассистента хуже, чем нет карты.
    if (isChunkLoadError(error)) void reloadOnceForChunkError(error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function MapSlot(props: PlacesMapProps) {
  const { t } = useT();
  if (!available())
    return (
      <>
        <p role="note" className="kosiv-muted" data-testid="map-unavailable">
          {t("miniapp.map.unavailable")}
        </p>
        {props.overlay}
      </>
    );
  return <LazyMap {...props} />;
}

function LazyMap(props: PlacesMapProps) {
  const { t } = useT();
  const [PlacesMap] = useState(() => currentLazyMap());
  return (
    <MapBoundary fallback={<p role="alert">{t("miniapp.map.error")}</p>}>
      <Suspense fallback={<p role="status">{t("miniapp.guide.loading")}</p>}>
        <PlacesMap {...props} />
      </Suspense>
    </MapBoundary>
  );
}
