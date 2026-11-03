import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chunkLostByDeploy,
  isChunkLoadError,
  reloadForChunkError,
  reloadOnceForChunkError,
} from "./chunk-reload.js";

const reload = vi.fn();
vi.stubGlobal("location", { reload, pathname: "/", href: "http://localhost/" });

const setOnline = (v: boolean) => vi.spyOn(navigator, "onLine", "get").mockReturnValue(v);
const err = (url = "") => new TypeError(`Failed to fetch dynamically imported module: ${url}`);

afterEach(() => {
  reload.mockClear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("location", { reload, pathname: "/", href: "http://localhost/" });
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
    expect(await reloadForChunkError(err("/a.js"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("кнопка: деплой — перезагрузка; сеть или не чанк — false (повтор import)", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await reloadForChunkError(new Error("boom"))).toBe(false);
    f.mockResolvedValueOnce(new Response("<html>", { headers: { "content-type": "text/html" } }));
    expect(await reloadForChunkError(err("https://x.test/a.js"))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    f.mockRejectedValueOnce(new TypeError("net"));
    expect(await reloadForChunkError(err("https://x.test/a.js"))).toBe(false);
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
  });

  it("без адреса (iOS): сеть упала — не деплой; сервер отвечает, хэш сравнить нельзя — деплой; хэш входа сравнивается", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const e = new TypeError("Importing a module script failed.");
    f.mockRejectedValueOnce(new TypeError("net"));
    expect(await chunkLostByDeploy(e)).toBe(false);
    f.mockResolvedValueOnce(new Response('<script type="module" src="/assets/index-new.js"></script>'));
    expect(await chunkLostByDeploy(e)).toBe(true);
    // Текущий вход страницы — index-old.js.
    const s = document.createElement("script");
    s.type = "module";
    s.src = "/assets/index-old.js";
    document.head.appendChild(s);
    const html = (h: string) =>
      new Response(`<script type="module" crossorigin src="/assets/${h}.js"></script>`);
    f.mockResolvedValueOnce(html("index-new"));
    expect(await chunkLostByDeploy(e)).toBe(true);
    f.mockResolvedValueOnce(html("index-old"));
    expect(await chunkLostByDeploy(e)).toBe(false);
    // Входного скрипта в ответе нет (captive portal) — не деплой.
    f.mockResolvedValueOnce(new Response("<html>Sign in to Wi-Fi</html>"));
    expect(await chunkLostByDeploy(e)).toBe(false);
    s.remove();
  });

  it("таймаут проверочного запроса — не деплой", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise(() => undefined)),
      );
      const p = chunkLostByDeploy(err("https://x.test/a.js"));
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("тело ответа читается под тем же таймаутом", async () => {
    vi.useFakeTimers();
    try {
      const res = new Response("x");
      vi.spyOn(res, "text").mockImplementation(() => new Promise(() => undefined));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => res),
      );
      const p = chunkLostByDeploy(new TypeError("Importing a module script failed."));
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
