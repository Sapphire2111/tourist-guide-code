import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramLocationManager, TelegramWebApp } from "../telegram.js";
import { canOpenLocationSettings, googleRouteUrl, nearestWithin, requestLocation } from "./geo.js";
import { popupNode, type PopupData } from "./PlacesMap.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function webAppWith(lm: TelegramLocationManager, version = "8.0"): TelegramWebApp {
  return {
    ready: vi.fn(),
    expand: vi.fn(),
    isVersionAtLeast: (v: string) => Number(version) >= Number(v),
    LocationManager: lm,
  };
}

/** LocationManager как в Telegram: init() вызывает колбэк только при первой инициализации. */
function fakeLocationManager(available = true): TelegramLocationManager & { init: ReturnType<typeof vi.fn> } {
  const lm = {
    isInited: false,
    isLocationAvailable: false,
    init: vi.fn((cb?: () => void) => {
      if (lm.isInited) return;
      lm.isInited = true;
      lm.isLocationAvailable = available;
      cb?.();
    }),
    getLocation: vi.fn((cb: (l: { latitude: number; longitude: number } | null) => void) =>
      cb({ latitude: 48.1, longitude: 24.2 }),
    ),
    openSettings: vi.fn(),
  };
  return lm;
}

describe("геолокация через Telegram LocationManager", () => {
  it("первый и повторный запрос — без ожидания таймаута", async () => {
    const lm = fakeLocationManager();
    const webApp = webAppWith(lm);
    expect(await requestLocation(webApp)).toEqual({ lat: 48.1, lng: 24.2 });
    vi.useFakeTimers();
    const second = requestLocation(webApp);
    await vi.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toEqual({ lat: 48.1, lng: 24.2 });
    expect(lm.init).toHaveBeenCalledTimes(1);
    // Таймер гонки очищен — висящих таймеров нет.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("геолокация недоступна в Telegram — null", async () => {
    expect(await requestLocation(webAppWith(fakeLocationManager(false)))).toBeNull();
  });

  it("клиент старше Bot API 8.0 — браузерная геолокация", async () => {
    const lm = fakeLocationManager();
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 1, longitude: 2 } }),
      },
    });
    expect(await requestLocation(webAppWith(lm, "7.10"))).toEqual({ lat: 1, lng: 2 });
    expect(lm.init).not.toHaveBeenCalled();
  });
});

const popupData = (over: Partial<PopupData> = {}): PopupData => ({
  name: "Смерека",
  category: "Кафе",
  id: "p1",
  icon: "📍",
  coverAlt: "Фото: Смерека",
  openText: "Відкрити картку",
  routeText: "Маршрут",
  routeLabel: "Маршрут: Смерека",
  routeHref: "https://www.google.com/maps/dir/?api=1&destination=48.45,24.56",
  closeText: "Закрити",
  navigate: () => undefined,
  openExternal: () => undefined,
  onRoute: () => undefined,
  onClose: () => undefined,
  ...over,
});

describe("подписи карты", () => {
  it("название места — текст, не HTML", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const node = popupNode(
      popupData({ name: evil, category: evil, distance: evil, creditText: evil, cover: null }),
    );
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("strong")?.textContent).toBe(evil);
  });

  it("с обложкой: alt и подпись автора — текст; единственная картинка — обложка", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const node = popupNode(
      popupData({
        name: evil,
        coverAlt: evil,
        creditText: evil,
        cover: {
          url: "https://api.example/places/p1/cover",
          alt: null,
          credit: { authors: [], license: null, sourceUrl: null, source: "google" },
        },
      }),
    );
    const imgs = node.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("src")).toBe("https://api.example/places/p1/cover");
    expect(imgs[0]!.alt).toBe(evil);
    expect(imgs[0]!.getAttribute("loading")).toBe("lazy");
    expect(node.querySelector('[data-testid="cover-credit"]')?.textContent).toBe(evil);
    expect(node.dataset.cover).toBe("photo");
    expect(node.querySelector(".kosiv-map-popup-icon")).toBeNull();
  });

  it("обложка не загрузилась: картинка и подпись убраны, значок раздела вместо них", () => {
    const node = popupNode(
      popupData({
        creditText: "Фото: Автор",
        cover: {
          url: "https://api.example/c",
          alt: null,
          credit: { authors: [], license: null, sourceUrl: null, source: "google" },
        },
      }),
    );
    node.querySelector("img")!.dispatchEvent(new Event("error"));
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector('[data-testid="cover-credit"]')).toBeNull();
    expect(node.dataset.cover).toBe("none");
    expect(node.querySelector(".kosiv-map-popup-icon")?.textContent).toBe("📍");
  });

  it("подпись Wikimedia — ссылка на страницу файла через openExternal", () => {
    const openExternal = vi.fn();
    const node = popupNode(
      popupData({
        openExternal,
        creditText: "Автор, CC BY-SA",
        cover: {
          url: "https://api.example/c",
          alt: null,
          credit: {
            authors: [],
            license: "CC BY-SA",
            sourceUrl: "https://commons.wikimedia.org/wiki/File:x.jpg",
            source: "wikimedia",
          },
        },
      }),
    );
    node.querySelector<HTMLAnchorElement>('[data-testid="cover-credit"] a')!.click();
    expect(openExternal).toHaveBeenCalledWith(
      expect.any(Event),
      "https://commons.wikimedia.org/wiki/File:x.jpg",
    );
  });
});

describe("маршрут в Google Картах", () => {
  it("координаты назначения, без travelmode и точки старта; place id — если есть", () => {
    expect(googleRouteUrl({ lat: 48.45, lng: 24.56 })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=48.45,24.56",
    );
    expect(googleRouteUrl({ lat: 48.45, lng: 24.56 }, "ChIJ x&y")).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=48.45,24.56&destination_place_id=ChIJ%20x%26y",
    );
    expect(googleRouteUrl({ lat: 1, lng: 2 }, null)).not.toContain("destination_place_id");
  });
});

describe("настройки геолокации", () => {
  it("кнопка настроек — только с Bot API 8.0+", () => {
    expect(canOpenLocationSettings(webAppWith(fakeLocationManager(), "8.0"))).toBe(true);
    expect(canOpenLocationSettings(webAppWith(fakeLocationManager(), "7.10"))).toBe(false);
    expect(canOpenLocationSettings(undefined)).toBe(false);
  });
});

describe("nearestWithin", () => {
  const yar = { name: "Яремче", location: { lat: 48.45, lng: 24.55 } };
  const tat = { name: "Татарів", location: { lat: 48.35, lng: 24.58 } };
  const none = { name: "Без точки", location: null };

  it("ближайший пункт в радиусе; без координат пропускается", () => {
    expect(nearestWithin([none, yar, tat], { lat: 48.36, lng: 24.58 }, 15_000)).toBe(tat);
  });

  it("дальше радиуса от любого пункта — null", () => {
    expect(nearestWithin([yar, tat], { lat: 48.45, lng: 24.95 }, 15_000)).toBeNull();
    expect(nearestWithin([], { lat: 48.45, lng: 24.55 }, 15_000)).toBeNull();
  });
});
