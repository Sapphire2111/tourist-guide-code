import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { App, SECTIONS, type Section } from "./App.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("admin App", () => {
  it("меню разделов; по умолчанию — Регіони", () => {
    render(<App />);
    const nav = screen.getByRole("navigation", { name: "Розділи" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
      "Регіони",
      "Аудит",
      "Користувачі",
    ]);
    expect(screen.getByRole("heading", { level: 1, name: "Регіони" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Регіони" }).getAttribute("aria-current")).toBe("page");
  });

  it("переход по hash открывает раздел", async () => {
    render(<App />);
    await act(async () => {
      window.location.hash = "#/audit";
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Аудит" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Аудит" }).getAttribute("aria-current")).toBe("page");
  });

  it("неизвестный путь — «не найдено»", () => {
    window.location.hash = "#/nope";
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Сторінку не знайдено" })).toBeDefined();
  });

  it("локаль en: переведённый ключ — en, непереведённый — fallback на uk", () => {
    render(<App locale="en" />);
    expect(screen.getByText("Tourist Guide · Admin")).toBeDefined();
    expect(screen.getByRole("heading", { level: 1, name: "Регіони" })).toBeDefined();
  });

  it("раздел модуля за фича-флагом: флаг выключен или не загружен — нет в меню и по пути; включён — есть", async () => {
    const sections: Section[] = [
      ...SECTIONS,
      { path: "/bookings", title: "admin.users", flag: "module.bookings" },
    ];
    const links = () =>
      [...screen.getByRole("navigation").querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const flags of [undefined, { "module.bookings": false }]) {
      window.location.hash = "#/bookings";
      render(<App sections={sections} flags={flags} />);
      expect(links()).not.toContain("#/bookings");
      expect(screen.getByRole("heading", { level: 1, name: "Сторінку не знайдено" })).toBeDefined();
      cleanup();
    }
    render(<App sections={sections} flags={{ "module.bookings": true }} />);
    expect(links()).toContain("#/bookings");
    expect(screen.getAllByRole("link", { name: "Користувачі" })).toHaveLength(2);
  });
});
