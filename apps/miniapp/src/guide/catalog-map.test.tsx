// Каталог: центр карты (выбранная локация / GPS / QR) и пометка неполной выдачи «Де жити».
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Analytics } from "./analytics.js";
import { Catalog, selectedCenter } from "./Catalog.js";
import { GuideProvider, type GuideEnv } from "./context.js";
import { LOCATION_STORAGE_KEY, LocationProvider } from "./LocationProvider.js";
import type { GuideApi, SearchParams } from "./types.js";

const centers: unknown[] = [];
vi.mock("./MapSlot.js", () => ({
  MapSlot: (p: { center: unknown }) => {
    centers.push(p.center);
    return <div data-testid="map" />;
  },
}));

afterEach(() => {
  cleanup();
  centers.length = 0;
  window.localStorage.clear();
});

const REGION = "00000000-0000-4000-8000-0000000000a1";
const STAY = "00000000-0000-4000-8000-000000000301";
const LOC = "00000000-0000-4000-8000-000000000401";
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function env(search: GuideApi["search"]): GuideEnv {
  const api = {
    categories: vi.fn(async () => [
      { id: STAY, parentId: null, name: { uk: "Де жити" }, homeSection: "stay" as const },
    ]),
    localities: vi.fn(async () => [
      { id: LOC, name: { uk: "Татарів" }, placeCount: 3, location: { lat: 48.3, lng: 24.6 } },
      { id: "loc-2", name: { uk: "Яремче" }, placeCount: 5, location: { lat: 48.45, lng: 24.55 } },
    ]),
    search,
  } as unknown as GuideApi;
  return {
    api,
    analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() } as unknown as Analytics,
    base: { name: "Готель", point: { lat: 48.4, lng: 24.5 } },
    regionId: REGION,
    signedIn: true,
  };
}

const place = {
  id: "p1",
  name: { uk: "Садиба" },
  categoryId: STAY,
  location: { lat: 48.3, lng: 24.6 },
  distanceMeters: 1,
  cover: null,
  openNow: null,
  recommended: false,
  adLabel: null,
};

const mount = async (search: GuideApi["search"]) => {
  render(
    <GuideProvider value={env(search)}>
      <LocationProvider>
        <Catalog section="stay" />
      </LocationProvider>
    </GuideProvider>,
  );
  await flush();
  await flush();
};

describe("каталог: центр карты", () => {
  it("ничего не выбрано — центр в точке QR", async () => {
    await mount(vi.fn(async () => [place]));
    expect(centers.at(-1)).toEqual({ lat: 48.4, lng: 24.5 });
  });

  it("выбрана локация — центр по локации, не по QR", async () => {
    window.localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: REGION, ids: [LOC] }));
    await mount(vi.fn(async () => [place]));
    expect(centers.at(-1)).toEqual({ lat: 48.3, lng: 24.6 });
  });

  it("selectedCenter: середина нескольких пунктов, без координат — null", () => {
    const o = (id: string, lat: number, lng: number) => ({
      id,
      name: { uk: id },
      placeCount: 1,
      location: { lat, lng },
    });
    expect(selectedCenter([o("a", 48, 24), o("b", 50, 26)], ["a", "b"])).toEqual({ lat: 49, lng: 25 });
    expect(selectedCenter([{ id: "a", name: { uk: "a" }, placeCount: 1 }], ["a"])).toBeNull();
  });
});

describe("«Де жити»: неполная выдача", () => {
  it("api сообщило onPartial — показывается пометка", async () => {
    await mount(
      vi.fn(async (p: SearchParams) => {
        p.onPartial?.();
        return [place];
      }),
    );
    expect(screen.getByTestId("catalog-partial").textContent).toContain("Показано не всі заклади");
  });

  it("полная выдача — пометки нет", async () => {
    await mount(vi.fn(async () => [place]));
    expect(screen.queryByTestId("catalog-partial")).toBeNull();
  });
});
