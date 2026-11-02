// Карта создаётся один раз: смена мест/радиуса — только слой маркеров; сбой /categories — карта без подписей категорий.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { GuideProvider, type GuideEnv } from "./context.js";
import type { GuideApi, PlaceSummary } from "./types.js";

const calls = vi.hoisted(() => ({
  map: 0,
  remove: 0,
  clear: 0,
  fit: 0,
  markers: 0,
  me: 0,
  meCircles: 0,
}));

vi.mock("leaflet", () => {
  const chain = () => {
    const o: Record<string, unknown> = {};
    for (const k of ["addTo", "bindTooltip", "bindPopup", "setStyle", "on"]) o[k] = () => o;
    o.getElement = () => undefined;
    return o;
  };
  const L = {
    map: () => {
      calls.map++;
      return {
        remove: () => calls.remove++,
        fitBounds: () => calls.fit++,
        setView: () => undefined,
      };
    },
    control: { zoom: () => chain() },
    tileLayer: () => chain(),
    layerGroup: () => {
      const o = chain();
      o.clearLayers = () => calls.clear++;
      return o;
    },
    circleMarker: () => {
      calls.markers++;
      return chain();
    },
    circle: (_c: unknown, o: { className?: string }) => {
      if (o?.className === "kosiv-me-accuracy") calls.meCircles++;
      return chain();
    },
    divIcon: (o: unknown) => o,
    marker: () => {
      calls.me++;
      return chain();
    },
    latLngBounds: (b: unknown) => b,
  };
  return { default: L };
});
vi.mock("leaflet/dist/leaflet.css", () => ({}));

const { default: PlacesMap } = await import("./PlacesMap.js");

afterEach(cleanup);

const place = (id: string): PlaceSummary => ({
  id,
  name: { uk: id },
  categoryId: "cafe",
  location: { lat: 48.45, lng: 24.56 },
  distanceMeters: 100,
  cover: null,
  openNow: null,
  recommended: false,
  adLabel: null,
});

function env(categories: GuideApi["categories"]): GuideEnv {
  return {
    api: { categories } as unknown as GuideApi,
    analytics: { track: () => undefined } as unknown as GuideEnv["analytics"],
    base: null,
    regionId: "r",
    signedIn: false,
  };
}

describe("PlacesMap", () => {
  it("смена мест и радиуса — без пересоздания карты; сбой /categories — карта работает", async () => {
    Object.assign(calls, { map: 0, remove: 0, clear: 0, fit: 0, markers: 0 });
    const e = env(vi.fn(async () => Promise.reject(new Error("net"))));
    const center = { lat: 48.45, lng: 24.56 };
    const view = render(
      <GuideProvider value={e}>
        <PlacesMap places={[place("a")]} center={center} radius={500} />
      </GuideProvider>,
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    view.rerender(
      <GuideProvider value={e}>
        <PlacesMap places={[place("a"), place("b")]} center={center} radius={1000} />
      </GuideProvider>,
    );
    expect(calls.map).toBe(1);
    expect(calls.remove).toBe(0);
    // Слой мест перестроен дважды: центр + 1 место, затем центр + 2 места.
    expect(calls.markers).toBe(5);
    expect(calls.fit).toBe(2);
    // Легенда без справочника: группа «Інше».
    expect(view.getByTestId("map-legend").textContent).toContain("Інше");
    // Без позиции значок «Ви тут» не создаётся.
    expect(calls.me).toBe(0);
  });

  it("позиция устройства: значок и круг точности: только слой «Ви тут», карта не пересоздаётся", async () => {
    Object.assign(calls, { map: 0, remove: 0, clear: 0, fit: 0, markers: 0, me: 0, meCircles: 0 });
    const e = env(vi.fn(async () => Promise.reject(new Error("net"))));
    const places = [place("a")];
    const view = render(
      <GuideProvider value={e}>
        <PlacesMap places={places} center={null} me={null} />
      </GuideProvider>,
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(calls.me).toBe(0);
    view.rerender(
      <GuideProvider value={e}>
        <PlacesMap places={places} center={null} me={{ lat: 48.4, lng: 24.5, accuracy: 30 }} />
      </GuideProvider>,
    );
    expect(calls.me).toBe(1);
    expect(calls.meCircles).toBe(1);
    // Новая позиция: слой обновляется, карта и маркеры мест остаются.
    view.rerender(
      <GuideProvider value={e}>
        <PlacesMap places={places} center={null} me={{ lat: 48.41, lng: 24.5 }} />
      </GuideProvider>,
    );
    expect(calls.me).toBe(2);
    expect(calls.map).toBe(1);
    expect(calls.fit).toBe(0);
    expect(calls.markers).toBe(1);
  });
});
