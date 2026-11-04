import { afterEach, describe, expect, it, vi } from "vitest";
import { WINDOW_COLORS, readTheme, saveTheme, THEME_STORAGE_KEY } from "./theme.js";
import { syncTelegramColors } from "./SeasonProvider.js";
import type { TelegramWebApp } from "../telegram.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("по умолчанию «Ніч»; сохранённая «day» уважается", () => {
    expect(readTheme()).toBe("night");
    saveTheme("day");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("day");
    expect(readTheme()).toBe("day");
  });
  it("повреждённое значение — «Ніч»", () => {
    localStorage.setItem(THEME_STORAGE_KEY, '{"x":1}');
    expect(readTheme()).toBe("night");
  });
  it("хранилище недоступно: чтение — «Ніч», запись не падает", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readTheme()).toBe("night");
    expect(() => saveTheme("day")).not.toThrow();
  });
  it("цвета окна Telegram по теме: шапка — верх неба, фон и нижняя панель — низ картинки", () => {
    const webApp = {
      setBackgroundColor: vi.fn(),
      setHeaderColor: vi.fn(),
      setBottomBarColor: vi.fn(),
    } as unknown as TelegramWebApp;
    syncTelegramColors(webApp, "night");
    expect(webApp.setBackgroundColor).toHaveBeenLastCalledWith(WINDOW_COLORS.night.bottom);
    expect(webApp.setHeaderColor).toHaveBeenLastCalledWith(WINDOW_COLORS.night.header);
    expect(webApp.setBottomBarColor).toHaveBeenLastCalledWith(WINDOW_COLORS.night.bottom);
    syncTelegramColors(webApp);
    expect(webApp.setBackgroundColor).toHaveBeenLastCalledWith("#16382B");
    expect(webApp.setHeaderColor).toHaveBeenLastCalledWith("#FDE8D0");
    expect(webApp.setBottomBarColor).toHaveBeenLastCalledWith("#16382B");
  });
});
