// Верхняя полоса (QR/112/помощь в меню) и «живые» огонёк и волны микрофона.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AssistantBox } from "../assistant/AssistantBox.js";
import type { AssistantApi } from "../assistant/assistant-api.js";
import { AppTop, type ScanControl } from "./Chrome.js";
import { BottomNav } from "../guide/BottomNav.js";
import { SeasonProvider } from "./SeasonProvider.js";
import { ThemeProvider } from "./ThemeProvider.js";

let recorderState: "idle" | "starting" | "recording" = "idle";
vi.mock("../assistant/recorder.js", () => ({
  useRecorder: () => ({ supported: true, state: recorderState, start: vi.fn(), stop: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  recorderState = "idle";
});

const scan: ScanControl = { start: vi.fn(), message: null };
const top = (path: string, withScan: boolean) =>
  render(
    <SeasonProvider>
      <AppTop path={path} profile={false} {...(withScan ? { scan } : {})} />
    </SeasonProvider>,
  );

describe("верхняя полоса: QR и 112", () => {
  it("главная: обе кнопки", () => {
    top("/", true);
    expect(screen.getByTestId("scan-btn")).toBeDefined();
    expect(screen.getByTestId("help-112")).toBeDefined();
  });

  it("вложенный экран: вместо 112 — QR; помощь — пункт меню", () => {
    top("/favorites", true);
    expect(screen.getByTestId("scan-btn")).toBeDefined();
    expect(screen.queryByTestId("help-112")).toBeNull();
    fireEvent.click(screen.getByTestId("menu-btn"));
    expect(screen.getByTestId("help-menu-item").getAttribute("href")).toBe("#/help");
    expect(screen.getByTestId("help-menu-item").textContent).toContain("Допомога");
  });

  it("вне Telegram (сканера нет): на вложенном экране ни QR, ни 112", () => {
    top("/favorites", false);
    expect(screen.queryByTestId("scan-btn")).toBeNull();
    expect(screen.queryByTestId("help-112")).toBeNull();
  });
});

const api = {} as AssistantApi;
const css = readFileSync(path.resolve(__dirname, "modern.css"), "utf8");

describe("живой огонёк и волны", () => {
  it("огонёк в кнопке меню — анимированный, декоративный", () => {
    top("/", false);
    const flame = screen.getByTestId("menu-btn").querySelector(".fire-flame");
    expect(flame?.getAttribute("aria-hidden")).toBe("true");
  });

  it("волны есть только в состоянии «микрофон»; декор, без касаний", () => {
    const view = render(<AssistantBox api={api} onSubmit={vi.fn()} />);
    const mic = screen.getByTestId("assistant-mic");
    const waves = mic.querySelector(".mic-waves");
    expect(waves?.getAttribute("aria-hidden")).toBe("true");
    expect(waves?.querySelectorAll("i")).toHaveLength(3);
    expect(mic.querySelector(".fire-flame")).not.toBeNull();
    // Есть текст — кнопка «надіслати», волн нет.
    fireEvent.change(screen.getByLabelText("Що шукаєте?"), { target: { value: "кава" } });
    expect(screen.queryByTestId("assistant-mic")).toBeNull();
    expect(view.container.querySelector(".mic-waves")).toBeNull();
  });

  it("стили: transform/opacity, pointer-events: none, пауза и reduced-motion без анимации", () => {
    expect(css).toMatch(/\.mic-waves \{[^}]*pointer-events: none/);
    const reduce = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce) {\n  .fire-flame"));
    expect(reduce).toMatch(/\.fire-flame,\s*\.mic-waves i \{\s*animation: none/);
    expect(css).toMatch(/html\[data-tab-hidden\] \.fire-flame/);
    expect(css).toMatch(/body:has\([^)]*\) \.mic-waves i/);
    const frames = /@keyframes (?:fire-flicker|mic-wave) \{[\s\S]*?\n\}/g;
    for (const f of css.match(frames) ?? []) expect(f).not.toMatch(/\b(top|left|width|height|margin):/);
  });
});

describe("символ темы", () => {
  const withTheme = (theme: "day" | "night") => {
    document.documentElement.setAttribute("data-theme", theme);
    return render(
      <ThemeProvider>
        <SeasonProvider>
          <AppTop path="/" profile={false} />
          <AssistantBox api={api} onSubmit={vi.fn()} />
          <BottomNav />
        </SeasonProvider>
      </ThemeProvider>,
    );
  };
  afterEach(() => document.documentElement.removeAttribute("data-theme"));

  it("«День»: горы в шапке, поле ассистента и вкладке «Головна»; огня нет", () => {
    withTheme("day");
    expect(screen.getByTestId("menu-btn").textContent).toBe("⛰️");
    expect(screen.getByTestId("assistant-mic").textContent).toContain("⛰️");
    expect(screen.getByTestId("bottom-nav").textContent).toContain("⛰️");
    expect(document.body.textContent).not.toContain("🔥");
  });

  it("«Ніч»: огонь в тех же местах", () => {
    withTheme("night");
    expect(screen.getByTestId("menu-btn").textContent).toBe("🔥");
    expect(screen.getByTestId("assistant-mic").textContent).toContain("🔥");
    expect(screen.getByTestId("bottom-nav").textContent).toContain("🔥");
  });
});
