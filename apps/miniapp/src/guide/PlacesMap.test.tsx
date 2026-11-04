// Карта Google создаётся один раз и берётся из пула: смена мест/радиуса — только маркеры; уход и возврат на экран —
// та же карта (без новой платной загрузки). Сбой /categories — карта без подписей категорий. API — фейк.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { I18nProvider } from "@tg/ui";
import { ThemeProvider, useTheme } from "../design/ThemeProvider.js";
import { GuideProvider, type GuideEnv } from "./context.js";
import type * as GoogleMaps from "./google-maps.js";
import type { GuideApi, PlaceSummary } from "./types.js";

const calls = vi.hoisted(() => ({
  map: 0,
  fit: 0,
  markers: [] as { map: unknown; content: HTMLElement | null; title?: string; click?: () => void }[],
  circles: [] as { fillOpacity?: number; strokeColor?: string; map: unknown }[],
  schemes: [] as (string | undefined)[],
  maps: [] as { scheme?: string }[],
  clusterMaps: [] as unknown[],
  dragstart: null as (() => void) | null,
  routeColors: [] as (string | undefined)[],
  polylines: 0,
  clusterAdds: 0,
  info: [] as HTMLElement[],
  fail: false,
  authFailed: false,
  authListeners: [] as (() => void)[],
  resizes: 0,
}));

vi.mock("@googlemaps/markerclusterer", () => ({
  MarkerClusterer: class {
    constructor(o: { map?: unknown }) {
      calls.clusterMaps.push(o.map);
    }
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
      ControlPosition: { RIGHT_CENTER: 8, RIGHT_BOTTOM: 12 },
      LatLngBounds: class {
        pts: unknown[] = [];
        extend(p: unknown) {
          this.pts.push(p);
        }
        getCenter() {
          return this.pts[0];
        }
      },
      event: {
        addListenerOnce: () => ({ remove: () => undefined }),
        trigger: (_m: unknown, e: string) => {
          if (e === "resize") calls.resizes++;
        },
      },
    },
    maps: {
      Map: class {
        constructor(_div: unknown, o?: { colorScheme?: string }) {
          calls.map++;
          calls.schemes.push(o?.colorScheme);
          this.scheme = o?.colorScheme;
          calls.maps.push(this);
        }
        scheme?: string;
        addListener(name: string, f: () => void) {
          if (name === "dragstart") calls.dragstart = f;
          return { remove: () => undefined };
        }
        fitBounds() {
          calls.fit++;
        }
        setCenter() {}
        setZoom() {}
        setOptions() {}
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
        strokeColor?: string;
        constructor(o: { map?: unknown; fillOpacity?: number; strokeColor?: string }) {
          super(o);
          this.fillOpacity = o.fillOpacity;
          this.strokeColor = o.strokeColor;
          calls.circles.push(this);
        }
      },
      Polyline: class extends Overlay {
        constructor(o: { map?: unknown; icons?: { icon: { strokeColor?: string } }[] }) {
          super(o);
          calls.routeColors.push(o.icons?.[0]?.icon.strokeColor);
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
        addEventListener(e: string, f: () => void) {
          if (e === "gmp-click") this.click = f;
        }
      },
    },
  };
  return {
    ...real,
    loadMapsApi: () => (calls.fail ? Promise.reject(new Error("net")) : Promise.resolve(libs)),
    mapsAuthFailed: () => calls.authFailed,
    onMapsAuthFailure: (l: () => void) => {
      if (calls.authFailed) l();
      calls.authListeners.push(l);
      return () => undefined;
    },
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
    schemes: [],
    maps: [],
    clusterMaps: [],
    dragstart: null,
    routeColors: [],
    polylines: 0,
    clusterAdds: 0,
    info: [],
    fail: false,
    authFailed: false,
    authListeners: [],
    resizes: 0,
  });
});
afterEach(cleanup);

// Вид карты ставится в следующем кадре (requestAnimationFrame) — ждём его.
// Первый act — загрузка API и эффекты, второй — кадр, в котором ставится вид.
const flush = async () => {
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  await act(async () => new Promise((r) => setTimeout(r, 40)));
};

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
    // Перед подгонкой границ карта узнаёт размер нового узла.
    expect(calls.resizes).toBe(2);
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

  it("смена темы на открытом экране — карта нужной схемы, маркеры и круг на месте", async () => {
    document.documentElement.setAttribute("data-theme", "day");
    const center = { lat: 48.45, lng: 24.56 };
    function Switch() {
      const { setTheme } = useTheme();
      return (
        <button type="button" onClick={() => setTheme("night")}>
          night
        </button>
      );
    }
    const view = render(
      wrap(
        <ThemeProvider>
          <Switch />
          <PlacesMap places={[place("a")]} center={center} radius={500} />
        </ThemeProvider>,
      ),
    );
    await flush();
    expect(calls.schemes).toEqual(["LIGHT"]);
    act(() => view.getByText("night").click());
    await flush();
    expect(calls.schemes).toEqual(["LIGHT", "DARK"]);
    // На новой карте: база + место, один круг; на старой (в пуле) ничего не осталось.
    expect(onMap()).toHaveLength(2);
    expect(calls.circles.filter((c) => c.map)).toHaveLength(1);
    expect(view.getByTestId("places-map").childElementCount).toBe(1);
    localStorage.clear();
  });

  it("линия маршрута: тёмная на светлой карте, светлая в «Ніч»", async () => {
    const places = [place("a"), { ...place("b"), location: { lat: 48.46, lng: 24.57 } }];
    document.documentElement.setAttribute("data-theme", "day");
    const day = render(
      wrap(
        <ThemeProvider>
          <PlacesMap places={places} center={null} route />
        </ThemeProvider>,
      ),
    );
    await flush();
    day.unmount();
    localStorage.setItem("tg.theme", "night");
    document.documentElement.setAttribute("data-theme", "night");
    render(
      wrap(
        <ThemeProvider>
          <PlacesMap places={places} center={null} route />
        </ThemeProvider>,
      ),
    );
    await flush();
    localStorage.clear();
    expect(calls.routeColors).toEqual(["#111827", "#fde68a"]);
  });

  it("смена темы при ≥ CLUSTER_MIN мест: кластеризатор строится только на карте новой схемы", async () => {
    document.documentElement.setAttribute("data-theme", "day");
    function Switch() {
      const { setTheme } = useTheme();
      return (
        <button type="button" onClick={() => setTheme("night")}>
          night
        </button>
      );
    }
    const many = Array.from({ length: CLUSTER_MIN }, (_, i) => place(`p${i}`));
    const view = render(
      wrap(
        <ThemeProvider>
          <Switch />
          <PlacesMap places={many} center={null} />
        </ThemeProvider>,
      ),
    );
    await flush();
    act(() => view.getByText("night").click());
    await flush();
    const dark = calls.maps.find((m) => m.scheme === "DARK");
    expect(dark).toBeDefined();
    // Каждый созданный кластеризатор на карте своей схемы; последний — на тёмной.
    expect(calls.clusterMaps.length).toBeGreaterThan(0);
    expect(calls.clusterMaps.at(-1)).toBe(dark);
    expect(calls.clusterMaps.filter((m) => m === dark)).toHaveLength(1);
    localStorage.clear();
  });

  it("смена размера не сбрасывает ручное перемещение; «Список ↓» и новый набор мест — подгоняют", async () => {
    let notify: () => void = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          notify = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const tree = (places: PlaceSummary[]) =>
        wrap(
          <div data-map-mode="full" data-testid="mode">
            <PlacesMap places={places} center={{ lat: 48.4, lng: 24.5 }} />
          </div>,
        );
      const view = render(tree([place("a"), place("b")]));
      await flush();
      const host = view.getByTestId("places-map");
      let height = 400;
      const resize = async () => {
        height -= 50;
        Object.defineProperty(host, "clientHeight", { configurable: true, value: height });
        notify();
        await act(async () => new Promise((r) => setTimeout(r, 200)));
      };
      const fit = calls.fit;
      // Без перемещения (клавиатура, поворот) — подгонка.
      await resize();
      expect(calls.fit).toBe(fit + 1);
      // Пользователь двинул карту — подгонки нет, но размер карте сообщён.
      act(() => calls.dragstart?.());
      const resizes = calls.resizes;
      await resize();
      expect(calls.fit).toBe(fit + 1);
      expect(calls.resizes).toBe(resizes + 1);
      // Явная смена режима — подгоняем всегда.
      view.getByTestId("mode").setAttribute("data-map-mode", "split");
      await resize();
      expect(calls.fit).toBe(fit + 2);
      // Флаг сброшен: обычная смена размера снова подгоняет.
      await resize();
      expect(calls.fit).toBe(fit + 3);
      // Новый набор мест сбрасывает флаг.
      act(() => calls.dragstart?.());
      view.rerender(tree([place("a"), place("c")]));
      await flush();
      const afterPlaces = calls.fit;
      await resize();
      expect(calls.fit).toBe(afterPlaces + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("режим сцены задаёт проп floating, а не наличие плашки", async () => {
    const center = { lat: 48.45, lng: 24.56 };
    const view = render(wrap(<PlacesMap places={[]} center={center} radius={500} overlay={<i>plate</i>} />));
    await flush();
    expect(calls.circles.at(-1)?.strokeColor).toBe("#1d4ed8");
    view.rerender(wrap(<PlacesMap places={[]} center={center} radius={500} floating />));
    await flush();
    expect(calls.circles.at(-1)?.strokeColor).toBe("#E06D2B");
  });

  it("смена высоты окна карты — новый размер карте и повторная подгонка границ", async () => {
    let notify: () => void = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          notify = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    try {
      const view = render(
        wrap(<PlacesMap places={[place("a"), place("b")]} center={{ lat: 48.4, lng: 24.5 }} />),
      );
      await flush();
      const fit = calls.fit;
      const resizes = calls.resizes;
      const host = view.getByTestId("places-map");
      Object.defineProperty(host, "clientHeight", { configurable: true, value: 306 });
      notify();
      await act(async () => new Promise((r) => setTimeout(r, 200)));
      expect(calls.fit).toBe(fit + 1);
      expect(calls.resizes).toBe(resizes + 1);
      // Размер не менялся — подгонка не повторяется.
      notify();
      await act(async () => new Promise((r) => setTimeout(r, 200)));
      expect(calls.fit).toBe(fit + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("API не загрузился — плашка с ближайшим местом остаётся над заглушкой", async () => {
    calls.fail = true;
    const view = render(wrap(<PlacesMap places={[place("a")]} center={null} overlay={<i>plate</i>} />));
    await flush();
    expect(view.getByText("plate")).toBeDefined();
  });

  it("API не загрузился — сообщение, список рядом остаётся", async () => {
    calls.fail = true;
    const view = render(wrap(<PlacesMap places={[place("a")]} center={null} />));
    await flush();
    expect(view.getByRole("alert").textContent).toBe("Карту не вдалося завантажити. Нижче — список.");
  });

  it("ключ отклонён (gm_authFailure) — сообщение; повторный заход — сразу сообщение, без карты Google", async () => {
    const first = render(wrap(<PlacesMap places={[place("a")]} center={null} />));
    await flush();
    expect(first.getByTestId("places-map")).toBeDefined();
    calls.authFailed = true;
    act(() => calls.authListeners.forEach((l) => l()));
    expect(first.getByRole("alert").textContent).toBe("Карту не вдалося завантажити. Нижче — список.");
    first.unmount();
    const maps = calls.map;
    const second = render(wrap(<PlacesMap places={[place("b")]} center={null} />));
    await flush();
    expect(second.getByRole("alert")).toBeDefined();
    expect(second.queryByTestId("places-map")).toBeNull();
    expect(calls.map).toBe(maps);
  });
});
