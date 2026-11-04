// Unit: useScreenState и useAsync с memo — значения и данные живут за записью истории и возвращаются при «Назад».
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MEMO_TTL_MS } from "./back.js";
import { noopAnalytics } from "./guide/analytics.js";
import { GuideProvider, noopGuideApi, useAsync } from "./guide/context.js";
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

describe("useAsync с memo: срок жизни и регион", () => {
  function List({ load }: { load: () => Promise<string> }) {
    const [state] = useAsync(load, ["q"], { slot: "list", key: "q" });
    return <p data-testid="s">{state.status === "ready" ? state.data : state.status}</p>;
  }
  const inRegion = (regionId: string, load: () => Promise<string>) => (
    <GuideProvider
      value={{ api: noopGuideApi(), analytics: noopAnalytics, base: null, regionId, signedIn: false }}
    >
      <List load={load} />
    </GuideProvider>
  );
  const away = async (unmount: () => void) => {
    await navigate(() => (window.location.hash = "#/b"));
    unmount();
    await navigate(() => window.history.back());
  };

  it("старше срока: показывается сразу, обновляется в фоне без состояния загрузки", async () => {
    let answer: (v: string) => void = () => undefined;
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("старе")
      .mockImplementationOnce(() => new Promise((r) => (answer = r)));
    window.history.replaceState(null, "", "#/a");
    const first = render(inRegion("r", load));
    await screen.findByText("старе");
    await away(first.unmount);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + MEMO_TTL_MS + 1);
    render(inRegion("r", load));
    expect(screen.getByTestId("s").textContent).toBe("старе");
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("s").textContent).toBe("старе");
    await act(async () => answer("нове"));
    expect(screen.getByTestId("s").textContent).toBe("нове");
  });

  it("фоновое обновление не удалось — остаётся показанный список", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("старе")
      .mockRejectedValueOnce(new Error("offline"));
    window.history.replaceState(null, "", "#/a");
    const first = render(inRegion("r", load));
    await screen.findByText("старе");
    await away(first.unmount);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + MEMO_TTL_MS + 1);
    render(inRegion("r", load));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(screen.getByTestId("s").textContent).toBe("старе");
  });

  it("другой регион — данные прежнего не показываются, запрос заново", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("регіон 1")
      .mockResolvedValue("регіон 2");
    window.history.replaceState(null, "", "#/a");
    const first = render(inRegion("r1", load));
    await screen.findByText("регіон 1");
    await away(first.unmount);
    render(inRegion("r2", load));
    expect(screen.getByTestId("s").textContent).toBe("loading");
    await screen.findByText("регіон 2");
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

  it("шаг убрал элемент с фокусом — фокус на заголовке, а не в body", async () => {
    function Form() {
      const [open, setOpen] = useState(true);
      useBackStep(open, () => setOpen(false));
      return (
        <main>
          <h1>Екран</h1>
          {open && <button autoFocus>Поле</button>}
        </main>
      );
    }
    render(<Form />);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    act(() => {
      consumeBack();
    });
    await vi.waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  });
});
