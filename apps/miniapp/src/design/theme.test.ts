import { afterEach, describe, expect, it, vi } from "vitest";
import { NIGHT_WINDOW_COLORS, readTheme, saveTheme, THEME_STORAGE_KEY } from "./theme.js";
import { syncTelegramColors } from "./SeasonProvider.js";
import type { TelegramWebApp } from "../telegram.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("по умолчанию «День»; сохранённая «night» читается", () => {
    expect(readTheme()).toBe("day");
    saveTheme("night");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("night");
    expect(readTheme()).toBe("night");
  });
  it("повреждённое значение — «День»", () => {
    localStorage.setItem(THEME_STORAGE_KEY, '{"x":1}');
    expect(readTheme()).toBe("day");
  });
  it("хранилище недоступно: чтение — «День», запись не падает", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readTheme()).toBe("day");
    expect(() => saveTheme("night")).not.toThrow();
  });
  it("цвета окна Telegram: «Ніч» — тёмные, «День» — по сезону", () => {
    const webApp = { setBackgroundColor: vi.fn(), setHeaderColor: vi.fn() } as unknown as TelegramWebApp;
    syncTelegramColors(webApp, "summer", "night");
    expect(webApp.setBackgroundColor).toHaveBeenCalledWith(NIGHT_WINDOW_COLORS.bg);
    expect(webApp.setHeaderColor).toHaveBeenCalledWith(NIGHT_WINDOW_COLORS.surface);
    syncTelegramColors(webApp, "summer");
    expect(webApp.setBackgroundColor).toHaveBeenLastCalledWith("#FDFBF6");
  });
});
