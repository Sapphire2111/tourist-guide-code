import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DesignProvider, useDesign } from "./DesignProvider.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.design;
});
function Probe() {
  return <p>{useDesign().design}</p>;
}
describe("design", () => {
  it("is always modern", () => {
    render(
      <DesignProvider>
        <Probe />
      </DesignProvider>,
    );
    expect(screen.getByText("modern")).toBeTruthy();
    expect(document.documentElement.dataset.design).toBe("modern");
  });
  it("ignores the legacy saved value and never touches storage", () => {
    localStorage.setItem("tg.design", "original");
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    render(
      <DesignProvider>
        <Probe />
      </DesignProvider>,
    );
    expect(document.documentElement.dataset.design).toBe("modern");
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
