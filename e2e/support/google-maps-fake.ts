// Фейк Google Maps JavaScript API для E2E: в CI нет ключа и сети. Скрипт ставится до загрузки страницы — Mini App
// видит API «уже на странице» (map-config.ts: mapsApiOnPage) и не грузит настоящий. Маркеры, подписи, круги и линии —
// обычные DOM-узлы внутри узла карты: тесты нажимают маркеры и проверяют подписи и маршрут.
// Кластеры здесь не рисуются (фейк без проекции): в тестах мест меньше порога PlacesMap.CLUSTER_MIN.
import type { Page } from "@playwright/test";

function fakeGoogleMaps() {
  type Host = { node: HTMLElement };
  const hostOf = (m: unknown): HTMLElement | null => (m as Host | null)?.node ?? null;

  class FakeMap {
    node: HTMLElement;
    zoom = 12;
    center: unknown = null;
    constructor(div: HTMLElement) {
      this.node = document.createElement("div");
      this.node.className = "gm-fake-map";
      this.node.style.cssText = "position:relative;width:100%;height:100%;background:#e5e3df;overflow:hidden";
      div.appendChild(this.node);
    }
    fitBounds() {}
    setCenter(c: unknown) {
      this.center = c;
    }
    getCenter() {
      return this.center;
    }
    setZoom(z: number) {
      this.zoom = z;
    }
    getZoom() {
      return this.zoom;
    }
    addListener() {
      return { remove() {} };
    }
    getMapCapabilities() {
      return { isAdvancedMarkersAvailable: true };
    }
  }

  /** Объект на карте (круг, линия): узел-заглушка с data-fake. */
  class Shape {
    node = document.createElement("div");
    constructor(kind: string, o: { map?: unknown }) {
      this.node.dataset.fake = kind;
      this.node.style.cssText = "position:absolute;left:0;top:0;width:4px;height:4px";
      this.setMap(o.map ?? null);
    }
    setMap(m: unknown) {
      const host = hostOf(m);
      if (host) host.appendChild(this.node);
      else this.node.remove();
    }
  }

  class AdvancedMarkerElement {
    node = document.createElement("div");
    private _map: unknown = null;
    private _content: HTMLElement | null = null;
    constructor(o: { map?: unknown; content?: HTMLElement; title?: string; gmpClickable?: boolean }) {
      this.node.className = "gm-fake-marker";
      this.node.style.cssText = "display:inline-block;margin:24px 0 0 24px";
      // Как у настоящего: нажимаемый маркер — кнопка с подписью title, остальные — просто title.
      if (o.gmpClickable) {
        this.node.setAttribute("role", "button");
        this.node.tabIndex = 0;
        if (o.title) this.node.setAttribute("aria-label", o.title);
      } else if (o.title) this.node.title = o.title;
      this.content = o.content ?? null;
      this.map = o.map ?? null;
    }
    get content() {
      return this._content;
    }
    set content(c: HTMLElement | null) {
      this._content?.remove();
      this._content = c;
      if (c) this.node.appendChild(c);
    }
    get map() {
      return this._map;
    }
    set map(m: unknown) {
      this._map = m;
      const host = hostOf(m);
      if (host) host.appendChild(this.node);
      else this.node.remove();
    }
    addListener(_event: string, f: () => void) {
      this.node.addEventListener("click", f);
      return { remove: () => this.node.removeEventListener("click", f) };
    }
  }

  class InfoWindow {
    node = document.createElement("div");
    constructor() {
      this.node.className = "gm-fake-info";
      this.node.style.cssText = "position:absolute;left:8px;top:8px;background:#fff;padding:8px";
    }
    setContent(c: HTMLElement) {
      this.node.replaceChildren(c);
    }
    open(o: { map?: unknown }) {
      hostOf(o.map)?.appendChild(this.node);
    }
    close() {
      this.node.remove();
    }
  }

  class LatLngBounds {
    pts: unknown[] = [];
    extend(p: unknown) {
      this.pts.push(p);
      return this;
    }
    getCenter() {
      return this.pts[0];
    }
  }

  const event = { addListenerOnce: () => ({ remove() {} }), trigger() {}, removeListener() {} };
  const libs: Record<string, unknown> = {
    core: { LatLngBounds, event },
    maps: {
      Map: FakeMap,
      InfoWindow,
      Circle: class extends Shape {
        constructor(o: { map?: unknown }) {
          super("circle", o);
        }
      },
      Polyline: class extends Shape {
        constructor(o: { map?: unknown }) {
          super("polyline", o);
        }
      },
    },
    marker: { AdvancedMarkerElement },
  };
  (window as unknown as { google: unknown }).google = {
    maps: {
      importLibrary: async (name: string) => libs[name],
      Map: FakeMap,
      OverlayView: class {
        setMap() {}
      },
      LatLngBounds,
      event,
      marker: { AdvancedMarkerElement },
    },
  };
}

/** Подложить фейк до загрузки страницы (фикстура делает это по умолчанию; test.use({ googleMaps: false }) — без него). */
export async function installGoogleMapsFake(page: Page): Promise<void> {
  await page.addInitScript(fakeGoogleMaps);
}
