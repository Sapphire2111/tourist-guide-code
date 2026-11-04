// Раздел «Вершини»: сортировка и фильтр списка, подписи параметров маршрута. Без React — проверяется отдельно.
import type { PeakDifficulty, PlaceSummary } from "./types.js";

export type PeakPlace = PlaceSummary & { peak: NonNullable<PlaceSummary["peak"]> };

export type PeakSort = "difficulty" | "distance" | "height";
/** Фильтр по сложности: all — все; unknown — «немає даних». */
export type PeakFilter = "all" | PeakDifficulty | "unknown";

const RANK: Record<PeakDifficulty, number> = { easy: 0, moderate: 1, hard: 2, expert: 3 };

export const isPeakPlace = (p: PlaceSummary): p is PeakPlace => Boolean(p.peak);

/** Порядок «від легких до складних»; без данных — в конце. Равные — по высоте (ниже раньше), затем по названию. */
function byDifficulty(a: PeakPlace, b: PeakPlace): number {
  const ra = a.peak.difficulty ? RANK[a.peak.difficulty] : 9;
  const rb = b.peak.difficulty ? RANK[b.peak.difficulty] : 9;
  return ra - rb || (a.peak.heightM ?? 9999) - (b.peak.heightM ?? 9999);
}

export function sortPeaks(list: readonly PeakPlace[], sort: PeakSort): PeakPlace[] {
  const name = (p: PeakPlace) => p.name.uk;
  const cmp: Record<PeakSort, (a: PeakPlace, b: PeakPlace) => number> = {
    difficulty: byDifficulty,
    // Без расстояния (точка туриста неизвестна) — в конце.
    distance: (a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity) || byDifficulty(a, b),
    height: (a, b) => (b.peak.heightM ?? -1) - (a.peak.heightM ?? -1),
  };
  return [...list].sort((a, b) => cmp[sort](a, b) || name(a).localeCompare(name(b), "uk"));
}

export function filterPeaks(list: readonly PeakPlace[], filter: PeakFilter): PeakPlace[] {
  if (filter === "all") return [...list];
  if (filter === "unknown") return list.filter((p) => !p.peak.difficulty);
  return list.filter((p) => p.peak.difficulty === filter);
}

/** Фильтры, для которых есть хотя бы одна вершина (пустые чипы не показываются). */
export function availableFilters(list: readonly PeakPlace[]): PeakFilter[] {
  const order: PeakFilter[] = ["easy", "moderate", "hard", "expert", "unknown"];
  return ["all", ...order.filter((f) => filterPeaks(list, f).length > 0)];
}

/** Часы: 5 → «5», 2.5 → «2,5». */
export const hoursText = (h: number): string => String(h).replace(".", ",");

/** Высота: 984.5 → «984,5 м»; 2061 → «2061 м». */
export const heightText = (m: number): string => `${String(m).replace(".", ",")} м`;
