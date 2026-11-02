// Правила «Мій план» (C09, S-04) — без Nest и БД: копия пунктов сценария в план, замена альтернативой, удаление,
// расстояние между пунктами дня.
import { randomUUID } from "node:crypto";
import type { LonLat, ScenarioItem, UserPlanItemRecord } from "../../db/index.js";

const hhmm = (t: string | null) => (t === null ? null : t.slice(0, 5));

/** Пункты сценария → пункты плана (новые id; альтернативы — как в сценарии). */
export function planItemsFromScenario(items: readonly ScenarioItem[]): UserPlanItemRecord[] {
  return [...items]
    .sort((a, b) => a.day_no - b.day_no || a.position - b.position)
    .map((i) => ({
      id: randomUUID(),
      dayNo: i.day_no,
      position: i.position,
      placeId: i.place_id,
      timeHint: hhmm(i.time_hint),
      durationMin: i.duration_min,
      note: i.note_i18n,
      alternatives: [...i.alternatives],
      replacedPlaceId: null,
    }));
}

export type PlanEditError = "item_not_found" | "not_alternative";

/**
 * «Замінити»: место пункта меняется на альтернативу из его набора; прежнее место становится альтернативой (можно
 * вернуть). Исходное место сценария запоминается в replacedPlaceId (при возврате к нему — null).
 */
export function replaceItem(
  items: readonly UserPlanItemRecord[],
  itemId: string,
  placeId: string,
): UserPlanItemRecord[] | PlanEditError {
  const id = itemId.toLowerCase();
  const target = placeId.toLowerCase();
  const item = items.find((i) => i.id === id);
  if (!item) return "item_not_found";
  if (!item.alternatives.includes(target)) return "not_alternative";
  const original = item.replacedPlaceId ?? item.placeId;
  return items.map((i) =>
    i.id !== id
      ? i
      : {
          ...i,
          placeId: target,
          alternatives: [...i.alternatives.filter((a) => a !== target), i.placeId],
          replacedPlaceId: target === original ? null : original,
        },
  );
}

export function removeItem(
  items: readonly UserPlanItemRecord[],
  itemId: string,
): UserPlanItemRecord[] | PlanEditError {
  const id = itemId.toLowerCase();
  if (!items.some((i) => i.id === id)) return "item_not_found";
  return items.filter((i) => i.id !== id);
}

/** Расстояние по большому кругу (сфера R = 6371 км), м — для подсказки «300 м» между пунктами дня. */
export function sphericalMeters(a: LonLat, b: LonLat): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
}
