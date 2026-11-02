// Справочник категорий для подписей мест («Кафе», «Пам'ятка») и цвета маркеров карты: один запрос
// GET /categories на api за открытие, общий для всех списков.
import { useEffect, useState } from "react";
import type { Category, GuideApi, HomeSection } from "./types.js";

const cache = new WeakMap<GuideApi, Promise<Category[]>>();

export function loadCategories(api: GuideApi): Promise<Category[]> {
  let p = cache.get(api);
  if (!p) {
    p = api.categories().catch((e: unknown) => {
      cache.delete(api); // сбой — следующий экран попробует снова
      throw e;
    });
    cache.set(api, p);
  }
  return p;
}

export type CategoryIndex = {
  byId: Map<string, Category>;
  /** Раздел главной для категории (подкатегория — по корню); null — не определён. */
  sectionOf(categoryId: string): HomeSection | null;
};

export function indexCategories(list: Category[]): CategoryIndex {
  const byId = new Map(list.map((c) => [c.id, c]));
  return {
    byId,
    sectionOf(id) {
      let c = byId.get(id);
      for (let i = 0; c && i < 5; i++) {
        if (c.homeSection) return c.homeSection;
        c = c.parentId ? byId.get(c.parentId) : undefined;
      }
      return null;
    },
  };
}

const EMPTY = indexCategories([]);

/** Индекс категорий; пока не загружен или при сбое — пустой (подписи просто не показываются). */
export function useCategoryIndex(api: GuideApi | null | undefined): CategoryIndex {
  const [index, setIndex] = useState<CategoryIndex>(EMPTY);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    loadCategories(api).then(
      (list) => alive && setIndex(indexCategories(list)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api]);
  return index;
}
