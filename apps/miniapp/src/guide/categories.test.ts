import { describe, expect, it, vi } from "vitest";
import { indexCategories, loadCategories } from "./categories.js";
import { markerGroup, popupNode, type PopupData } from "./PlacesMap.js";
import type { GuideApi } from "./types.js";

const cats = [
  { id: "eat", parentId: null, name: { uk: "Де поїсти" }, homeSection: "eat" as const },
  { id: "cafe", parentId: "eat", name: { uk: "Кафе" }, homeSection: null },
  { id: "x", parentId: null, name: { uk: "Пам'ятки" }, homeSection: null },
];

const popupData = (over: Partial<PopupData> = {}): PopupData => ({
  name: "Смерека",
  category: "Кафе",
  id: "p1",
  icon: "📍",
  coverAlt: "Фото: Смерека",
  openText: "Відкрити картку",
  routeText: "Маршрут",
  routeLabel: "Маршрут: Смерека",
  routeHref: "https://www.google.com/maps/dir/?api=1&destination=48.45,24.56",
  closeText: "Закрити",
  navigate: () => undefined,
  openExternal: () => undefined,
  onRoute: () => undefined,
  onClose: () => undefined,
  ...over,
});

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
    const node = popupNode(popupData({ name: '<img src=x onerror="1">', navigate }));
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toContain("Кафе");
    node.querySelector<HTMLAnchorElement>("a.kosiv-map-popup-open")!.click();
    expect(navigate).toHaveBeenCalledWith("/place/p1");
  });
});
