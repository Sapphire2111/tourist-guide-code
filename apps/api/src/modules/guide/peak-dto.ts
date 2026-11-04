// Вершина (places-import/peaks.ts) → PeakDto выдачи: сложность по правилу, туда-назад, горная точка погоды рядом.
import {
  peakByGooglePlaceId,
  peakDifficulty,
  roundTripKm,
  totalHours,
  type PeakData,
} from "../../places-import/peaks.js";
import { meters, MOUNTAIN_POINTS } from "../weather/index.js";
import type { PeakDto } from "./guide.dto.js";

/** Горная точка прогноза считается «на вершине», если не дальше, м. */
export const PEAK_WEATHER_MAX_M = 3_000;

export function peakDto(p: PeakData): PeakDto {
  const at = { lat: p.location.lat, lng: p.location.lon };
  const near = MOUNTAIN_POINTS.map((m) => ({ m, d: meters(at, m) }))
    .filter((x) => x.d <= PEAK_WEATHER_MAX_M)
    .sort((a, b) => a.d - b.d)[0]?.m;
  const r = p.route;
  return {
    slug: p.slug,
    heightM: p.heightM,
    range: p.range,
    difficulty: peakDifficulty(r),
    route: r
      ? {
          start: r.start,
          startLocation: r.startLocation ? { lat: r.startLocation.lat, lng: r.startLocation.lon } : null,
          roundTripKm: roundTripKm(r),
          elevationGainM: r.elevationGainM,
          gainKind: r.gainKind,
          upHours: r.upHours,
          downHours: r.downHours,
          totalHours: totalHours(r),
          trail: r.trail,
        }
      : null,
    note: p.note,
    warnings: [...p.warnings],
    sources: p.sources.map((s) => ({ title: s.title, url: s.url })),
    weatherPoint: near ? { lat: near.lat, lng: near.lng } : null,
  };
}

/** Данные вершины места по google_place_id; не вершина — null. */
export function peakOfPlace(googlePlaceId: string | null | undefined): PeakDto | null {
  const p = peakByGooglePlaceId(googlePlaceId);
  return p ? peakDto(p) : null;
}
