/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Браузерный ключ Google Maps JS API (выбор места на карте); без него карта не показывается. */
  readonly VITE_GOOGLE_MAPS_BROWSER_KEY?: string;
  /** Map ID векторной карты (AdvancedMarker); без него — DEMO_MAP_ID. */
  readonly VITE_GOOGLE_MAPS_MAP_ID?: string;
}
