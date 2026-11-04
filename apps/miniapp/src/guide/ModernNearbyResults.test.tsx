// Список мест для карты стабилен между рендерами: иначе карта сбрасывает охват и окно маркера на каждый шаг ползунка.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GuideProvider, type GuideEnv } from "./context.js";
import { ModernNearbyResults } from "./Nearby.js";
import type { GuideApi, PlaceSummary } from "./types.js";

const seen: PlaceSummary[][] = [];
vi.mock("./MapSlot.js", () => ({
  MapSlot: ({ places }: { places: PlaceSummary[] }) => {
    seen.push(places);
    return <div data-testid="fake-map" />;
  },
  preloadMap: () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  seen.length = 0;
});

const place = (id: string, name: string): PlaceSummary => ({
  id,
  name: { uk: name },
  categoryId: "c1",
  location: { lat: 48.45, lng: 24.56 },
  distanceMeters: 100,
  cover: null,
  openNow: true,
  recommended: false,
  adLabel: null,
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("ModernNearbyResults", () => {
  it("ссылка на visible не меняется при перерисовке без смены списка и фильтров", async () => {
    const api = {
      categories: vi.fn(async () => [
        { id: "c1", parentId: null, name: { uk: "Кафе" }, homeSection: "eat" as const },
        { id: "c2", parentId: null, name: { uk: "Крамниці" }, homeSection: "shop" as const },
        { id: "c3", parentId: null, name: { uk: "Пам'ятки" }, homeSection: "nearby" as const },
      ]),
    } as unknown as GuideApi;
    const env = {
      api,
      analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
      base: null,
      regionId: "r",
      signedIn: true,
    } as unknown as GuideEnv;
    const list = [
      place("a", "Смерека"),
      { ...place("b", "Гуцульська хата"), categoryId: "c2" },
      { ...place("c", "Пам'ятник"), categoryId: "c3" },
    ];
    const ui = (radius: number) => (
      <GuideProvider value={env}>
        <ModernNearbyResults list={list} radius={radius} base={null} me={null} loading={false} />
      </GuideProvider>
    );
    const { rerender } = render(ui(500));
    await flush();
    const before = seen[seen.length - 1];
    rerender(ui(600));
    rerender(ui(700));
    expect(seen[seen.length - 1]).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Де поїсти" }));
    expect(seen[seen.length - 1]).not.toBe(before);
    expect(seen[seen.length - 1]).toHaveLength(1);
  });

  it("поиска и плашки ближайшего нет; чип «Що поруч» не показан, его места — в «Усі поруч»", async () => {
    const api = {
      categories: vi.fn(async () => [
        { id: "c1", parentId: null, name: { uk: "Кафе" }, homeSection: "eat" as const },
        { id: "c3", parentId: null, name: { uk: "Пам'ятки" }, homeSection: "nearby" as const },
      ]),
    } as unknown as GuideApi;
    const env = {
      api,
      analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
      base: null,
      regionId: "r",
      signedIn: true,
    } as unknown as GuideEnv;
    const list = [place("a", "Смерека"), { ...place("c", "Пам'ятник"), categoryId: "c3" }];
    const { container } = render(
      <GuideProvider value={env}>
        <ModernNearbyResults list={list} radius={1000} base={null} me={null} loading={false} />
      </GuideProvider>,
    );
    await flush();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(container.querySelector(".modern-map-spot")).toBeNull();
    const chips = within(screen.getByRole("group", { name: "Категорії місць поруч" }));
    expect(chips.getAllByRole("button").map((b) => b.textContent)).toEqual(["✦Усі поруч", "🍲Де поїсти"]);
    expect(seen[seen.length - 1]).toHaveLength(2);
  });

  it("выстраивает места от ближайшего к более далёкому", async () => {
    const api = {
      categories: vi.fn(async () => [
        { id: "c1", parentId: null, name: { uk: "Кафе" }, homeSection: "eat" as const },
      ]),
    } as unknown as GuideApi;
    const env = {
      api,
      analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
      base: null,
      regionId: "r",
      signedIn: true,
    } as unknown as GuideEnv;
    const list: PlaceSummary[] = [
      { ...place("far", "Далека полонина"), distanceMeters: 850 },
      { ...place("near", "Близька кавʼярня"), distanceMeters: 120 },
      { ...place("mid", "Середня колиба"), distanceMeters: 340 },
    ];
    render(
      <GuideProvider value={env}>
        <ModernNearbyResults list={list} radius={1000} base={null} me={null} loading={false} />
      </GuideProvider>,
    );
    await flush();
    expect(seen[seen.length - 1]?.map((p) => p.id)).toEqual(["near", "mid", "far"]);
    const items = screen.getAllByTestId("place-item");
    expect(items.map((el) => el.textContent)).toEqual([
      expect.stringContaining("Близька кавʼярня"),
      expect.stringContaining("Середня колиба"),
      expect.stringContaining("Далека полонина"),
    ]);
  });
});
