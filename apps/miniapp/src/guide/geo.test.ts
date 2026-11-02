import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramLocationManager, TelegramWebApp } from "../telegram.js";
import { canOpenLocationSettings, requestLocation } from "./geo.js";
import { textNode } from "./PlacesMap.js";

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

describe("подписи карты", () => {
  it("название места — текст, не HTML", () => {
    const node = textNode('<img src=x onerror="alert(1)">');
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toBe('<img src=x onerror="alert(1)">');
  });
});

describe("настройки геолокации", () => {
  it("кнопка настроек — только с Bot API 8.0+", () => {
    expect(canOpenLocationSettings(webAppWith(fakeLocationManager(), "8.0"))).toBe(true);
    expect(canOpenLocationSettings(webAppWith(fakeLocationManager(), "7.10"))).toBe(false);
    expect(canOpenLocationSettings(undefined)).toBe(false);
  });
});
