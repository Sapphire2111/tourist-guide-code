import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createApiClient, type ApiSchemas } from "@tg/api-client";
import { clientAnalyticsBatchSchema } from "@tg/shared";
import { createAnalytics, uuidv7, type Analytics } from "./analytics.js";
import { GuideProvider, type GuideEnv } from "./context.js";
import { googleRouteUrl } from "./geo.js";
import { createGuideApi } from "./guide-api.js";
import { Catalog, STAY_MAP_MAX } from "./Catalog.js";
import { Help } from "./Help.js";
import { HomeSections } from "./HomeSections.js";
import { Nearby, snapRadius } from "./Nearby.js";
import { PlaceCard } from "./PlaceCard.js";
import {
  NotFoundError,
  type GuideApi,
  type PlaceDetail,
  type PlaceSummary,
  type SearchParams,
} from "./types.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.unstubAllGlobals();
});

const REGION = "00000000-0000-4000-8000-0000000000a1";
const EAT = "00000000-0000-4000-8000-000000000101";
const CAFE = "00000000-0000-4000-8000-000000000102";
const P1 = "00000000-0000-4000-8000-000000000201";

const summary = (over: Partial<PlaceSummary> = {}): PlaceSummary => ({
  id: P1,
  name: { uk: "Кав'ярня «Смерека»" },
  categoryId: CAFE,
  location: { lat: 48.45, lng: 24.56 },
  distanceMeters: 120,
  cover: null,
  openNow: true,
  recommended: true,
  adLabel: null,
  ...over,
});

const detail = (over: Partial<PlaceDetail> = {}): PlaceDetail => ({
  ...summary(),
  description: { uk: "Кава та випічка." },
  address: { uk: "вул. Центральна, 2" },
  phone: "+380501112233",
  website: "https://smereka.example",
  telegram: null,
  photos: [{ url: "https://cdn.example/1.jpg", alt: { uk: "Зал кав'ярні" } }],
  schedule: [{ weekday: 1, opens: "09:00", closes: "21:00" }],
  tags: [{ uk: "Wi-Fi" }],
  verifiedAt: "2026-10-01T00:00:00Z",
  openUntil: "21:00",
  favorite: false,
  ...over,
});

function fakeApi(over: Partial<GuideApi> = {}): GuideApi {
  return {
    categories: vi.fn(async () => [
      { id: EAT, parentId: null, name: { uk: "Де поїсти" }, homeSection: "eat" as const },
      { id: CAFE, parentId: EAT, name: { uk: "Кав'ярні" }, homeSection: null },
    ]),
    localities: vi.fn(async () => []),
    search: vi.fn(async () => [summary(), summary({ id: "p2", recommended: false, adLabel: "advertising" })]),
    place: vi.fn(async () => detail()),
    favorites: vi.fn(async () => []),
    addFavorite: vi.fn(async () => undefined),
    removeFavorite: vi.fn(async () => undefined),
    emergencyContacts: vi.fn(async () => [
      { id: "e1", kind: "police" as const, name: { uk: "Поліція" }, phone: "102", description: null },
    ]),
    ...over,
  };
}

function setup(over: Partial<GuideEnv> = {}) {
  const track = vi.fn();
  const analytics = { track, flush: vi.fn(async () => undefined), dispose: vi.fn() } as Analytics & {
    track: typeof track;
  };
  const env: GuideEnv = {
    api: fakeApi(),
    analytics,
    base: { name: "Тестовий готель", point: { lat: 48.4, lng: 24.5 } },
    regionId: REGION,
    signedIn: true,
    ...over,
  };
  return { env, analytics: env.analytics as typeof analytics };
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe("главная C02", () => {
  it("modern: одна сетка из 8 разделов (помощь — кнопка в полосе) (без «Що поруч») и кнопка «поруч зі мною» над ней; «Про заклад» — только при QR заведения (C-13)", () => {
    const { env } = setup();
    const view = (hasVenue: boolean) => (
      <GuideProvider value={env}>
        <HomeSections hasVenue={hasVenue} />
      </GuideProvider>
    );
    const { rerender } = render(view(true));
    expect(within(screen.getByTestId("home-sections")).getAllByRole("link")).toHaveLength(8);
    const href = (name: string | RegExp) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href("Де поїсти")).toBe("#/section/eat");
    expect(screen.queryByRole("link", { name: "Що поруч" })).toBeNull();
    expect(href(/Що поруч зі мною зараз/)).toBe("#/nearby/me");
    expect(href("Відпочити та зігрітися")).toBe("#/section/relax");
    expect(href("Розваги та враження")).toBe("#/section/fun");
    expect(
      within(screen.getByTestId("home-sections"))
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "#/section/stay",
      "#/section/eat",
      "#/section/relax",
      "#/section/shop",
      "#/section/fun",
      "#/section/ski",
      "#/section/transfer",
      "#/section/services",
    ]);
    expect(href(/Про заклад/)).toBe("#/about");
    rerender(view(false));
    expect(screen.queryByRole("link", { name: /Про заклад/ })).toBeNull();
  });
});

describe("каталог C04", () => {
  it("«Де жити»: карта с догрузкой до STAY_MAP_MAX; смена подкатегории отменяет прежнюю догрузку", async () => {
    const STAY = "00000000-0000-4000-8000-000000000301";
    const HOTELS = "00000000-0000-4000-8000-000000000302";
    const signals: AbortSignal[] = [];
    const search = vi.fn(async (p: SearchParams) => {
      signals.push(p.signal!);
      return [];
    });
    const { env } = setup({
      api: fakeApi({
        categories: vi.fn(async () => [
          { id: STAY, parentId: null, name: { uk: "Де жити" }, homeSection: "stay" as const },
          { id: HOTELS, parentId: STAY, name: { uk: "Готелі" }, homeSection: null },
        ]),
        search,
      }),
    });
    render(
      <GuideProvider value={env}>
        <Catalog section="stay" />
      </GuideProvider>,
    );
    await flush();
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ categoryId: STAY, max: STAY_MAP_MAX, signal: expect.any(AbortSignal) }),
    );
    expect(signals[0]!.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Готелі" }));
    await flush();
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ categoryId: HOTELS, max: STAY_MAP_MAX }),
    );
    expect(signals[0]!.aborted).toBe(true);
    expect(signals.at(-1)!.aborted).toBe(false);
  });

  it("раздел → корневая категория, category_opened; подкатегория; поиск → search_used без текста", async () => {
    const { env, analytics } = setup();
    render(
      <GuideProvider value={env}>
        <Catalog section="eat" />
      </GuideProvider>,
    );
    await flush();
    expect(env.api.search).toHaveBeenCalledWith({ categoryId: EAT, q: undefined, point: env.base!.point });
    expect(analytics.track).toHaveBeenCalledWith("category_opened", { categoryId: EAT });
    expect(screen.getAllByTestId("place-item")).toHaveLength(2);
    // Реклама помечена и не получает «Ми рекомендуємо» автоматически.
    expect(screen.getAllByTestId("badge-ad")).toHaveLength(1);
    expect(screen.getAllByTestId("badge-recommended")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Кав'ярні" }));
    await flush();
    expect(analytics.track).toHaveBeenCalledWith("category_opened", { categoryId: CAFE });

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "смерека" } });
    fireEvent.click(screen.getByRole("button", { name: "Знайти" }));
    await flush();
    expect(env.api.search).toHaveBeenLastCalledWith({
      categoryId: CAFE,
      q: "смерека",
      point: env.base!.point,
    });
    expect(analytics.track).toHaveBeenCalledWith("search_used", { categoryId: CAFE, resultCount: 2 });
    // Смена подкатегории после поиска — новый запрос, но не новое search_used.
    fireEvent.click(screen.getByRole("button", { name: "Усі" }));
    await flush();
    expect(analytics.track.mock.calls.filter(([e]) => e === "search_used")).toHaveLength(1);
  });

  it("раздел без категории — пустое состояние; сбой — повтор", async () => {
    const categories = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue([]);
    const { env } = setup({ api: fakeApi({ categories }) });
    render(
      <GuideProvider value={env}>
        <Catalog section="shop" />
      </GuideProvider>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Спробувати ще раз" }));
    await flush();
    expect(screen.getByTestId("section-empty")).toBeDefined();
  });
});

describe("картка місця C06", () => {
  it("бейджи, «Уточнити доступність», маршрут и звонок с событиями", async () => {
    const { env, analytics } = setup();
    render(
      <GuideProvider value={env}>
        <PlaceCard id={P1} />
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Кав'ярня «Смерека»" })).toBeDefined();
    expect(analytics.track).toHaveBeenCalledWith("place_viewed", { placeId: P1 });
    expect(screen.getByTestId("badge-availability").textContent).toBe("Уточнити доступність");
    expect(screen.getByTestId("badge-open")).toBeDefined();
    expect(screen.getByRole("img", { name: "Зал кав'ярні" })).toBeDefined();
    const call = screen.getByTestId("place-call");
    expect(call.getAttribute("href")).toBe("tel:+380501112233");
    fireEvent.click(call);
    expect(analytics.track).toHaveBeenCalledWith("call_clicked", { placeId: P1 });
    const route = screen.getByTestId("place-route");
    expect(route.getAttribute("href")).toBe(googleRouteUrl({ lat: 48.45, lng: 24.56 }));
    expect(route.getAttribute("href")).toBe("https://www.google.com/maps/dir/?api=1&destination=48.45,24.56");
    fireEvent.click(route);
    expect(analytics.track).toHaveBeenCalledWith("route_clicked", { placeId: P1 });

    fireEvent.click(screen.getByRole("button", { name: "Додати в обране" }));
    await flush();
    expect(env.api.addFavorite).toHaveBeenCalledWith(P1);
    expect(screen.getByRole("button", { name: "Прибрати з обраного" })).toBeDefined();
  });

  it("404 — «Заклад недоступний»", async () => {
    const { env } = setup({ api: fakeApi({ place: () => Promise.reject(new NotFoundError()) }) });
    render(
      <GuideProvider value={env}>
        <PlaceCard id={P1} />
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByTestId("place-not-found")).toBeDefined();
  });
});

describe("«Халепа?» C14", () => {
  it("112 и контакты региона — звонок tel:", async () => {
    const { env } = setup();
    render(
      <GuideProvider value={env}>
        <Help />
      </GuideProvider>,
    );
    expect(screen.getByTestId("call-112").getAttribute("href")).toBe("tel:112");
    await flush();
    expect(screen.getByRole("link", { name: "Подзвонити: Поліція, 102" }).getAttribute("href")).toBe(
      "tel:102",
    );
  });

  it("контакты не загрузились — 112 остаётся", async () => {
    const { env } = setup({ api: fakeApi({ emergencyContacts: () => Promise.reject(new Error("x")) }) });
    render(
      <GuideProvider value={env}>
        <Help />
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("112");
    expect(screen.getByTestId("call-112")).toBeDefined();
  });
});

describe("«Що поруч» C05", () => {
  it("отказ в геолокации — плашка и места от базовой точки", async () => {
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: (_ok: unknown, err: () => void) => err() },
    });
    const { env } = setup();
    render(
      <GuideProvider value={env}>
        <Nearby useMyLocation />
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByTestId("geo-off").textContent).toBe(
      "Геолокацію вимкнено. Показуємо місця поруч: Тестовий готель.",
    );
    expect(screen.getByTestId("nearby-caption").textContent).toBe("Поруч: Тестовий готель");
    expect(env.api.search).toHaveBeenCalledWith({
      point: env.base!.point,
      radius: 1000,
      excludeSections: ["stay"],
      limit: 50,
    });
  });

  it("геолокация получена — «Поруч із вами», поиск от устройства", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 48.1, longitude: 24.1 } }),
      },
    });
    const { env } = setup();
    render(
      <GuideProvider value={env}>
        <Nearby useMyLocation />
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByTestId("nearby-caption").textContent).toBe("Поруч із вами");
    expect(env.api.search).toHaveBeenCalledWith({
      point: { lat: 48.1, lng: 24.1 },
      radius: 1000,
      excludeSections: ["stay"],
      limit: 50,
    });
  });
});

describe("«Що поруч»: пилюли радиуса и категория места", () => {
  it("пилюли 300 м – 10 км, подпись значения; запрос — после паузы, один на серию нажатий", async () => {
    const { env } = setup();
    render(
      <GuideProvider value={env}>
        <Nearby useMyLocation={false} />
      </GuideProvider>,
    );
    await flush();
    const pills = within(screen.getByRole("group", { name: "Радіус" }));
    expect(pills.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "300 м",
      "500 м",
      "1 км",
      "3 км",
      "5 км",
      "10 км",
    ]);
    // По умолчанию 1 км: пилюля, подпись и запрос согласованы.
    expect(pills.getByRole("button", { name: "1 км" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("radius-value").textContent).toBe("Радіус ≤ 1 км");
    // Категория места из справочника под названием.
    expect(screen.getAllByTestId("place-category")[0]!.textContent).toBe("Кав'ярні");
    const calls = vi.mocked(env.api.search).mock.calls.length;
    fireEvent.click(pills.getByRole("button", { name: "3 км" }));
    fireEvent.click(pills.getByRole("button", { name: "10 км" }));
    expect(screen.getByTestId("radius-value").textContent).toBe("Радіус ≤ 10 км");
    expect(pills.getByRole("button", { name: "10 км" }).getAttribute("aria-pressed")).toBe("true");
    expect(pills.getByRole("button", { name: "1 км" }).getAttribute("aria-pressed")).toBe("false");
    expect(vi.mocked(env.api.search).mock.calls.length).toBe(calls);
    await act(async () => new Promise((r) => setTimeout(r, 400)));
    expect(vi.mocked(env.api.search).mock.calls.length).toBe(calls + 1);
    expect(env.api.search).toHaveBeenLastCalledWith({
      point: env.base!.point,
      radius: 10000,
      excludeSections: ["stay"],
      limit: 50,
    });
  });
});

describe("«Що поруч»: шапка и плашка ближайшего", () => {
  it("значение вне шага — ближайшая пилюля", () => {
    expect(snapRadius(300)).toBe(300);
    expect(snapRadius(1500)).toBe(1000);
    expect(snapRadius(2500)).toBe(3000);
    expect(snapRadius(50)).toBe(300);
    expect(snapRadius(20_000)).toBe(10_000);
  });

  it("«Список ↓» уменьшает карту и прокручивает к листу, «Розгорнути» — обратно наверх", async () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    Element.prototype.scrollIntoView = scrollIntoView;
    const { env } = setup();
    const { container } = render(
      <GuideProvider value={env}>
        <Nearby useMyLocation={false} />
      </GuideProvider>,
    );
    await flush();
    const root = container.querySelector(".modern-nearby")!;
    expect(root.getAttribute("data-map-mode")).toBe("full");
    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Список ↓" }));
    expect(root.getAttribute("data-map-mode")).toBe("split");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Розгорнути" }));
    expect(root.getAttribute("data-map-mode")).toBe("full");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("геолокация — кнопка-значок с подписью: занята на время запроса, скрыта при полученной точке", async () => {
    let answer: ((p: unknown) => void) | undefined;
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (ok: (p: unknown) => void) => {
          answer = ok;
        },
      },
    });
    const { env } = setup();
    render(
      <GuideProvider value={env}>
        <Nearby useMyLocation={false} />
      </GuideProvider>,
    );
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Що поруч зі мною зараз" }));
    const busy = screen.getByRole("button", { name: "Визначаємо геолокацію…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    await act(async () => answer?.({ coords: { latitude: 48.1, longitude: 24.1 } }));
    await flush();
    expect(screen.queryByTestId("nearby-locate")).toBeNull();
  });
});

describe("«Що поруч»: строка статуса", () => {
  it("modern: счётчик «Найближчі місця (N)»; при 50 местах — пометка об ограничении", async () => {
    const many = Array.from({ length: 50 }, (_, i) => summary({ id: `p${i}`, name: { uk: `Місце ${i}` } }));
    const search = vi.fn(async () => many);
    const { env } = setup({ api: fakeApi({ search }) });
    render(
      <GuideProvider value={env}>
        <Nearby useMyLocation={false} />
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByTestId("nearby-status").textContent).toBe("Найближчі місця (50) — від 120 м");
    expect(screen.getByText("Найближчих місць: 50.")).toBeDefined();
    cleanup();
    const { env: env2 } = setup();
    render(
      <GuideProvider value={env2}>
        <Nearby useMyLocation={false} />
      </GuideProvider>,
    );
    await flush();
    expect(screen.getByTestId("nearby-status").textContent).toBe("Найближчі місця (2) — від 120 м");
    expect(screen.queryByText(/Найближчих місць/)).toBeNull();
  });
});

describe("адаптер api и аналитика", () => {
  it("regionId в query, DTO → модель (lon/lat, вариант фото w800, метка рекламы)", async () => {
    const dto: ApiSchemas["PlaceSummaryDto"] = {
      id: P1,
      categoryId: CAFE,
      name: { uk: "Смерека" },
      address: null,
      location: { lon: 24.56, lat: 48.45 },
      distanceMeters: 42,
      recommended: false,
      adLabel: "partner",
      openNow: null,
      phone: null,
      coverPhoto: null,
      cover: {
        mediaAssetId: P1,
        alt: { uk: "Фасад" },
        width: 1600,
        height: 900,
        isCover: true,
        variants: [
          { name: "w320", url: "https://cdn/320", width: 320, height: 180, expiresAt: null },
          { name: "w800", url: "https://cdn/800", width: 800, height: 450, expiresAt: null },
        ],
      },
    };
    const urls: string[] = [];
    const fetch = vi.fn(async (req: Request) => {
      urls.push(req.url);
      return Response.json({ items: [dto], nextOffset: null, radiusMeters: 500 });
    });
    const api = createGuideApi(createApiClient({ baseUrl: "http://api.test", fetch }), REGION);
    const [p] = await api.search({ point: { lat: 48.45, lng: 24.56 }, radius: 500, q: "сме" });
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/places/search");
    expect(url.searchParams.get("regionId")).toBe(REGION);
    expect(url.searchParams.get("lat")).toBe("48.45");
    expect(url.searchParams.get("radius")).toBe("500");
    // По умолчанию ничего не исключается (поиск по названию находит и отели).
    expect(url.searchParams.getAll("exclude_section")).toEqual([]);
    await api.search({ point: { lat: 48.45, lng: 24.56 }, radius: 500, excludeSections: ["stay"] });
    expect(new URL(urls[1]!).searchParams.getAll("exclude_section")).toEqual(["stay"]);
    // max — догрузка страниц по nextOffset до max мест.
    const paged = vi.fn(async (req: Request) => {
      const offset = Number(new URL(req.url).searchParams.get("offset") ?? 0);
      return Response.json({
        items: [dto, dto],
        nextOffset: offset < 4 ? offset + 2 : null,
        radiusMeters: null,
      });
    });
    const pagedApi = createGuideApi(createApiClient({ baseUrl: "http://api.test", fetch: paged }), REGION);
    expect(await pagedApi.search({ limit: 2, max: 5 })).toHaveLength(5);
    expect(paged).toHaveBeenCalledTimes(3);
    expect(await pagedApi.search({ limit: 2 })).toHaveLength(2);
    // Сбой не первой страницы — уже загруженное; сбой первой — ошибка.
    let calls = 0;
    const flaky = vi.fn(async () =>
      ++calls === 2
        ? Response.json({ code: "INTERNAL" }, { status: 500 })
        : Response.json({ items: [dto, dto], nextOffset: 2, radiusMeters: null }),
    );
    const flakyApi = createGuideApi(createApiClient({ baseUrl: "http://api.test", fetch: flaky }), REGION);
    expect(await flakyApi.search({ limit: 2, max: 6 })).toHaveLength(2);
    // Отмена — догрузка прекращается, результат — ошибка.
    const abort = new AbortController();
    const stopping = vi.fn(async () => {
      abort.abort();
      return Response.json({ items: [dto, dto], nextOffset: 2, radiusMeters: null });
    });
    const stoppingApi = createGuideApi(
      createApiClient({ baseUrl: "http://api.test", fetch: stopping }),
      REGION,
    );
    await expect(stoppingApi.search({ limit: 2, max: 6, signal: abort.signal })).rejects.toThrow();
    expect(stopping).toHaveBeenCalledTimes(1);
    expect(p).toMatchObject({
      location: { lat: 48.45, lng: 24.56 },
      cover: { url: "https://cdn/800", alt: { uk: "Фасад" } },
      adLabel: "partner",
    });
    await expect(
      createGuideApi(createApiClient({ baseUrl: "http://x", fetch }), null).categories(),
    ).rejects.toThrow();
  });

  it("404 карточки — NotFoundError", async () => {
    const fetch = vi.fn(async () => Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }));
    const api = createGuideApi(createApiClient({ baseUrl: "http://api.test", fetch }), REGION);
    await expect(api.place(P1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("события пакетом с конвертом; без anonymousId не отправляются", async () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (req: Request) => {
      bodies.push(await req.json());
      return Response.json({ accepted: 1 }, { status: 202 });
    });
    const client = createApiClient({ baseUrl: "http://api.test", fetch });
    let anonymousId: string | null = null;
    const a = createAnalytics(client, () => ({ anonymousId, regionId: REGION, source: "qr" }), 10_000);
    a.track("place_viewed", { placeId: P1 });
    await a.flush();
    expect(fetch).not.toHaveBeenCalled();
    anonymousId = "7d0f3e1a-5b2c-4c8d-9e6f-0a1b2c3d4e5f";
    a.track("place_viewed", { placeId: P1 });
    a.track("search_used", { resultCount: 3 });
    await a.flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const { events } = bodies[0] as { events: Record<string, unknown>[] };
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event: "place_viewed",
      schemaVersion: 1,
      anonymousId,
      regionId: REGION,
      source: "qr",
      placeId: P1,
      props: { placeId: P1 },
    });
    expect(events[1]).not.toHaveProperty("placeId");
    // Пакет проходит ту же схему, что проверяет api (@tg/shared).
    expect(clientAnalyticsBatchSchema.safeParse(bodies[0]).success).toBe(true);
  });
});

describe("аналитика: отправка без потерь", () => {
  it("route_clicked уходит сразу с keepalive; накопленное — при уходе со страницы", async () => {
    const reqs: Request[] = [];
    const fetch = vi.fn(async (req: Request) => {
      reqs.push(req);
      return Response.json({ accepted: 1 }, { status: 202 });
    });
    const ctx = {
      anonymousId: "7d0f3e1a-5b2c-4c8d-9e6f-0a1b2c3d4e5f",
      regionId: REGION,
      source: "qr" as const,
    };
    const a = createAnalytics(createApiClient({ baseUrl: "http://api.test", fetch }), () => ctx, 60_000);
    a.track("route_clicked", { placeId: P1 });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reqs[0]!.keepalive).toBe(true);
    a.track("place_viewed", { placeId: P1 });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("правки ревью", () => {
  it("dispose снимает обработчик pagehide", async () => {
    const fetch = vi.fn(async () => Response.json({ accepted: 1 }, { status: 202 }));
    const ctx = {
      anonymousId: "7d0f3e1a-5b2c-4c8d-9e6f-0a1b2c3d4e5f",
      regionId: REGION,
      source: "qr" as const,
    };
    const a = createAnalytics(createApiClient({ baseUrl: "http://api.test", fetch }), () => ctx, 60_000);
    a.track("place_viewed", { placeId: P1 });
    a.dispose();
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("базовая точка не пришла — каталог ищет без неё после ожидания", async () => {
    vi.useFakeTimers();
    try {
      const { env } = setup({ base: { name: "Тестовий готель", point: null, pending: true } });
      render(
        <GuideProvider value={env}>
          <Catalog section="eat" />
        </GuideProvider>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(env.api.search).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(env.api.search).toHaveBeenCalledWith({ categoryId: EAT, q: undefined, point: null });
      expect(screen.getAllByTestId("place-item")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
