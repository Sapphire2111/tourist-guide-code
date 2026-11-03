// Загрузчик Google Maps: без ключа — отказ без сети; с ключом — один скрипт на сессию; API уже на странице — без
// скрипта; сбой скрипта — повтор возможен.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMapsApi, mapsAuthFailed, onMapsAuthFailure, resetMapsForTests } from "./google-maps.js";
import { mapsAvailable, setMapsConfigForTests } from "./map-config.js";

const w = window as unknown as Record<string, unknown> & { google?: unknown };

afterEach(() => {
  resetMapsForTests();
  setMapsConfigForTests({ key: "" });
  delete w.google;
  for (const s of document.querySelectorAll("script")) s.remove();
});

function fakeApi() {
  const importLibrary = vi.fn(async (name: string) => ({ name }));
  w.google = { maps: { importLibrary } };
  return importLibrary;
}

describe("loadMapsApi", () => {
  it("без ключа — карта недоступна, скрипт не вставляется", async () => {
    expect(mapsAvailable()).toBe(false);
    await expect(loadMapsApi()).rejects.toThrow();
    expect(document.querySelector("script")).toBeNull();
  });

  it("с ключом — один скрипт (async, язык интерфейса), затем библиотеки core/maps/marker", async () => {
    setMapsConfigForTests({ key: "test-key" });
    expect(mapsAvailable()).toBe(true);
    const p = loadMapsApi("uk");
    expect(loadMapsApi("en")).toBe(p);
    const scripts = document.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    const url = new URL(scripts[0]!.src);
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/js");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("loading")).toBe("async");
    expect(url.searchParams.get("language")).toBe("uk");
    const importLibrary = fakeApi();
    (w[url.searchParams.get("callback")!] as () => void)();
    const libs = await p;
    expect(importLibrary.mock.calls.map((c) => c[0])).toEqual(["core", "maps", "marker"]);
    expect(libs.marker).toEqual({ name: "marker" });
  });

  it("сбой скрипта — отказ, следующий вызов пробует снова", async () => {
    setMapsConfigForTests({ key: "test-key" });
    const p = loadMapsApi();
    document.querySelector("script")!.dispatchEvent(new Event("error"));
    await expect(p).rejects.toThrow();
    expect(document.querySelector("script")).toBeNull();
    void loadMapsApi().catch(() => undefined);
    expect(document.querySelectorAll("script")).toHaveLength(1);
  });

  it("API уже на странице — без ключа и без скрипта", async () => {
    const importLibrary = fakeApi();
    expect(mapsAvailable()).toBe(true);
    await loadMapsApi();
    expect(importLibrary).toHaveBeenCalledTimes(3);
    expect(document.querySelector("script")).toBeNull();
  });

  it("gm_authFailure — флаг отказа и уведомление подписчиков (и подписавшихся позже)", () => {
    setMapsConfigForTests({ key: "test-key" });
    void loadMapsApi().catch(() => undefined);
    const early = vi.fn();
    onMapsAuthFailure(early);
    expect(mapsAuthFailed()).toBe(false);
    (w.gm_authFailure as () => void)();
    expect(mapsAuthFailed()).toBe(true);
    expect(early).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    onMapsAuthFailure(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
