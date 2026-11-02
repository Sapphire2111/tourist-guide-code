// Поставщик тайлов карты — в одном месте: смена (другой OSM-хостинг, Google и т. п.) — правка этой константы.
// tile.openstreetmap.org — бесплатный, без SLA, с политикой использования (обязательная атрибуция, без массовой
// нагрузки); для продакшена с большим трафиком нужен свой или коммерческий поставщик.
export type TileProvider = {
  /** Шаблон Leaflet: {z}/{x}/{y}, при необходимости {s} и subdomains. */
  url: string;
  /** Происхождение тайлов — для <link rel="preconnect">. */
  origin: string;
  /** HTML атрибуции (константа, не пользовательские данные). */
  attribution: string;
  maxZoom: number;
  subdomains?: string[];
};

export const TILE_PROVIDER: TileProvider = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  origin: "https://tile.openstreetmap.org",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
};
