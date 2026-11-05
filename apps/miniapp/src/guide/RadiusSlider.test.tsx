import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RadiusSlider } from "./RadiusSlider.js";
import { GuideProvider, type GuideEnv } from "./context.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(haptic = vi.fn()) {
  const env = { webApp: { HapticFeedback: { selectionChanged: haptic } } } as unknown as GuideEnv;
  const onChange = vi.fn();
  const view = (value: number | null, allowAll = false, disabled = false) => (
    <GuideProvider value={env}>
      <RadiusSlider value={value} onChange={onChange} allowAll={allowAll} disabled={disabled} overlay />
    </GuideProvider>
  );
  return { haptic, onChange, view };
}

const strip = () => document.querySelector<HTMLElement>(".kosiv-rd-strip")!;
const items = () => [...document.querySelectorAll<HTMLElement>(".kosiv-rd-item")];
/** Прокрутка ленты: в jsdom нет раскладки — scrollLeft задаём сами (шаг ленты 56 px). */
function scrollStrip(left: number) {
  Object.defineProperty(strip(), "scrollLeft", { configurable: true, writable: true, value: left });
  fireEvent.scroll(strip());
}

describe("RadiusSlider «Лінійка-барабан»", () => {
  it("9 значений на ленте, выбранное помечено и в рамке; лента скрыта от читалок", () => {
    const { view } = setup();
    render(view(2000));
    expect(items()).toHaveLength(9);
    expect(items().map((i) => i.textContent)).toEqual([
      "300 м",
      "500 м",
      "1 км",
      "2 км",
      "3 км",
      "5 км",
      "10 км",
      "15 км",
      "20 км",
    ]);
    expect(document.querySelectorAll(".kosiv-rd-item[data-on]")).toHaveLength(1);
    expect(screen.getByTestId("radius-slider-value").textContent).toBe("2 км");
    expect(strip().getAttribute("aria-hidden")).toBe("true");
    const slider = screen.getByRole("slider", { name: "Радіус пошуку" });
    expect(slider.getAttribute("aria-valuetext")).toBe("2 км");
    expect(slider.getAttribute("max")).toBe("8");
  });

  it("allowAll: 10-е значение «Усі місця», в valuetext", () => {
    const { view } = setup();
    render(view(null, true));
    expect(document.querySelectorAll(".kosiv-rd-item[data-all]")).toHaveLength(1);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("Усі місця");
    expect(screen.getByTestId("radius-slider-value").textContent).toBe("Усі місця");
  });

  it("клавиатура (нативный ползунок) — onChange и щелчок хаптики", () => {
    const { view, onChange, haptic } = setup();
    render(view(1000));
    fireEvent.change(screen.getByRole("slider"), { target: { value: "5" } });
    expect(onChange).toHaveBeenCalledWith(5000);
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("radius-slider-value").textContent).toBe("5 км");
  });

  it("нажатие на значение выбирает его и доводит ленту", () => {
    const { view, onChange, haptic } = setup();
    render(view(1000, true));
    fireEvent.click(items()[9]!);
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(strip().scrollLeft).toBe(9 * 56);
    // Нажатие на уже выбранное — без повторного onChange.
    fireEvent.click(items()[9]!);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("свайп: рамка и хаптика на каждом шаге сразу, onChange — один раз, когда лента остановилась", () => {
    vi.useFakeTimers();
    const { view, onChange, haptic } = setup();
    render(view(1000));
    expect(strip().scrollLeft).toBe(2 * 56);
    fireEvent.touchStart(strip());
    scrollStrip(3 * 56 + 10);
    scrollStrip(4 * 56 - 20);
    expect(screen.getByTestId("radius-slider-value").textContent).toBe("3 км");
    expect(haptic).toHaveBeenCalledTimes(2);
    // Палец ещё на ленте — значение не отдаём.
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.touchEnd(strip());
    scrollStrip(4 * 56);
    act(() => vi.advanceTimersByTime(119));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(3000);
  });

  it("значение снаружи — лента переезжает к нему без onChange и хаптики", () => {
    vi.useFakeTimers();
    const { view, onChange, haptic } = setup();
    const { rerender } = render(view(1000));
    rerender(view(10_000));
    expect(strip().scrollLeft).toBe(6 * 56);
    expect(screen.getByTestId("radius-slider-value").textContent).toBe("10 км");
    fireEvent.scroll(strip());
    act(() => vi.advanceTimersByTime(200));
    expect(onChange).not.toHaveBeenCalled();
    expect(haptic).not.toHaveBeenCalled();
  });

  it("disabled: ползунок отключён, нажатие на значение ничего не выбирает", () => {
    const { view, onChange } = setup();
    render(view(1000, false, true));
    expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(items()[4]!);
    expect(onChange).not.toHaveBeenCalled();
  });
});
