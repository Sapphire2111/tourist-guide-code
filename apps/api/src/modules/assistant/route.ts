// Маршрут экскурсии по местам каталога: порядок обхода и длина по прямой. Чистая логика.
import type { LonLat } from "../../db/index.js";

/** Расстояние по большому кругу, м (сфера 6 371 км — для порядка обхода и подписи «≈ N км» достаточно). */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Порядок обхода «ближайший следующий»: от точки туриста, без неё — от первого места (оно ближе всех к началу
 * выдачи каталога). Для 2–8 остановок даёт разумный пеший маршрут без возвратов через всё село.
 */
export function orderRoute<T extends { location: LonLat }>(
  stops: readonly T[],
  start?: LonLat,
): { ordered: T[]; lengthMeters: number } {
  const left = [...stops];
  const ordered: T[] = [];
  let at: LonLat | undefined = start;
  let length = 0;
  while (left.length) {
    let best = 0;
    if (at) {
      let bestD = Infinity;
      left.forEach((s, i) => {
        const d = haversineMeters(at!, s.location);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
    }
    const next = left.splice(best, 1)[0]!;
    // Путь от точки туриста до первой остановки в длину маршрута не входит: считается между местами.
    if (ordered.length) length += haversineMeters(ordered[ordered.length - 1]!.location, next.location);
    ordered.push(next);
    at = next.location;
  }
  return { ordered, lengthMeters: Math.round(length) };
}
