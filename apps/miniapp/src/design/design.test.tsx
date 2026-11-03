import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Analytics } from "../guide/analytics.js";
import { Catalog } from "../guide/Catalog.js";
import { GuideProvider, type GuideEnv } from "../guide/context.js";
import type { GuideApi, PlaceSummary, SearchParams } from "../guide/types.js";
import { consumeBack, type TelegramWebApp } from "../telegram.js";
import { AppTop, SeasonSwitcher, Splash } from "./Chrome.js";
import { LocationChip, LocationSheetHost } from "../guide/LocationPicker.js";
import {
  GPS_RADIUS,
  GPS_RADIUS_WIDE,
  LOCATION_STORAGE_KEY,
  LocationProvider,
  useLocations,
} from "../guide/LocationProvider.js";
import { HOME_PLACES, HomePlaces, SeasonTags } from "./HomeParts.js";
import { PlaceSearch } from "../guide/Catalog.js";
import {
  readSeason,
  saveSeason,
  seasonOfMonth,
  SEASON_STORAGE_KEY,
  SEASONS,
  WINDOW_COLORS,
} from "./season.js";
import { SeasonProvider, syncTelegramColors } from "./SeasonProvider.js";

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

  it("заставка: долгий вход (холодный старт api) — пояснение «сервер прокидається»", async () => {
    render(
      <SeasonProvider>
        <Splash slowAfterMs={5} />
      </SeasonProvider>,
    );
    expect(screen.queryByTestId("splash-slow")).toBeNull();
    expect(await screen.findByTestId("splash-slow")).toBeTruthy();
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

const YAREMCHE = "00000000-0000-4000-8000-0000000000d1";
const TATARIV = "00000000-0000-4000-8000-0000000000d2";
const EMPTY_LOC = "00000000-0000-4000-8000-0000000000d3";
const LOCALITIES = [
  { id: YAREMCHE, name: { uk: "Яремче" }, placeCount: 5, location: { lat: 48.45, lng: 24.55 } },
  { id: TATARIV, name: { uk: "Татарів" }, placeCount: 2, location: { lat: 48.3, lng: 24.4 } },
  { id: EMPTY_LOC, name: { uk: "Ворохта" }, placeCount: 0 },
];

function env(
  search: GuideApi["search"],
  localities: GuideApi["localities"] = vi.fn(async () => LOCALITIES),
): GuideEnv {
  const fail = () => Promise.reject(new Error("x"));
  return {
    api: {
      categories: vi.fn(async () => [
        { id: "eat", parentId: null, name: { uk: "Де поїсти" }, homeSection: "eat" as const },
      ]),
      localities,
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

describe("локації", () => {
  it("главная: весь регион; кнопка «Локація» — мультивыбор, лента только по выбранным, выбор запоминается", async () => {
    const search = vi.fn(async () => [place]);
    render(
      <GuideProvider value={env(search)}>
        <LocationProvider>
          <AppTop path="/" profile={false} />
          <LocationChip />
          <LocationSheetHost />
          <HomePlaces />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    expect(search).toHaveBeenLastCalledWith({ excludeSections: ["stay"], limit: HOME_PLACES });
    expect(screen.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeDefined();
    const chip = screen.getByTestId("location-chip");
    expect(chip.textContent).toContain("Усі локації");
    fireEvent.click(chip);
    const sheet = screen.getByRole("dialog", { name: "Локація" });
    // Пункт без мест не предлагается.
    expect(sheet.textContent).not.toContain("Ворохта");
    const shown = screen.getByTestId("home-places");
    fireEvent.click(screen.getByRole("checkbox", { name: "Татарів" }));
    // Пока идёт запрос, прежняя лента на месте.
    expect(screen.getByTestId("home-places")).toBe(shown);
    await flush();
    expect(search).toHaveBeenLastCalledWith({
      localityIds: [TATARIV],
      excludeSections: ["stay"],
      limit: HOME_PLACES,
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Яремче" }));
    await flush();
    expect(search).toHaveBeenLastCalledWith({
      localityIds: [TATARIV, YAREMCHE],
      excludeSections: ["stay"],
      limit: HOME_PLACES,
    });
    expect((screen.getByRole("checkbox", { name: "Усі локації" }) as HTMLInputElement).checked).toBe(false);
    expect(JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY)!)).toEqual({
      regionId: "region",
      ids: [TATARIV, YAREMCHE],
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip.textContent).toContain("Яремче +1");
    expect(screen.getByTestId("location-caption").textContent).toBe("Локація: Яремче, Татарів");
    // «Усі локації» — без фильтра, хранилище очищено.
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("checkbox", { name: "Усі локації" }));
    await flush();
    expect(search).toHaveBeenLastCalledWith({ excludeSections: ["stay"], limit: HOME_PLACES });
    // Явное «Усі локації» запоминается (GPS по умолчанию не включается), пунктов в хранилище нет.
    expect(JSON.parse(localStorage.getItem(LOCATION_STORAGE_KEY)!)).toEqual({
      regionId: "region",
      ids: [],
      mode: "all",
    });
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("каталог: сохранённый выбор — места пунктов вместо радиуса от точки QR; чужой регион не фильтрует", async () => {
    localStorage.setItem(
      LOCATION_STORAGE_KEY,
      JSON.stringify({ regionId: "region", ids: [YAREMCHE, "gone"] }),
    );
    const search = vi.fn(async () => [place]);
    render(
      <GuideProvider value={env(search)}>
        <LocationProvider>
          <Catalog section="eat" />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    await flush();
    // Исчезнувший пункт отброшен.
    expect(search).toHaveBeenLastCalledWith({
      categoryId: "eat",
      q: undefined,
      point: { lat: 48.4, lng: 24.5 },
      localityIds: [YAREMCHE],
    });
    expect(screen.getByTestId("location-caption").textContent).toBe("Локація: Яремче");
    cleanup();
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: "other", ids: [YAREMCHE] }));
    const again = vi.fn(async () => [place]);
    render(
      <GuideProvider value={env(again)}>
        <LocationProvider>
          <Catalog section="eat" />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(again).toHaveBeenLastCalledWith({
      categoryId: "eat",
      q: undefined,
      point: { lat: 48.4, lng: 24.5 },
    });
    expect(screen.queryByTestId("location-caption")).toBeNull();
  });

  it("лист: фокус остаётся на отмеченном пункте, по закрытию — на кнопке; «Назад» Telegram закрывает", async () => {
    render(
      <GuideProvider value={env(vi.fn(async () => [place]))}>
        <LocationProvider>
          <LocationChip />
          <LocationSheetHost />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    const chip = screen.getByTestId("location-chip");
    chip.focus();
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Локація" });
    expect(dialog.getAttribute("aria-describedby")).toBe("loc-sheet-hint");
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Усі локації" }));
    const yaremche = screen.getByRole("checkbox", { name: "Яремче" });
    yaremche.focus();
    fireEvent.click(yaremche);
    await flush();
    expect(document.activeElement).toBe(yaremche);
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);
    fireEvent.click(chip);
    expect(screen.getByRole("dialog")).toBeDefined();
    act(() => {
      expect(consumeBack()).toBe(true);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(consumeBack()).toBe(false);
  });

  it("пунктов меньше двух — сохранённый выбор не применяется; старый ключ курортов убран", async () => {
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: "region", ids: [YAREMCHE] }));
    localStorage.setItem("tg.resort", "tatariv");
    const search = vi.fn(async () => [place]);
    render(
      <GuideProvider
        value={env(
          search,
          vi.fn(async () => LOCALITIES.slice(0, 1)),
        )}
      >
        <LocationProvider>
          <HomePlaces />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(search).toHaveBeenLastCalledWith({ excludeSections: ["stay"], limit: HOME_PLACES });
    expect(localStorage.getItem("tg.resort")).toBeNull();
  });

  it("список пунктов недоступен или пунктов меньше двух — кнопки нет, выдача без фильтра", async () => {
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: "region", ids: [YAREMCHE] }));
    const search = vi.fn(async () => [place]);
    render(
      <GuideProvider
        value={env(
          search,
          vi.fn(async () => Promise.reject(new Error("down"))),
        )}
      >
        <LocationProvider>
          <LocationChip />
          <LocationSheetHost />
          <HomePlaces />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(screen.queryByTestId("location-chip")).toBeNull();
    expect(search).toHaveBeenLastCalledWith({ excludeSections: ["stay"], limit: HOME_PLACES });
    cleanup();
    render(
      <GuideProvider
        value={env(
          search,
          vi.fn(async () => LOCALITIES.slice(0, 1)),
        )}
      >
        <LocationProvider>
          <LocationChip />
          <LocationSheetHost />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    expect(screen.queryByTestId("location-chip")).toBeNull();
  });
});

describe("шапка", () => {
  it("главная: без свайпера курортов; сезон и профиль — в листе под кнопкой «Меню»", () => {
    const view = render(
      <SeasonProvider>
        <AppTop path="/" profile />
      </SeasonProvider>,
    );
    expect(screen.queryByTestId("resort-swiper")).toBeNull();
    expect(screen.queryByTestId("app-settings")).toBeNull();
    const menu = screen.getByRole("button", { name: "Меню" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "Меню" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("link", { name: "Профіль" }).getAttribute("href")).toBe("#/profile");
    // Фокус внутри листа; Escape закрывает и возвращает фокус на кнопку.
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("app-settings")).toBeNull();
    expect(document.activeElement).toBe(menu);
    // Тап вне листа закрывает.
    fireEvent.click(menu);
    fireEvent.click(screen.getByTestId("menu-backdrop"));
    expect(screen.queryByTestId("app-settings")).toBeNull();
    // Тап внутри листа — не закрывает; кнопка «Закрити» закрывает.
    fireEvent.click(menu);
    fireEvent.click(screen.getByTestId("app-settings"));
    expect(screen.getByTestId("app-settings")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Закрити" }));
    expect(screen.queryByTestId("app-settings")).toBeNull();
    // Выбор сезона применяется и закрывает лист.
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole("button", { name: /Весна/ }));
    expect(document.documentElement.dataset.season).toBe("spring");
    expect(screen.queryByTestId("app-settings")).toBeNull();
    // Переход на другой экран закрывает лист.
    fireEvent.click(menu);
    view.rerender(
      <SeasonProvider>
        <AppTop path="/help" profile />
      </SeasonProvider>,
    );
    expect(screen.queryByTestId("app-settings")).toBeNull();
  });

  it("лист меню: фон не прокручивается, «Назад» Telegram закрывает лист", () => {
    render(
      <SeasonProvider>
        <AppTop path="/" profile />
      </SeasonProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Меню" }));
    expect(document.body.style.overflow).toBe("hidden");
    act(() => {
      expect(consumeBack()).toBe(true);
    });
    expect(screen.queryByTestId("app-settings")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(consumeBack()).toBe(false);
  });

  it("Tab в листе не выходит за его пределы", () => {
    render(
      <SeasonProvider>
        <AppTop path="/" profile />
      </SeasonProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Меню" }));
    const link = screen.getByRole("link", { name: "Профіль" });
    link.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Закрити" }));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(link);
  });

  it("вне главной: нет h1 и только «Допомога» в самой полосе; профиль — только в меню и только при profile", () => {
    const view = render(<AppTop path="/help" profile={false} />);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    // В полосе только постоянная кнопка «Допомога» (modern).
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["#/help"]);
    fireEvent.click(screen.getByRole("button", { name: "Меню" }));
    expect(screen.queryByRole("link", { name: "Профіль" })).toBeNull();
    view.unmount();
    render(<AppTop path="/help" profile />);
    fireEvent.click(screen.getByRole("button", { name: "Меню" }));
    expect(screen.getByRole("link", { name: "Профіль" }).getAttribute("href")).toBe("#/profile");
    expect(screen.queryByTestId("resort-swiper")).toBeNull();
  });
});

function stubGeolocation(result: { lat: number; lng: number } | null, granted = true) {
  vi.stubGlobal("navigator", {
    ...navigator,
    permissions: { query: async () => ({ state: granted ? "granted" : "prompt" }) },
    geolocation: {
      getCurrentPosition: (ok: (p: unknown) => void, fail: () => void) =>
        result ? ok({ coords: { latitude: result.lat, longitude: result.lng, accuracy: 20 } }) : fail(),
    },
  });
}

describe("локація: моє місцезнаходження", () => {
  afterEach(() => vi.unstubAllGlobals());
  const mount = (search: (params: SearchParams) => Promise<PlaceSummary[]>) =>
    render(
      <GuideProvider value={env(search)}>
        <LocationProvider>
          <LocationChip />
          <LocationSheetHost />
          <HomePlaces />
        </LocationProvider>
      </GuideProvider>,
    );

  it("по умолчанию (ничего не выбрано, точка доступна) — поиск вокруг точки; выбор пункта снимает режим и наоборот", async () => {
    stubGeolocation({ lat: 48.45, lng: 24.55 });
    const search = vi.fn(async (_params: SearchParams) => [place]);
    mount(search);
    await flush();
    await flush();
    // Найдено меньше 5 мест — радиус расширяется.
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ radius: GPS_RADIUS }));
    expect(search).toHaveBeenLastCalledWith({
      point: { lat: 48.45, lng: 24.55, accuracy: 20 },
      radius: GPS_RADIUS_WIDE,
      excludeSections: ["stay"],
      limit: HOME_PLACES,
    });
    expect(screen.getByRole("heading", { name: "Поруч з вами" })).toBeDefined();
    const chip = screen.getByTestId("location-chip");
    expect(chip.textContent).toContain("Моє місцезнаходження");
    expect(screen.getByTestId("location-caption").textContent).toBe("Локація: Моє місцезнаходження");
    fireEvent.click(chip);
    expect((screen.getByRole("checkbox", { name: "Моє місцезнаходження" }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Татарів" }));
    await flush();
    expect(search).toHaveBeenLastCalledWith({
      localityIds: [TATARIV],
      excludeSections: ["stay"],
      limit: HOME_PLACES,
    });
    expect(chip.textContent).toContain("Татарів");
    fireEvent.click(screen.getByRole("checkbox", { name: "Моє місцезнаходження" }));
    await flush();
    await flush();
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ radius: GPS_RADIUS_WIDE }));
    expect(search.mock.calls.at(-1)![0]).not.toHaveProperty("localityIds");
    expect(chip.textContent).toContain("Моє місцезнаходження");
  });

  it("нет точки — по умолчанию «Усі локації» без сообщений; явный выбор при отказе — сообщение и откат", async () => {
    stubGeolocation(null);
    const search = vi.fn(async (_params: SearchParams) => [place]);
    mount(search);
    await flush();
    await flush();
    expect(search).toHaveBeenLastCalledWith({ excludeSections: ["stay"], limit: HOME_PLACES });
    const chip = screen.getByTestId("location-chip");
    expect(chip.textContent).toContain("Усі локації");
    fireEvent.click(chip);
    expect(screen.queryByTestId("location-gps-failed")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Моє місцезнаходження" }));
    await flush();
    await flush();
    expect(screen.getByTestId("location-gps-failed").textContent).toContain("Не вдалося визначити");
    expect((screen.getByRole("checkbox", { name: "Усі локації" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Моє місцезнаходження" }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(chip.textContent).toContain("Усі локації");
  });

  it("доступ не выдан или точка вне региона — авто-режима нет; явный выбор вне региона — сообщение и откат", async () => {
    stubGeolocation({ lat: 48.45, lng: 24.55 }, false);
    const search = vi.fn(async (_params: SearchParams) => [place]);
    mount(search);
    await flush();
    await flush();
    // Без разрешения на старте точка не запрашивается.
    expect(search).toHaveBeenLastCalledWith({ excludeSections: ["stay"], limit: HOME_PLACES });
    cleanup();
    // Турист дома, далеко от региона: авто-режим молчит.
    stubGeolocation({ lat: 50.45, lng: 30.52 });
    const far = vi.fn(async (_params: SearchParams) => [place]);
    mount(far);
    await flush();
    await flush();
    expect(far).toHaveBeenLastCalledWith({ excludeSections: ["stay"], limit: HOME_PLACES });
    expect(screen.queryByTestId("location-gps-failed")).toBeNull();
    fireEvent.click(screen.getByTestId("location-chip"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Моє місцезнаходження" }));
    await flush();
    await flush();
    expect(screen.getByTestId("location-gps-failed").textContent).toContain("Ви поза регіоном");
    expect((screen.getByRole("checkbox", { name: "Усі локації" }) as HTMLInputElement).checked).toBe(true);
    // Не явное «Усі локації»: режим в хранилище не пишется.
    expect(localStorage.getItem(LOCATION_STORAGE_KEY)).toBeNull();
  });

  it("пустая лента в GPS-режиме: подсказка «Змінити локацію» открывает лист", async () => {
    stubGeolocation({ lat: 48.45, lng: 24.55 });
    mount(vi.fn(async (_params: SearchParams) => []));
    await flush();
    await flush();
    fireEvent.click(screen.getByTestId("home-change-location"));
    expect(screen.getByRole("dialog", { name: "Локація" })).toBeDefined();
  });

  it("каталог в GPS-режиме: «Змінити локацію» открывает лист; текстовый поиск без результатов рядом — по региону с пометкой", async () => {
    stubGeolocation({ lat: 48.45, lng: 24.55 });
    const search = vi.fn(async (params: SearchParams) => (params.radius || !params.q ? [] : [place]));
    render(
      <GuideProvider value={env(search)}>
        <LocationProvider>
          <Catalog section="eat" />
          <LocationSheetHost />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    await flush();
    fireEvent.click(await screen.findByTestId("catalog-change-location"));
    expect(screen.getByRole("dialog", { name: "Локація" })).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "смерека" } });
    fireEvent.submit(screen.getByRole("searchbox"));
    await flush();
    await flush();
    expect(screen.getByTestId("catalog-region-wide")).toBeDefined();
    expect(search.mock.calls.at(-1)![0]).not.toHaveProperty("radius");
  });

  it("явное «Усі локації» запоминается: GPS по умолчанию не включается", async () => {
    localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: "region", ids: [], mode: "all" }));
    stubGeolocation({ lat: 48.45, lng: 24.55 });
    const search = vi.fn(async (_params: SearchParams) => [place]);
    mount(search);
    await flush();
    await flush();
    expect(search).toHaveBeenLastCalledWith({ excludeSections: ["stay"], limit: HOME_PLACES });
  });
});

function CurrentLocation() {
  const { selected, setSelected } = useLocations();
  return (
    <button type="button" data-testid="current" onClick={() => setSelected([TATARIV])}>
      {selected.join(",") || "all"}
    </button>
  );
}

describe("локація и контекст входа", () => {
  it("вход по QR заведения не применяет и сбрасывает сохранённый выбор; выбор в этом открытии — действует", async () => {
    const saved = JSON.stringify({ regionId: "region", ids: [YAREMCHE] });
    localStorage.setItem(LOCATION_STORAGE_KEY, saved);
    const e = env(vi.fn(async () => []));
    const { rerender } = render(
      <GuideProvider value={e}>
        <LocationProvider venueEntry={false}>
          <CurrentLocation />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByTestId("current").textContent).toBe(YAREMCHE);
    rerender(
      <GuideProvider value={e}>
        <LocationProvider venueEntry>
          <CurrentLocation />
        </LocationProvider>
      </GuideProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("all");
    expect(localStorage.getItem(LOCATION_STORAGE_KEY)).toBeNull();
    fireEvent.click(screen.getByTestId("current"));
    expect(screen.getByTestId("current").textContent).toBe(TATARIV);
    cleanup();
    // Первый же рендер при входе по QR — весь регион (без запроса по старому выбору).
    localStorage.setItem(LOCATION_STORAGE_KEY, saved);
    render(
      <GuideProvider value={e}>
        <LocationProvider venueEntry>
          <CurrentLocation />
        </LocationProvider>
      </GuideProvider>,
    );
    expect(screen.getByTestId("current").textContent).toBe("all");
  });

  it("хранилище недоступно — выбор действует до закрытия, без ошибки", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(
      <GuideProvider value={env(vi.fn(async () => []))}>
        <LocationProvider>
          <CurrentLocation />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    fireEvent.click(screen.getByTestId("current"));
    expect(screen.getByTestId("current").textContent).toBe(TATARIV);
    set.mockRestore();
    get.mockRestore();
  });
});

describe("цвета окна Telegram по версии", () => {
  // Сравнение версий как в telegram-web-app.js: по числам частей (7.10 > 7.9).
  const atLeast = (have: string) => (want: string) => {
    const h = have.split(".").map(Number);
    const w = want.split(".").map(Number);
    for (let i = 0; i < Math.max(h.length, w.length); i++) {
      if ((h[i] ?? 0) !== (w[i] ?? 0)) return (h[i] ?? 0) > (w[i] ?? 0);
    }
    return true;
  };
  const app = (version: string, over: Partial<TelegramWebApp> = {}) => ({
    ready: vi.fn(),
    expand: vi.fn(),
    isVersionAtLeast: atLeast(version),
    setHeaderColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setBottomBarColor: vi.fn(),
    ...over,
  });

  it("Bot API 6.5: фон — да, шапка цветом #RRGGBB (6.9+) и нижняя панель (7.10+) — нет", () => {
    const webApp = app("6.5");
    syncTelegramColors(webApp, "winter");
    expect(webApp.setBackgroundColor).toHaveBeenCalledWith(WINDOW_COLORS.winter.bg);
    expect(webApp.setHeaderColor).not.toHaveBeenCalled();
    expect(webApp.setBottomBarColor).not.toHaveBeenCalled();
  });

  it("отказ одного вызова не отменяет остальные", () => {
    const webApp = app("8.0", {
      setHeaderColor: vi.fn(() => {
        throw new Error("WebAppHeaderColorKeyInvalid");
      }),
    });
    syncTelegramColors(webApp, "spring");
    expect(webApp.setBackgroundColor).toHaveBeenCalledWith(WINDOW_COLORS.spring.bg);
    expect(webApp.setBottomBarColor).toHaveBeenCalledWith(WINDOW_COLORS.spring.surface);
  });
});

describe("поиск мест /search", () => {
  it("запрос из адреса подставлен в поле и ушёл в поиск без категории", async () => {
    const search = vi.fn(async () => [place]);
    render(
      <GuideProvider value={env(search)}>
        <LocationProvider>
          <PlaceSearch initialQuery="чан" />
        </LocationProvider>
      </GuideProvider>,
    );
    await flush();
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Пошук місць" })).toBeDefined();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("чан");
    expect(search).toHaveBeenLastCalledWith({
      categoryId: undefined,
      q: "чан",
      point: { lat: 48.4, lng: 24.5 },
    });
    expect(screen.getAllByTestId("place-item")).toHaveLength(1);
    expect(screen.queryByRole("group", { name: "Підкатегорії" })).toBeNull();
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
