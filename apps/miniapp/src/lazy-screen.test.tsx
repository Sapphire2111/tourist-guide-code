// Ленивый экран: потерянный чанк после деплоя — автоперезагрузка один раз и по кнопке «Спробувати ще раз».
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@tg/ui";
import { lazyScreen } from "./bookings/lazy.js";

const reload = vi.fn();
vi.stubGlobal("location", { reload, pathname: "/", href: "http://localhost/" });

afterEach(() => {
  cleanup();
  reload.mockClear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.stubGlobal("location", { reload, pathname: "/", href: "http://localhost/" });
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("lazyScreen", () => {
  it("ошибка чанка: одна автоперезагрузка, затем кнопка перезагружает снова", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Сервер отвечает (index.html), входной скрипт сравнить нельзя — это деплой.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html></html>")),
    );
    const Screen = lazyScreen(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/x.js")),
    );
    render(
      <I18nProvider locale="uk">
        <Screen />
      </I18nProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByTestId("screen-load-error")).toBeDefined();
    expect(reload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" }));
    await flush();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("обычная ошибка: перезагрузки нет, кнопка повторяет загрузку", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(() => <p>ok</p>);
    const Screen = lazyScreen(load);
    render(
      <I18nProvider locale="uk">
        <Screen />
      </I18nProvider>,
    );
    await flush();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" }));
    await flush();
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("ok")).toBeDefined();
  });
});
