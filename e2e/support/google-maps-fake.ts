// Фейк Google Maps JavaScript API для E2E: в CI нет ключа и сети. Скрипт ставится до загрузки страницы — Mini App
// видит API «уже на странице» (map-config.ts: mapsApiOnPage) и не грузит настоящий. Маркеры, подписи, круги и линии —
// обычные DOM-узлы внутри узла карты: тесты нажимают маркеры и проверяют подписи и маршрут.
// Кластеры не рисуются (у фейка нет проекции, getProjection() — null), но настоящий MarkerClusterer создаётся и работает
// поверх OverlayView фейка (методы перечислимые: библиотека копирует их в свой прототип); карта с кластеризатором
// получает data-clusterer, а маркеры при ≥ PlacesMap.CLUSTER_MIN местах остаются не на карте — как под кластерами.
// Режим сверки дизайна (window.__gmFakeScatter, design-shots.spec.ts): условная подложка-топография, логотип и условия Google,
// кнопки масштаба и маркеры на местах, как на эталоне; настоящие тайлы и подписи карты так не проверить.
import type { Page } from "@playwright/test";

function fakeGoogleMaps() {
  type Host = { node: HTMLElement };
  const scatter = () => (window as unknown as { __gmFakeScatter?: boolean }).__gmFakeScatter === true;
  // Доли области карты: первая — база, дальше места по удалённости (координаты прототипа x/360, y/360).
  const SLOTS: [number, number][] = [
    [50, 53],
    [60, 54],
    [32, 46],
    [75, 40],
    [26, 71],
    [79, 68],
    [18, 31],
  ];
  const TOPO = (night: boolean) => {
    const c = night
      ? ["#0E231B", "#143327", "#2B5B46", "#1E5B6E", "#2D4A3E", "#233D32"]
      : ["#E3EFEA", "#C9E2D8", "#9BBDB0", "#7BC4D4", "#FFFFFF", "#F7FAF8"];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 360" preserveAspectRatio="xMidYMid slice"><rect width="360" height="360" fill="${c[0]}"/><path d="M0 0L140 0Q110 90 40 140L0 120ZM220 0L360 0L360 190Q260 160 240 80ZM0 240Q90 220 150 290L130 360L0 360ZM240 220Q300 200 360 250L360 360L210 360Z" fill="${c[1]}"/><g fill="none" stroke="${c[2]}" stroke-dasharray="3 3" opacity=".65"><circle cx="310" cy="60" r="55"/><circle cx="310" cy="60" r="85"/><circle cx="40" cy="310" r="65"/></g><path d="M35 0C95 85 130 140 165 195C200 250 265 295 330 360" fill="none" stroke="${c[3]}" stroke-width="14" opacity=".75"/><path d="M0 185Q110 170 180 190T360 175" fill="none" stroke="${c[4]}" stroke-width="8"/><path d="M180 190L215 110M120 180L95 265M245 185L285 255" fill="none" stroke="${c[5]}" stroke-width="4"/><circle cx="180" cy="190" r="145" fill="none" stroke="#E06D2B" stroke-width="1.5" stroke-dasharray="4 4"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") center/cover`;
  };
  const hostOf = (m: unknown): HTMLElement | null => (m as Host | null)?.node ?? null;

  class FakeMap {
    node: HTMLElement;
    zoom = 12;
    center: unknown = null;
    constructor(div: HTMLElement, opts?: { colorScheme?: string }) {
      this.node = document.createElement("div");
      this.node.className = "gm-fake-map";
      // Схема, с которой «создана» карта (LIGHT/DARK): тесты проверяют, что смена темы даёт карту нужной схемы.
      this.node.dataset.colorScheme = opts?.colorScheme ?? "";
      this.node.dataset.fitCount = "0";
      this.node.dataset.resizeCount = "0";
      this.node.style.cssText =
        "position:relative;box-sizing:border-box;width:100%;height:100%;background:#e5e3df;overflow:hidden;padding:24px 0 0 24px";
      div.appendChild(this.node);
      if (scatter()) {
        const night = document.documentElement.dataset.theme === "night";
        this.node.style.background = TOPO(night);
        this.node.style.padding = "0";
        const chrome = (css: string, text: string) => {
          const n = document.createElement("div");
          n.dataset.fake = "chrome";
          n.style.cssText = `position:absolute;font:11px Arial,sans-serif;color:#333;${css}`;
          n.textContent = text;
          this.node.appendChild(n);
        };
        chrome("left:6px;bottom:4px;font:bold 15px Arial;color:#5f6368", "Google");
        chrome("right:0;bottom:0;background:rgb(255 255 255 / 70%);padding:1px 5px", "Умови");
        chrome(
          "right:10px;top:50%;transform:translateY(-50%);width:40px;height:81px;background:#fff;border-radius:2px;font-size:20px;text-align:center;line-height:40px;box-shadow:0 1px 4px rgb(0 0 0 / 30%)",
          "+ −",
        );
      }
    }
    // Отступы fitBounds (число или {top,right,bottom,left}) настоящая карта оставляет свободными от маркеров:
    // фейк без проекции раскладывает маркеры потоком, поэтому отступ сверху/слева применяется как padding узла.
    fitBounds(_b: unknown, padding?: number | { top?: number; left?: number }) {
      const p = typeof padding === "number" ? { top: padding, left: padding } : padding;
      // Сколько раз и с каким верхним/нижним отступом подгонялись границы (проверка подгонки при смене размера).
      this.node.dataset.fitCount = String(Number(this.node.dataset.fitCount) + 1);
      this.node.dataset.fitPaddingTop = String(p?.top ?? 0);
      this.node.dataset.fitPaddingBottom = String((p as { bottom?: number } | undefined)?.bottom ?? 0);
      this.node.dataset.fitHeight = String(this.node.clientHeight);
      if (!scatter()) this.node.style.padding = `${p?.top ?? 0}px 0 0 ${p?.left ?? 0}px`;
    }
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
    setOptions(o?: { zoomControl?: boolean }) {
      if (o?.zoomControl !== undefined) this.node.dataset.zoomControl = String(o.zoomControl);
    }
    // Настоящая карта двигает окно вместе с собой: фейк сдвигает открытое окно на столько же и считает вызовы.
    panBy(dx: number, dy: number) {
      this.node.dataset.panCount = String(Number(this.node.dataset.panCount ?? 0) + 1);
      const info = this.node.querySelector<HTMLElement>(":scope > .gm-fake-info");
      if (!info) return;
      info.style.left = `${parseFloat(info.style.left) - dx}px`;
      info.style.top = `${parseFloat(info.style.top) - dy}px`;
    }
    getProjection() {
      return null;
    }
    addListener(name?: string, f?: () => void) {
      if (name === "dragstart" && f) this.node.addEventListener("gm-fake-dragstart", f);
      return {
        remove: () => f && name === "dragstart" && this.node.removeEventListener("gm-fake-dragstart", f),
      };
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
      this.node.style.cssText = "display:inline-block";
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
      if (host && scatter()) {
        const [x, y] = SLOTS[host.querySelectorAll(".gm-fake-marker").length % SLOTS.length]!;
        this.node.style.cssText = `position:absolute;left:${x}%;top:${y}%;transform:translate(-50%,-100%)`;
      }
      if (host) host.appendChild(this.node);
      else this.node.remove();
    }
    /** gmp-click настоящего маркера — обычный click по узлу. */
    addEventListener(event: string, f: () => void) {
      if (event === "gmp-click") this.node.addEventListener("click", f);
    }
  }

  class InfoWindow {
    node = document.createElement("div");
    private ready: (() => void)[] = [];
    private closed: (() => void)[] = [];
    constructor(o?: { headerDisabled?: boolean }) {
      this.node.className = "gm-fake-info";
      this.node.dataset.headerDisabled = String(o?.headerDisabled === true);
      this.node.setAttribute("role", "dialog");
      this.node.style.cssText = "position:absolute;left:8px;top:8px;background:#fff;z-index:1";
    }
    setOptions(o: { ariaLabel?: string }) {
      if (o.ariaLabel) this.node.setAttribute("aria-label", o.ariaLabel);
    }
    setContent(c: HTMLElement) {
      this.node.replaceChildren(c);
    }
    addListener(name: string, f: () => void) {
      if (name === "domready") this.ready.push(f);
      if (name === "close") this.closed.push(f);
      return {
        remove: () => {
          this.ready = this.ready.filter((x) => x !== f);
          this.closed = this.closed.filter((x) => x !== f);
        },
      };
    }
    open(o: { map?: unknown; shouldFocus?: boolean }) {
      this.node.dataset.shouldFocus = String(o.shouldFocus === true);
      // Как настоящее окно: появляется на прежнем месте относительно маркера, сдвиг — забота приложения.
      this.node.style.left = "8px";
      this.node.style.top = "8px";
      hostOf(o.map)?.appendChild(this.node);
      setTimeout(() => this.ready.forEach((f) => f()), 0);
    }
    close() {
      this.node.remove();
      this.closed.forEach((f) => f());
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

  // Прототип с перечислимыми методами: MarkerClusterer копирует их циклом for..in (методы class неперечислимы).
  function OverlayView(this: { _map: unknown }) {
    this._map = null;
  }
  OverlayView.prototype.setMap = function (this: { _map: unknown }, m: unknown) {
    const prev = hostOf(this._map);
    if (prev) delete prev.dataset.clusterer;
    this._map = m;
    const host = hostOf(m);
    if (host) host.dataset.clusterer = "true";
  };
  OverlayView.prototype.getMap = function (this: { _map: unknown }) {
    return this._map;
  };
  OverlayView.prototype.getProjection = () => null;
  for (const name of ["onAdd", "draw", "onRemove"]) OverlayView.prototype[name] = () => undefined;

  const event = {
    addListenerOnce: () => ({ remove() {} }),
    // trigger(map, "resize"): считаем — карта получила новый размер.
    trigger(m: unknown, name: string) {
      const host = hostOf(m);
      if (host && name === "resize") host.dataset.resizeCount = String(Number(host.dataset.resizeCount) + 1);
    },
    removeListener() {},
  };
  const libs: Record<string, unknown> = {
    core: { LatLngBounds, event, ControlPosition: { RIGHT_CENTER: 8, RIGHT_BOTTOM: 12 } },
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
      OverlayView,
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
