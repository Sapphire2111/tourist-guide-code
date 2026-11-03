import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chunkLostByDeploy,
  isChunkLoadError,
  reloadForChunkError,
  reloadOnceForChunkError,
} from "./chunk-reload.js";

const reload = vi.fn();
vi.stubGlobal("location", { reload });

const setOnline = (v: boolean) => vi.spyOn(navigator, "onLine", "get").mockReturnValue(v);
const err = (url = "") => new TypeError(`Failed to fetch dynamically imported module: ${url}`);

afterEach(() => {
  reload.mockClear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("location", { reload });
});

describe("chunk-reload", () => {
  it("узнаёт ошибки загрузки чанка", () => {
    expect(isChunkLoadError(err("/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
  });

  it("автоперезагрузка один раз за окно", async () => {
    expect(await reloadOnceForChunkError(undefined, 1_000)).toBe(true);
    expect(await reloadOnceForChunkError(undefined, 2_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await reloadOnceForChunkError(undefined, 100_000)).toBe(true);
  });

  it("без sessionStorage не перезагружает (нет цикла)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(await reloadOnceForChunkError()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("офлайн: ни авто-перезагрузки, ни перезагрузки по кнопке", async () => {
    setOnline(false);
    expect(await reloadOnceForChunkError(err("/a.js"))).toBe(false);
    expect(reloadForChunkError(err("/a.js"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("кнопка онлайн: перезагрузка только для ошибки чанка", () => {
    expect(reloadForChunkError(new Error("boom"))).toBe(false);
    expect(reloadForChunkError(err("/a.js"))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("деплой: чанк отдал HTML или 404; сеть упала или JS на месте — не деплой", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    f.mockResolvedValueOnce(new Response("<html>", { headers: { "content-type": "text/html" } }));
    expect(await chunkLostByDeploy(err("https://x.test/a.js"))).toBe(true);
    f.mockResolvedValueOnce(new Response("", { status: 404 }));
    expect(await chunkLostByDeploy(err("https://x.test/a.js"))).toBe(true);
    f.mockRejectedValueOnce(new TypeError("net"));
    expect(await chunkLostByDeploy(err("https://x.test/a.js"))).toBe(false);
    f.mockResolvedValueOnce(new Response("x", { headers: { "content-type": "text/javascript" } }));
    expect(await chunkLostByDeploy(err("https://x.test/a.js"))).toBe(false);
    // Адреса в тексте нет (Safari) — считаем деплоем.
    expect(await chunkLostByDeploy(new TypeError("Importing a module script failed."))).toBe(true);
  });
});
