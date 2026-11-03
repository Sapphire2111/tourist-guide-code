// Карта Google создаётся один раз и берётся из пула: смена мест/радиуса — только маркеры; уход и возврат на экран —
// та же карта (без новой платной загрузки). Сбой /categories — карта без подписей категорий. API — фейк.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@tg/ui";
import { GuideProvider, type GuideEnv } from "./context.js";
import type * as GoogleMaps from "./google-maps.js";
import type { GuideApi, PlaceSummary } from "./types.js";

const calls = vi.hoisted(() => ({
  map: 0,
  fit: 0,
  markers: [] as { map: unknown; content: HTMLElement | null; title?: string; click?: () => void }[],
  circles: [] as { fillOpacity?: number; map: unknown }[],
  polylines: 0,
  clusterAdds: 0,
  info: [] as HTMLElement[],
  fail: false,
}));

vi.mock("@googlemaps/markerclusterer", () => ({
  MarkerClusterer: class {
    addMarkers(m: unknown[]) {
      calls.clusterAdds += m.length;
    }
    clearMarkers() {}
    setMap() {}
  },
}));

vi.mock("./google-maps.js", async (orig) => {
  const real = await orig<typeof GoogleMaps>();
  class Overlay {
    map: unknown;
    constructor(o: { map?: unknown }) {
      this.map = o.map ?? null;
    }
    setMap(m: unknown) {
      this.map = m;
    }
  }
  const libs = {
    core: {
      LatLngBounds: class {
        pts: unknown[] = [];
        extend(p: unknown) {
          this.pts.push(p);
        }
        getCenter() {
          return this.pts[0];
        }
      },
      event: { addListenerOnce: () => ({ remove: () => undefined }) },
    },
    maps: {
      Map: class {
        constructor() {
          calls.map++;
        }
        fitBounds() {
          calls.fit++;
        }
        setCenter() {}
        setZoom() {}
        getZoom() {
          return 12;
        }
      },
      InfoWindow: class {
        setContent(n: HTMLElement) {
          calls.info.push(n);
        }
        open() {}
        close() {}
      },
      Circle: class extends Overlay {
        fillOpacity?: number;
        constructor(o: { map?: unknown; fillOpacity?: number }) {
          super(o);
          this.fillOpacity = o.fillOpacity;
          calls.circles.push(this);
        }
      },
      Polyline: class extends Overlay {
        constructor(o: { map?: unknown }) {
          super(o);
          calls.polylines++;
        }
      },
    },
    marker: {
      AdvancedMarkerElement: class {
        map: unknown;
        content: HTMLElement | null;
        title?: string;
        click?: () => void;
        constructor(o: { map?: unknown; content?: HTMLElement; title?: string }) {
          this.map = o.map ?? null;
          this.content = o.content ?? null;
          this.title = o.title;
          calls.markers.push(this);
        }
        addListener(_e: string, f: () => void) {
          this.click = f;
        }
      },
    },
  };
  return {
    ...real,
    loadMapsApi: () => (calls.fail ? Promise.reject(new Error("net")) : Promise.resolve(libs)),
  };
});

const { default: PlacesMap, CLUSTER_MIN } = await import("./PlacesMap.js");
const { resetMapsForTests } = await import("./google-maps.js");

beforeEach(() => {
  resetMapsForTests();
  Object.assign(calls, {
    map: 0,
    fit: 0,
    markers: [],
    circles: [],
    polylines: 0,
    clusterAdds: 0,
    info: [],
    fail: false,
  });
});
afterEach(cleanup);

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const place = (id: string, name = id): PlaceSummary => ({
  id,
  name: { uk: name },
  categoryId: "cafe",
  location: { lat: 48.45, lng: 24.56 },
  distanceMeters: 100,
  cover: null,
  openNow: null,
  recommended: false,
  adLabel: null,
});

const e: GuideEnv = {
  api: { categories: vi.fn(async () => Promise.reject(new Error("net"))) } as unknown as GuideApi,
  analytics: { track: () => undefined } as unknown as GuideEnv["analytics"],
  base: null,
  regionId: "r",
  signedIn: false,
};

function wrap(node: React.ReactNode) {
  return (
    <I18nProvider locale="uk">
      <GuideProvider value={e}>{node}</GuideProvider>
    </I18nProvider>
  );
}

const onMap = () => calls.markers.filter((m) => m.map);

describe("PlacesMap (Google Maps)", () => {
  it("смена мест и радиуса — без пересоздания карты; сбой /categories — легенда «Інше»", async () => {
    const center = { lat: 48.45, lng: 24.56 };
    const view = render(wrap(<PlacesMap places={[place("a")]} center={center} radius={500} />));
    await flush();
    view.rerender(wrap(<PlacesMap places={[place("a"), place("b")]} center={center} radius={1000} />));
    await flush();
    expect(calls.map).toBe(1);
    // На карте: база + 2 места (прежние маркеры сняты), один круг радиуса.
    expect(onMap()).toHaveLength(3);
    expect(calls.circles.filter((c) => c.map)).toHaveLength(1);
    expect(calls.fit).toBe(2);
    expect(view.getByTestId("map-legend").textContent).toContain("Інше");
    expect(view.container.querySelector('[data-testid="map-me"]')).toBeNull();
    expect(onMap().find((m) => m.content?.dataset.group === "other")?.title).toBe("a");
  });

  it("уход с экрана и возврат — та же карта из пула (без новой загрузки)", async () => {
    const first = render(wrap(<PlacesMap places={[place("a")]} center={null} />));
    await flush();
    expect(first.getByTestId("places-map").childElementCount).toBe(1);
    first.unmount();
    expect(onMap()).toHaveLength(0);
    const second = render(wrap(<PlacesMap places={[place("b")]} center={null} />));
    await flush();
    expect(calls.map).toBe(1);
    expect(second.getByTestId("places-map").childElementCount).toBe(1);
    // Два экрана одновременно — вторая карта.
    render(wrap(<PlacesMap places={[place("c")]} center={null} />));
    await flush();
    expect(calls.map).toBe(2);
  });

  it("«Ви тут»: только свой значок и круг точности, карта и маркеры мест остаются", async () => {
    const places = [place("a")];
    const view = render(wrap(<PlacesMap places={places} center={null} me={null} />));
    await flush();
    const before = calls.markers.length;
    view.rerender(
      wrap(<PlacesMap places={places} center={null} me={{ lat: 48.4, lng: 24.5, accuracy: 30 }} />),
    );
    await flush();
    expect(calls.markers.length).toBe(before + 1);
    const me = calls.markers.at(-1)!;
    expect(me.content?.getAttribute("aria-label")).toBe("Ви тут");
    expect(calls.circles.filter((c) => c.map && c.fillOpacity === 0.12)).toHaveLength(1);
    view.rerender(wrap(<PlacesMap places={places} center={null} me={{ lat: 48.41, lng: 24.5 }} />));
    await flush();
    expect(me.map).toBeNull();
    expect(calls.circles.filter((c) => c.map)).toHaveLength(0);
    expect(calls.map).toBe(1);
    expect(calls.fit).toBe(0);
    expect(onMap()).toHaveLength(2);
  });

  it("много мест — кластеры; маршрут — линия и номера остановок без кластеров", async () => {
    const many = Array.from({ length: CLUSTER_MIN }, (_, i) => place(`p${i}`));
    const view = render(wrap(<PlacesMap places={many} center={null} />));
    await flush();
    expect(calls.clusterAdds).toBe(CLUSTER_MIN);
    expect(calls.polylines).toBe(0);
    view.rerender(wrap(<PlacesMap places={many} center={null} route />));
    await flush();
    expect(calls.clusterAdds).toBe(CLUSTER_MIN);
    expect(calls.polylines).toBe(1);
    expect(onMap().map((m) => m.content?.textContent)).toEqual(many.map((_, i) => String(i + 1)));
  });

  it("подпись по нажатию: название — текст, не HTML", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    render(wrap(<PlacesMap places={[place("a", evil)]} center={null} />));
    await flush();
    act(() => calls.markers[0]!.click!());
    const box = calls.info.at(-1)!;
    expect(box.querySelector("strong")?.textContent).toBe(evil);
    expect(box.querySelector("img")).toBeNull();
  });

  it("API не загрузился — сообщение, список рядом остаётся", async () => {
    calls.fail = true;
    const view = render(wrap(<PlacesMap places={[place("a")]} center={null} />));
    await flush();
    expect(view.getByRole("alert").textContent).toBe("Карту не вдалося завантажити. Нижче — список.");
  });
});
