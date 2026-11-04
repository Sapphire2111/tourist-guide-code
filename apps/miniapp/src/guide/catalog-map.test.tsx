// Каталог: центр карты (выбранная локация / GPS / QR) и пометка неполной выдачи «Де жити».
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Analytics } from "./analytics.js";
import { Catalog, resolveMapCenter, selectedCenter } from "./Catalog.js";
import { GuideProvider, type GuideEnv } from "./context.js";
import { LOCATION_STORAGE_KEY, LocationProvider } from "./LocationProvider.js";
import type * as Geo from "./geo.js";
import type { GuideApi, SearchParams } from "./types.js";

const geoState = vi.hoisted(() => ({ point: null as { lat: number; lng: number } | null }));
vi.mock("./geo.js", async (orig) => ({
  ...(await orig<typeof Geo>()),
  requestLocationIfGranted: async () => geoState.point,
  requestLocation: async () => geoState.point,
}));

const centers: unknown[] = [];
const markers: unknown[] = [];
vi.mock("./MapSlot.js", () => ({
  MapSlot: (p: { center: unknown; centerMarker?: boolean }) => {
    centers.push(p.center);
    markers.push(p.centerMarker);
    return <div data-testid="map" />;
  },
}));

afterEach(() => {
  cleanup();
  geoState.point = null;
  centers.length = 0;
  markers.length = 0;
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
    // Середина локаций — не точка: метку «Базова точка» не рисуем.
    expect(markers.at(-1)).toBe(false);
  });

  it("QR без выбора: метка центра рисуется", async () => {
    await mount(vi.fn(async () => [place]));
    expect(markers.at(-1)).toBe(true);
  });

  it("центр — тот же объект между рендерами (ввод в поиске не пересоздаёт маркеры)", async () => {
    window.localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: REGION, ids: [LOC] }));
    await mount(vi.fn(async () => [place]));
    const before = centers.at(-1);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "са" } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "сад" } });
    await flush();
    expect(centers.at(-1)).toBe(before);
  });

  it("resolveMapCenter: GPS важнее выбранных локаций и QR", () => {
    const gps = { lat: 1, lng: 2 };
    const qr = { lat: 9, lng: 9 };
    const opts = [{ id: "a", name: { uk: "a" }, placeCount: 1, location: { lat: 48, lng: 24 } }];
    expect(resolveMapCenter(gps, opts, ["a"], qr)).toBe(gps);
    expect(resolveMapCenter(null, opts, ["a"], qr)).toEqual({ lat: 48, lng: 24 });
    expect(resolveMapCenter(null, opts, [], qr)).toBe(qr);
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

describe("каталог: ползунок радиуса", () => {
  it("значение по умолчанию видно; изменение перезапрашивает места с новым радиусом", async () => {
    const search = vi.fn(async (_p: SearchParams) => [place]);
    await mount(search);
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("aria-valuetext")).toBe("Усі місця");
    expect(screen.getByTestId("radius-slider-value").textContent).toBe("Усі місця");
    expect(search.mock.calls.at(-1)![0].radius).toBeUndefined();
    // Шаг 3 — 2 км.
    fireEvent.change(slider, { target: { value: "3" } });
    expect(screen.getByTestId("radius-slider-value").textContent).toBe("2 км");
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    await flush();
    expect(search.mock.calls.at(-1)![0].radius).toBe(2000);
  });

  it("выбраны локации — ползунка нет", async () => {
    window.localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: REGION, ids: [LOC] }));
    await mount(vi.fn(async () => [place]));
    expect(screen.queryByRole("slider")).toBeNull();
  });
});

describe("каталог: радиус с GPS и возврат к «Усі місця»", () => {
  const near = { lat: 48.45, lng: 24.55 };
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...place, id: `p${i}` }));
  // Только запросы от точки устройства (первый запрос идёт от QR, пока точка не определена).
  const radii = (s: ReturnType<typeof vi.fn>) =>
    s.mock.calls
      .map((c) => c[0] as SearchParams)
      .filter((p) => p.point?.lat === near.lat)
      .map((p) => p.radius);

  it("GPS, достаточно мест — по умолчанию 3 км", async () => {
    geoState.point = near;
    const search = vi.fn(async (_p: SearchParams) => many(6));
    await mount(search);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("3 км");
    expect(radii(search)).toEqual([3000]);
  });

  it("GPS, мало мест — расширение до 10 км видно на ползунке; явный радиус расширение отключает", async () => {
    geoState.point = near;
    const search = vi.fn(async (p: SearchParams) => (p.radius === 10_000 ? many(3) : many(1)));
    await mount(search);
    expect(radii(search)).toEqual([3000, 10_000]);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("10 км");
    search.mockClear();
    // Явно 3 км (шаг 4): один запрос, без расширения.
    fireEvent.change(screen.getByRole("slider"), { target: { value: "4" } });
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    await flush();
    expect(radii(search)).toEqual([3000]);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("3 км");
  });

  it("последний шаг «Усі місця» возвращает выдачу без радиуса", async () => {
    const search = vi.fn(async (_p: SearchParams) => [place]);
    await mount(search);
    const slider = screen.getByRole("slider");
    expect(slider.getAttribute("max")).toBe("9");
    fireEvent.change(slider, { target: { value: "8" } });
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    await flush();
    expect(search.mock.calls.at(-1)![0].radius).toBe(20_000);
    expect(slider.getAttribute("aria-valuetext")).toBe("20 км");
    fireEvent.change(slider, { target: { value: "9" } });
    await act(async () => new Promise((r) => setTimeout(r, 450)));
    await flush();
    expect(search.mock.calls.at(-1)![0].radius).toBeUndefined();
    expect(slider.getAttribute("aria-valuetext")).toBe("Усі місця");
  });
});

describe("«Де жити»: неполная выдача", () => {
  it("сбой догрузки — пометка про незагруженные заклади", async () => {
    await mount(
      vi.fn(async (p: SearchParams) => {
        p.onPartial?.("failed");
        return [place];
      }),
    );
    expect(screen.getByTestId("catalog-partial").textContent).toContain("Частину закладів не вдалося");
  });

  it("усечение по лимиту — нейтральная пометка с числом, без «оновити»", async () => {
    await mount(
      vi.fn(async (p: SearchParams) => {
        p.onPartial?.("truncated");
        return [place];
      }),
    );
    const text = screen.getByTestId("catalog-partial").textContent!;
    expect(text).toContain("перші 300");
    expect(text).not.toContain("оновити");
  });

  it("полная выдача — пометки нет", async () => {
    await mount(vi.fn(async () => [place]));
    expect(screen.queryByTestId("catalog-partial")).toBeNull();
  });
});
