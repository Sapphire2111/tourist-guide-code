import { describe, expect, it, vi } from "vitest";
import { indexCategories, loadCategories } from "./categories.js";
import { markerGroup, popupNode } from "./PlacesMap.js";
import type { GuideApi } from "./types.js";

const cats = [
  { id: "eat", parentId: null, name: { uk: "Де поїсти" }, homeSection: "eat" as const },
  { id: "cafe", parentId: "eat", name: { uk: "Кафе" }, homeSection: null },
  { id: "x", parentId: null, name: { uk: "Пам'ятки" }, homeSection: null },
];

describe("справочник категорий", () => {
  it("раздел подкатегории — по корню; неизвестная — null", () => {
    const idx = indexCategories(cats);
    expect(idx.sectionOf("cafe")).toBe("eat");
    expect(idx.sectionOf("x")).toBeNull();
    expect(idx.sectionOf("nope")).toBeNull();
  });

  it("один запрос на api; сбой — повтор при следующем вызове", async () => {
    const categories = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(cats);
    const api = { categories } as unknown as GuideApi;
    await expect(loadCategories(api)).rejects.toThrow("net");
    await loadCategories(api);
    await loadCategories(api);
    expect(categories).toHaveBeenCalledTimes(2);
  });

  it("группа маркера: разделы каталога, остальное — «інше»", () => {
    expect(markerGroup("shop")).toBe("shop");
    expect(markerGroup("help")).toBe("other");
    expect(markerGroup(null)).toBe("other");
  });

  it("подпись маркера — только текст (без HTML из названия), ссылка ведёт в карточку", () => {
    const navigate = vi.fn();
    const node = popupNode('<img src=x onerror="1">', "Кафе", "p1", "Відкрити картку", navigate);
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toContain("Кафе");
    node.querySelector("a")!.click();
    expect(navigate).toHaveBeenCalledWith("/place/p1");
  });
});
