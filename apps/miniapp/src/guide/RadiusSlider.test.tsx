import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RadiusSlider } from "./RadiusSlider.js";
import { GuideProvider, type GuideEnv } from "./context.js";

afterEach(cleanup);

function setup(haptic = vi.fn()) {
  const env = { webApp: { HapticFeedback: { selectionChanged: haptic } } } as unknown as GuideEnv;
  const onChange = vi.fn();
  const view = (value: number | null, allowAll = false) => (
    <GuideProvider value={env}>
      <RadiusSlider value={value} onChange={onChange} allowAll={allowAll} overlay />
    </GuideProvider>
  );
  return { haptic, onChange, view };
}

describe("RadiusSlider «Жаринка»", () => {
  it("9 делений, заполнение --p по индексу, пройденные деления помечены", () => {
    const { view } = setup();
    render(view(2000));
    const box = screen.getByTestId("radius-slider");
    expect(box.querySelectorAll(".kosiv-rs-ticks i")).toHaveLength(9);
    expect(box.querySelectorAll(".kosiv-rs-ticks i[data-passed]")).toHaveLength(4);
    expect(box.style.getPropertyValue("--p")).toBe(String(3 / 8));
  });

  it("allowAll: 10-е деление — кольцо, «Усі місця» в valuetext", () => {
    const { view } = setup();
    render(view(null, true));
    expect(document.querySelectorAll(".kosiv-rs-ticks i[data-all]")).toHaveLength(1);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Усі місця");
  });

  it("новый шаг — onChange и щелчок хаптики", () => {
    const { view, onChange, haptic } = setup();
    render(view(1000));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "5" } });
    expect(onChange).toHaveBeenCalledWith(5000);
    expect(haptic).toHaveBeenCalledTimes(1);
  });
});
