// Фиксированные точки прогноза: центры населённых пунктов (из localities) и горные точки ниже. Запрос по
// координатам отдаётся из ближайшей точки. Без Nest и БД.

export type WeatherPoint = {
  key: string;
  kind: "settlement" | "mountain";
  lat: number;
  lng: number;
};

/**
 * Горные точки Карпат (координаты приблизительные, по открытым картам): прогноз у вершины для походов. Новая точка —
 * сюда; квота Google считается на все точки (refreshEveryMs).
 */
export const MOUNTAIN_POINTS: readonly WeatherPoint[] = [
  { key: "mountain:hoverla", kind: "mountain", lat: 48.1602, lng: 24.5003 },
  { key: "mountain:zaroslyak", kind: "mountain", lat: 48.1636, lng: 24.5397 },
  { key: "mountain:khomiak", kind: "mountain", lat: 48.35, lng: 24.483 },
  { key: "mountain:bukovel", kind: "mountain", lat: 48.358, lng: 24.405 },
];

/** Дальше этого от ближайшей точки прогноз не отдаём (не наш регион — погода была бы чужой), м. */
export const NEAREST_MAX_M = 30_000;
/** Горная точка подходит пункту плана, если она не дальше, м. */
export const MOUNTAIN_NEAR_M = 8_000;

export function meters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Ближайшая точка не дальше NEAREST_MAX_M. mountain — для похода: сначала горная точка в MOUNTAIN_NEAR_M, иначе
 * ближайшая любая. Обычный запрос (главная) — ближайший населённый пункт, горная точка — только если она ближе всех.
 */
export function nearestPoint<T extends WeatherPoint>(
  points: readonly T[],
  at: { lat: number; lng: number },
  opts: { mountain?: boolean } = {},
): T | null {
  let best: { p: T; d: number } | null = null;
  let mountain: { p: T; d: number } | null = null;
  for (const p of points) {
    const d = meters(at, p);
    if (!best || d < best.d) best = { p, d };
    if (p.kind === "mountain" && d <= MOUNTAIN_NEAR_M && (!mountain || d < mountain.d)) mountain = { p, d };
  }
  if (opts.mountain && mountain) return mountain.p;
  return best && best.d <= NEAREST_MAX_M ? best.p : null;
}
