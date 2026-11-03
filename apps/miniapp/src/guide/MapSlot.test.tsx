// Без ключа — заглушка. Повтор загрузки карты: сбой модуля → успешная предзагрузка → следующий экран показывает карту.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@tg/ui";
import { MapSlot, preloadMap, setMapLoaderForTests } from "./MapSlot.js";

afterEach(cleanup);

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("MapSlot", () => {
  // Первым: setMapLoaderForTests ниже включает карту без ключа.
  it("без ключа Google Maps — заглушка, модуль карты не грузится", async () => {
    render(
      <I18nProvider locale="uk">
        <MapSlot places={[]} center={null} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("map-unavailable").textContent).toBe("Карта недоступна. Нижче — список.");
    await expect(preloadMap()).rejects.toThrow();
    expect(document.querySelector("link[data-map-preconnect]")).toBeNull();
  });

  it("после сбоя загрузки модуля и успешной предзагрузки карта появляется", async () => {
    let fail = true;
    setMapLoaderForTests(async () => {
      if (fail) throw new Error("chunk");
      return { default: () => <div data-testid="fake-map" /> };
    });
    const ui = (
      <I18nProvider locale="uk">
        <MapSlot places={[]} center={null} />
      </I18nProvider>
    );
    render(ui);
    await flush();
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Карту не вдалося завантажити. Нижче — список.");
    cleanup();
    fail = false;
    await preloadMap();
    render(ui);
    await flush();
    expect(screen.getByTestId("fake-map")).toBeDefined();
  });
});
