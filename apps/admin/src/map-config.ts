// Настройки Google Maps админки (выбор места на карте): только чтение переменных сборки — загрузчик API и карта
// живут в ленивом чанке (PlaceMap.tsx, google-maps.ts). Без ключа кнопка карты не показывается, поиск по названию
// остаётся. Упрощённая копия apps/miniapp/src/guide/map-config.ts (без общего пакета — бандл Mini App не трогаем).

export type MapsConfig = { key: string; mapId: string };

/** DEMO_MAP_ID Google: AdvancedMarker без своего Map ID (разработка); в staging/prod — свой векторный Map ID. */
export const DEMO_MAP_ID = "DEMO_MAP_ID";

/** Центр по умолчанию — Яремче/Косів, как в Mini App. */
export const DEFAULT_CENTER = { lat: 48.31, lng: 25.09 };

let config: MapsConfig = {
  key: (import.meta.env?.VITE_GOOGLE_MAPS_BROWSER_KEY ?? "").trim(),
  mapId: (import.meta.env?.VITE_GOOGLE_MAPS_MAP_ID ?? "").trim() || DEMO_MAP_ID,
};

export function mapsConfig(): MapsConfig {
  return config;
}

/** Только для тестов: подмена ключа и Map ID. */
export function setMapsConfigForTests(next: Partial<MapsConfig>): void {
  config = { ...config, ...next };
}

/** API уже на странице (загружен ранее) — ключ не нужен, повторно не грузим. */
export function mapsApiOnPage(): boolean {
  if (typeof window === "undefined") return false;
  const g = (window as { google?: { maps?: { importLibrary?: unknown } } }).google;
  return typeof g?.maps?.importLibrary === "function";
}

/** Карту можно показать: есть ключ сборки или API уже загружен. */
export function mapsAvailable(): boolean {
  return config.key !== "" || mapsApiOnPage();
}
