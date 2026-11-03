/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Имя нашего бота (без @): ссылки на других ботов считаются чужими. */
  readonly VITE_BOT_USERNAME?: string;
  /**
   * Браузерный ключ Google Maps JavaScript API (ограничен сайтами Mini App по referrer). Вшивается в бандл.
   * Не задан — вместо карты заглушка, список мест остаётся.
   */
  readonly VITE_GOOGLE_MAPS_BROWSER_KEY?: string;
  /** Map ID векторной карты (нужен для AdvancedMarker). Не задан — DEMO_MAP_ID (только для разработки). */
  readonly VITE_GOOGLE_MAPS_MAP_ID?: string;
}
