import { afterEach, describe, expect, it, vi } from "vitest";
import { isChunkLoadError, reloadForChunkError, reloadOnceForChunkError } from "./chunk-reload.js";

const reload = vi.fn();
vi.stubGlobal("location", { reload });

afterEach(() => {
  reload.mockClear();
  sessionStorage.clear();
});

describe("chunk-reload", () => {
  it("узнаёт ошибки загрузки чанка", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
  });

  it("автоперезагрузка один раз за окно", () => {
    expect(reloadOnceForChunkError(1_000)).toBe(true);
    expect(reloadOnceForChunkError(2_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnceForChunkError(100_000)).toBe(true);
  });

  it("без sessionStorage не перезагружает (нет цикла)", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(reloadOnceForChunkError()).toBe(false);
    spy.mockRestore();
  });

  it("кнопка: перезагрузка только для ошибки чанка", () => {
    expect(reloadForChunkError(new Error("boom"))).toBe(false);
    expect(reloadForChunkError(new TypeError("Failed to fetch dynamically imported module"))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
