// Настройки Google Maps для первого экрана: только чтение переменных сборки — загрузчик API и сама карта живут в
// ленивом чанке (PlacesMap.tsx, google-maps.ts). Без ключа карта не грузится: вместо неё заглушка, список остаётся.

export type MapsConfig = { key: string; mapId: string };

/** DEMO_MAP_ID Google: AdvancedMarker без своего Map ID (разработка); в staging/prod — свой векторный Map ID. */
const DEMO_MAP_ID = "DEMO_MAP_ID";

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

/** API уже на странице (загружен ранее или подставлен e2e-фейком) — ключ не нужен, повторно не грузим. */
export function mapsApiOnPage(): boolean {
  if (typeof window === "undefined") return false;
  const g = (window as { google?: { maps?: { importLibrary?: unknown } } }).google;
  return typeof g?.maps?.importLibrary === "function";
}

/** Карту можно показать: есть ключ сборки или API уже загружен. */
export function mapsAvailable(): boolean {
  return config.key !== "" || mapsApiOnPage();
}

/** Происхождение скрипта API — для <link rel="preconnect">. */
export const MAPS_ORIGIN = "https://maps.googleapis.com";
