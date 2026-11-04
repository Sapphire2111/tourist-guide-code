// Список мест для карты стабилен между рендерами: иначе карта сбрасывает охват и окно маркера на каждый шаг ползунка.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GuideProvider, type GuideEnv } from "./context.js";
import { pickSub } from "./subcategory-test-utils.js";
import { ModernNearbyResults } from "./Nearby.js";
import type { GuideApi, PlaceSummary } from "./types.js";

const seen: PlaceSummary[][] = [];
const mapProps: { radius?: number; radiusCenter?: unknown }[] = [];
vi.mock("./MapSlot.js", () => ({
  MapSlot: ({
    places,
    radius,
    radiusCenter,
  }: {
    places: PlaceSummary[];
    radius?: number;
    radiusCenter?: unknown;
  }) => {
    seen.push(places);
    mapProps.push({ radius, radiusCenter });
    return <div data-testid="fake-map" />;
  },
  preloadMap: () => Promise.resolve(),
}));

afterEach(() => {
  cleanup();
  seen.length = 0;
  mapProps.length = 0;
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

    pickSub("Де поїсти", "nearby-filter");
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
    fireEvent.click(screen.getByTestId("nearby-filter"));
    const options = within(screen.getByRole("dialog")).getAllByRole("radio");
    expect(options.map((r) => r.textContent)).toEqual(["✦Шукати все", "🍲Де поїсти"]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(seen[seen.length - 1]).toHaveLength(2);
  });

  it("подразделы «Що поруч»: Природа / Пам'ятки / Вершини — фильтр по подкатегории (все водоспади)", async () => {
    const api = {
      categories: vi.fn(async () => [
        { id: "n", parentId: null, code: "nearby", name: { uk: "Що поруч" }, homeSection: "nearby" as const },
        { id: "nat", parentId: "n", code: "nature", name: { uk: "Природа" }, homeSection: null },
        { id: "sig", parentId: "n", code: "sights", name: { uk: "Пам'ятки" }, homeSection: null },
        { id: "pk", parentId: "n", code: "peaks", name: { uk: "Вершини" }, homeSection: null },
        { id: "c1", parentId: null, code: "eat", name: { uk: "Кафе" }, homeSection: "eat" as const },
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
      { ...place("w1", "Водоспад Пробій"), categoryId: "nat" },
      { ...place("w2", "Водоспад Гук"), categoryId: "nat" },
      { ...place("p1", "Туркул"), categoryId: "pk" },
      { ...place("s1", "Міст"), categoryId: "sig" },
      place("k", "Кафе"),
    ];
    render(
      <GuideProvider value={env}>
        <ModernNearbyResults list={list} radius={5000} base={null} me={null} loading={false} />
      </GuideProvider>,
    );
    await flush();
    const trigger = screen.getByTestId("nearby-filter");
    expect(trigger.textContent).toContain("Шукати все");
    fireEvent.click(trigger);
    const radios = within(screen.getByRole("dialog")).getAllByRole("radio");
    expect(radios.map((r) => r.textContent?.replace(/^\P{L}+/u, ""))).toEqual(
      expect.arrayContaining(["Шукати все", "Природа", "Пам'ятки", "Вершини"]),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    pickSub("Природа", "nearby-filter");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("nearby-filter").textContent).toContain("Природа");
    expect(seen[seen.length - 1]!.map((p) => p.id).sort()).toEqual(["w1", "w2"]);
    pickSub("Вершини", "nearby-filter");
    expect(seen[seen.length - 1]!.map((p) => p.id)).toEqual(["p1"]);
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

describe("ModernNearbyResults: круг радиуса на карте", () => {
  const env = {
    api: { categories: vi.fn(async () => []) } as unknown as GuideApi,
    analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() },
    base: null,
    regionId: "r",
    signedIn: true,
  } as unknown as GuideEnv;

  it("по геолокации (без базы) — радиус и центр круга = «Ви тут»", async () => {
    const me = { lat: 48.1, lng: 24.1 };
    render(
      <GuideProvider value={env}>
        <ModernNearbyResults list={[]} radius={15_000} base={null} me={me} loading={false} />
      </GuideProvider>,
    );
    await flush();
    expect(mapProps.at(-1)).toEqual({ radius: 15_000, radiusCenter: me });
  });

  it("от базы — круг вокруг базы", async () => {
    const base = { lat: 48.3, lng: 24.3 };
    render(
      <GuideProvider value={env}>
        <ModernNearbyResults list={[]} radius={10_000} base={base} me={null} loading={false} />
      </GuideProvider>,
    );
    await flush();
    expect(mapProps.at(-1)).toEqual({ radius: 10_000, radiusCenter: base });
  });

  it("список — по 50 карточек, «Показати ще» добавляет 50; карта получает все места", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      ...place(`p${i}`, `Місце ${i}`),
      distanceMeters: i,
    }));
    render(
      <GuideProvider value={env}>
        <ModernNearbyResults list={many} radius={15_000} base={null} me={null} loading={false} />
      </GuideProvider>,
    );
    await flush();
    expect(seen.at(-1)).toHaveLength(120);
    expect(screen.getAllByTestId("place-item")).toHaveLength(50);
    fireEvent.click(screen.getByTestId("nearby-more"));
    expect(screen.getAllByTestId("place-item")).toHaveLength(100);
    fireEvent.click(screen.getByTestId("nearby-more"));
    expect(screen.getAllByTestId("place-item")).toHaveLength(120);
    expect(screen.queryByTestId("nearby-more")).toBeNull();
  });
});
