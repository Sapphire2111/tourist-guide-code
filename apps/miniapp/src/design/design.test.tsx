import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Analytics } from "../guide/analytics.js";
import { Catalog } from "../guide/Catalog.js";
import { GuideProvider, type GuideEnv } from "../guide/context.js";
import type { GuideApi } from "../guide/types.js";
import type { TelegramWebApp } from "../telegram.js";
import { AppTop, SeasonSwitcher } from "./Chrome.js";
import { ResortPlaces, SeasonTags } from "./HomeParts.js";
import { ResortProvider } from "./ResortProvider.js";
import { RESORTS } from "./resorts.js";
import {
  readSeason,
  saveSeason,
  seasonOfMonth,
  SEASON_STORAGE_KEY,
  SEASONS,
  WINDOW_COLORS,
} from "./season.js";
import { SeasonProvider } from "./SeasonProvider.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("data-season");
  window.location.hash = "";
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const NOV = new Date(2026, 10, 2);

describe("сезон", () => {
  it("по месяцу: 11,0,1 — зима; 2–4 — весна; 5–7 — лето; 8–10 — осень", () => {
    const got = Array.from({ length: 12 }, (_, m) => seasonOfMonth(m));
    expect(got).toEqual([
      "winter",
      "winter",
      "spring",
      "spring",
      "spring",
      "summer",
      "summer",
      "summer",
      "autumn",
      "autumn",
      "autumn",
      "winter",
    ]);
  });

  it("ручной выбор действует, пока не сменился настоящий сезон; выбор текущего — сброс", () => {
    expect(readSeason(NOV)).toBe("autumn");
    saveSeason("winter", NOV);
    expect(readSeason(NOV)).toBe("winter");
    // Наступила зима по календарю — сохранённый «осенний» выбор больше не действует.
    expect(readSeason(new Date(2026, 11, 1))).toBe("winter");
    saveSeason("spring", NOV);
    expect(readSeason(new Date(2027, 0, 5))).toBe("winter");
    saveSeason("autumn", NOV);
    expect(localStorage.getItem(SEASON_STORAGE_KEY)).toBeNull();
    localStorage.setItem(SEASON_STORAGE_KEY, "{битый");
    expect(readSeason(NOV)).toBe("autumn");
  });

  // Пути — от каталога пакета (vitest запускается в apps/miniapp).
  it("палитра окна совпадает с токенами index.html и season-boot.js", () => {
    const html = readFileSync(path.resolve("index.html"), "utf8").toLowerCase();
    const boot = readFileSync(path.resolve("public/season-boot.js"), "utf8").toLowerCase();
    for (const s of SEASONS) {
      const block = html.split(s === "summer" ? '[data-season="summer"] {' : `[data-season="${s}"] {`)[1]!;
      const vars = block.slice(0, block.indexOf("}"));
      expect(vars).toContain(`--app-bg: ${WINDOW_COLORS[s].bg.toLowerCase()};`);
      expect(vars).toContain(`--app-surface: ${WINDOW_COLORS[s].surface.toLowerCase()};`);
      expect(boot).toContain(
        `${s}: ["${WINDOW_COLORS[s].bg.toLowerCase()}", "${WINDOW_COLORS[s].surface.toLowerCase()}"]`,
      );
    }
  });

  it("переключатель: data-season, цвета окна Telegram и сохранение выбора", () => {
    const webApp = {
      ready: vi.fn(),
      expand: vi.fn(),
      isVersionAtLeast: () => true,
      setHeaderColor: vi.fn(),
      setBackgroundColor: vi.fn(),
      setBottomBarColor: vi.fn(),
    } satisfies TelegramWebApp;
    document.documentElement.setAttribute("data-season", "autumn");
    render(
      <SeasonProvider webApp={webApp}>
        <SeasonSwitcher />
      </SeasonProvider>,
    );
    expect(webApp.setHeaderColor).toHaveBeenLastCalledWith(WINDOW_COLORS.autumn.surface);
    expect(screen.getByRole("button", { name: "Осінь" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Зима" }));
    expect(document.documentElement.getAttribute("data-season")).toBe("winter");
    expect(webApp.setBackgroundColor).toHaveBeenLastCalledWith(WINDOW_COLORS.winter.bg);
    expect(webApp.setBottomBarColor).toHaveBeenLastCalledWith(WINDOW_COLORS.winter.surface);
    expect(JSON.parse(localStorage.getItem(SEASON_STORAGE_KEY)!).season).toBe("winter");
  });

  it("старый клиент Telegram (до 6.1) — цвета окна не трогаем", () => {
    const webApp = {
      ready: vi.fn(),
      expand: vi.fn(),
      isVersionAtLeast: () => false,
      setHeaderColor: vi.fn(),
    } satisfies TelegramWebApp;
    render(<SeasonProvider webApp={webApp} />);
    expect(webApp.setHeaderColor).not.toHaveBeenCalled();
  });
});

function env(search: GuideApi["search"]): GuideEnv {
  const fail = () => Promise.reject(new Error("x"));
  return {
    api: {
      categories: vi.fn(async () => [
        { id: "eat", parentId: null, name: { uk: "Де поїсти" }, homeSection: "eat" as const },
      ]),
      search,
      place: fail,
      favorites: fail,
      addFavorite: fail,
      removeFavorite: fail,
      emergencyContacts: fail,
    },
    analytics: { track: vi.fn(), flush: vi.fn(async () => undefined), dispose: vi.fn() } as Analytics,
    base: { name: "Тестовий готель", point: { lat: 48.4, lng: 24.5 } },
    regionId: "region",
    signedIn: true,
  };
}

const place = {
  id: "p1",
  name: { uk: "Колиба «Ватра»" },
  categoryId: "eat",
  address: { uk: "Яремче, вул. Свободи, 1" },
  location: { lat: 48.45, lng: 24.55 },
  distanceMeters: 300,
  cover: null,
  openNow: true,
  recommended: false,
  adLabel: null,
};

describe("свайпер курортов", () => {
  it("главная: выбор курорта — поиск в радиусе от его центра; «Усе Прикарпаття» — весь регион", async () => {
    const search = vi.fn(async () => [place]);
    render(
      <GuideProvider value={env(search)}>
        <ResortProvider>
          <AppTop path="/" profile={false} />
          <ResortPlaces />
        </ResortProvider>
      </GuideProvider>,
    );
    await flush();
    expect(search).toHaveBeenLastCalledWith({});
    expect(screen.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeDefined();
    expect(screen.getByTestId("home-place").textContent).toContain("Яремче, вул. Свободи, 1");
    const yaremche = RESORTS.find((r) => r.id === "yaremche")!;
    fireEvent.click(screen.getByRole("button", { name: /Яремче/ }));
    await flush();
    expect(search).toHaveBeenLastCalledWith({ point: yaremche.area!.center, radius: yaremche.area!.radius });
    expect(screen.getByText("Поблизу: Яремче (до 4,5 км від центру)")).toBeDefined();
    expect(localStorage.getItem("tg.resort")).toBe("yaremche");
  });

  it("каталог: курорт из сохранённого выбора — места в его радиусе вместо базовой точки QR", async () => {
    localStorage.setItem("tg.resort", "bukovel");
    const search = vi.fn(async () => [place]);
    render(
      <GuideProvider value={env(search)}>
        <ResortProvider>
          <Catalog section="eat" />
        </ResortProvider>
      </GuideProvider>,
    );
    await flush();
    await flush();
    const bukovel = RESORTS.find((r) => r.id === "bukovel")!;
    expect(search).toHaveBeenLastCalledWith({
      categoryId: "eat",
      q: undefined,
      point: bukovel.area!.center,
      radius: bukovel.area!.radius,
    });
    expect(screen.getByTestId("resort-caption").textContent).toBe("Поблизу: Буковель (до 5 км від центру)");
  });

  it("шапка вне главной — ссылка на главную, без свайпера на экранах без фильтра", () => {
    render(<AppTop path="/help" profile />);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("link", { name: "Гід туриста — на головну" }).getAttribute("href")).toBe("#/");
    expect(screen.getByRole("link", { name: "Профіль" }).getAttribute("href")).toBe("#/profile");
    expect(screen.queryByTestId("resort-swiper")).toBeNull();
  });
});

describe("быстрый поиск сезона", () => {
  it("чипы ведут в поиск мест с коротким запросом", () => {
    document.documentElement.setAttribute("data-season", "winter");
    render(
      <SeasonProvider>
        <SeasonTags />
      </SeasonProvider>,
    );
    const link = screen.getByRole("link", { name: "Чани на дровах" });
    expect(link.getAttribute("href")).toBe(`#/search?q=${encodeURIComponent("чан")}`);
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });
});
