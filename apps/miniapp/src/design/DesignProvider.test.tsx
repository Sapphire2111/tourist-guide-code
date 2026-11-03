import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DesignProvider, DesignSwitcher, DESIGN_STORAGE_KEY, readDesign } from "./DesignProvider.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.design;
});
describe("design preference", () => {
  it("defaults to modern, persists original selection and restores after remount", () => {
    const mount = () =>
      render(
        <DesignProvider>
          <DesignSwitcher />
        </DesignProvider>,
      );
    const view = mount();
    expect(document.documentElement.dataset.design).toBe("modern");
    fireEvent.click(screen.getByRole("button", { name: "Оригінальний" }));
    expect(localStorage.getItem(DESIGN_STORAGE_KEY)).toBe("original");
    expect(document.documentElement.dataset.design).toBe("original");
    view.unmount();
    mount();
    expect(screen.getByRole("button", { name: "Оригінальний" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Сучасний" }));
    expect(document.documentElement.dataset.design).toBe("modern");
  });
  it("invalid or inaccessible storage falls back safely and switching still works", () => {
    localStorage.setItem(DESIGN_STORAGE_KEY, "unknown");
    expect(readDesign()).toBe("modern");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(
      <DesignProvider>
        <DesignSwitcher />
      </DesignProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Оригінальний" }));
    expect(document.documentElement.dataset.design).toBe("original");
  });
});
