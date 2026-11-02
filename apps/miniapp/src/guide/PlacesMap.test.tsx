// Карта создаётся один раз: смена мест/радиуса — только слой маркеров; сбой /categories — карта без подписей категорий.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { GuideProvider, type GuideEnv } from "./context.js";
import type { GuideApi, PlaceSummary } from "./types.js";

const calls = vi.hoisted(() => ({ map: 0, remove: 0, clear: 0, fit: 0, markers: 0 }));

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
    circle: () => chain(),
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
    expect(calls.clear).toBe(2);
    expect(calls.fit).toBe(2);
    // Легенда без справочника: группа «Інше».
    expect(view.getByTestId("map-legend").textContent).toContain("Інше");
  });
});
