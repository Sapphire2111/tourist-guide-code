// Unit: useScreenState и useAsync с memo — значения и данные живут за записью истории и возвращаются при «Назад».
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useAsync } from "./guide/context.js";
import { useBackStep, useScreenState } from "./screen-state.js";
import { consumeBack } from "./telegram.js";

function Counter() {
  const [n, setN] = useScreenState("n", 0);
  return <button onClick={() => setN((v) => v + 1)}>n={n}</button>;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "#/");
});

async function navigate(act2: () => void) {
  const popped = new Promise((r) => window.addEventListener("hashchange", r, { once: true }));
  act2();
  await popped;
}

describe("useScreenState", () => {
  it("уход вперёд и возврат — значение то же; новый заход — начальное", async () => {
    window.history.replaceState(null, "", "#/a");
    const first = render(<Counter />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("n=2");
    await navigate(() => (window.location.hash = "#/b"));
    first.unmount();
    await navigate(() => window.history.back());
    const back = render(<Counter />);
    expect(screen.getByRole("button").textContent).toBe("n=2");
    await navigate(() => (window.location.hash = "#/c"));
    back.unmount();
    render(<Counter />);
    expect(screen.getByRole("button").textContent).toBe("n=0");
  });

  it("размонтирование без смены записи — значение забывается (другой экран в той же записи)", () => {
    const first = render(<Counter />);
    fireEvent.click(screen.getByRole("button"));
    first.unmount();
    render(<Counter />);
    expect(screen.getByRole("button").textContent).toBe("n=0");
  });
});

describe("useAsync с memo", () => {
  function List({ load, q = "a" }: { load: () => Promise<string>; q?: string }) {
    const [state] = useAsync(load, [q], { slot: "list", key: q });
    return <p>{state.status === "ready" ? state.data : "…"}</p>;
  }

  it("возврат с теми же параметрами — данные сразу, без запроса; другие параметры — запрос", async () => {
    const load = vi.fn(async () => "дані");
    window.history.replaceState(null, "", "#/a");
    const first = render(<List load={load} />);
    await screen.findByText("дані");
    expect(load).toHaveBeenCalledTimes(1);
    await navigate(() => (window.location.hash = "#/b"));
    first.unmount();
    await navigate(() => window.history.back());
    const again = render(<List load={load} />);
    expect(screen.getByText("дані")).toBeDefined();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(load).toHaveBeenCalledTimes(1);
    again.rerender(<List load={load} q="b" />);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});

describe("useBackStep", () => {
  function Step({ fn, active }: { fn: () => void; active: boolean }) {
    useBackStep(active, fn);
    return null;
  }

  it("активен — «Назад» выполняет шаг; снят — нет", () => {
    const fn = vi.fn();
    const { rerender } = render(<Step fn={fn} active />);
    expect(consumeBack()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    rerender(<Step fn={fn} active={false} />);
    expect(consumeBack()).toBe(false);
  });
});
