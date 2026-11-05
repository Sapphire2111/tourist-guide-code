// Правила прайса заведения (миграция 0030) без БД и Nest: перестановка ▲▼, лимиты, версия, порядок показа.
import type { MoveDirection } from "./price-list.dto.js";

type Ordered = { id: string; sort_order: number };

/** Строки по порядку показа: sort_order, при равенстве — id (uuidv7 — по времени создания). */
export function byOrder<T extends Ordered>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * ▲▼: новый порядок id после обмена с соседом; null — двигать некуда (первый вверх, последний вниз) или id нет.
 */
export function moved(ids: readonly string[], id: string, direction: MoveDirection): string[] | null {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return null;
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Новые sort_order (0, 1, 2…) для порядка ids: только строки, у которых значение меняется. */
export function renumber(
  rows: readonly Ordered[],
  order: readonly string[],
): { id: string; sortOrder: number }[] {
  const current = new Map(rows.map((r) => [r.id, r.sort_order]));
  return order.flatMap((id, sortOrder) => (current.get(id) === sortOrder ? [] : [{ id, sortOrder }]));
}

/** Следующий sort_order в конец списка. */
export function nextSortOrder(rows: readonly Ordered[]): number {
  return rows.reduce((max, r) => Math.max(max, r.sort_order + 1), 0);
}

/** Можно добавить ещё одну строку при лимите. */
export const underLimit = (count: number, max: number): boolean => count < max;

/** Версия из запроса совпадает с текущей (не передана — без проверки, как у ресурсов блока 7). */
export const versionMatches = (expected: number | undefined, current: number): boolean =>
  expected === undefined || expected === current;

/** Позиция видна туристу: сама и раздел — active (не hidden и не archived). */
export const visibleToTourist = (sectionStatus: string, itemStatus: string): boolean =>
  sectionStatus === "active" && itemStatus === "active";

/** Цена позиции: bigint из pg (строка) → число копеек. */
export const priceOf = (raw: string | number): number => (typeof raw === "number" ? raw : Number(raw));
