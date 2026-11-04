import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { applyThemeParams, Button, Link, pathFromHash, THEME_CSS, useRoute } from "./index.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

describe("Button", () => {
  it("неактивная — нативный disabled и заметно бледнее", () => {
    render(<Button disabled>x</Button>);
    const b = screen.getByRole("button", { name: "x" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.style.opacity).toBe("0.45");
  });
});

describe("pathFromHash", () => {
  it.each([
    ["", "/"],
    ["#/", "/"],
    ["#/partner", "/partner"],
    ["#/partner?x=1", "/partner"],
    ["#tgWebAppData=abc&tgWebAppVersion=8.0", "/"],
  ])("%s → %s", (hash, path) => {
    expect(pathFromHash(hash)).toBe(path);
  });
});

function Probe() {
  const [path, navigate] = useRoute();
  return (
    <>
      <p data-testid="path">{path}</p>
      <Button onClick={() => navigate("/b")}>go</Button>
      <Link to="/a">a</Link>
    </>
  );
}

describe("useRoute", () => {
  it("следит за hash и переходит по navigate", async () => {
    render(<Probe />);
    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(screen.getByRole("link", { name: "a" }).getAttribute("href")).toBe("#/a");
    await act(async () => {
      screen.getByRole("button", { name: "go" }).click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("path").textContent).toBe("/b");
  });

  it("replace: без новой записи истории, state записи сохраняется, экран узнаёт о переходе", async () => {
    function Replace() {
      const [path, navigate] = useRoute();
      return <Button onClick={() => navigate("/r", { replace: true })}>{path}</Button>;
    }
    window.history.replaceState({ mark: 1 }, "");
    const length = window.history.length;
    render(<Replace />);
    await act(async () => {
      screen.getByRole("button").click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("button").textContent).toBe("/r");
    expect(window.location.hash).toBe("#/r");
    expect(window.history.length).toBe(length);
    expect(window.history.state).toEqual({ mark: 1 });
  });
});

describe("тема", () => {
  it("токены ссылаются на переменные Telegram с запасным значением", () => {
    expect(THEME_CSS).toContain("--color-bg: var(--tg-theme-bg-color, #ffffff);");
    expect(THEME_CSS).toContain("--color-button-text: var(--tg-theme-button-text-color, #ffffff);");
  });

  it("applyThemeParams пишет --tg-theme-* и пропускает пустые", () => {
    const el = document.createElement("div");
    applyThemeParams({ bg_color: "#000000", secondary_bg_color: "#111111", text_color: undefined }, el);
    expect(el.style.getPropertyValue("--tg-theme-bg-color")).toBe("#000000");
    expect(el.style.getPropertyValue("--tg-theme-secondary-bg-color")).toBe("#111111");
    expect(el.style.getPropertyValue("--tg-theme-text-color")).toBe("");
  });
});
