// «Назад» на всех экранах: кнопка Telegram и своя идут по истории приложения, состояние списка возвращается.
// Нет истории (прямая ссылка, QR) — логичный родитель; на главной кнопка скрыта.
import type { Page } from "@playwright/test";
import { apiMockState, CAFE_PLACE } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";

const press = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __telegramPress(b: string): void }).__telegramPress("BackButton"),
  );

const backVisible = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { Telegram: { WebApp: { BackButton: { isVisible: boolean } } } }).Telegram.WebApp
        .BackButton.isVisible,
  );

const historyLength = (page: Page) => page.evaluate(() => window.history.length);

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n + 1000).padStart(12, "0")}`;

/** Длинная выдача поиска: страница прокручивается. */
async function manyPlaces(page: Page, count = 30) {
  await page.route(
    (url) => url.pathname === "/places/search",
    (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      return route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: {
          nextOffset: null,
          radiusMeters: null,
          items: Array.from({ length: count }, (_, i) => ({
            id: i === 0 ? CAFE_PLACE : uuid(i),
            categoryId: "00000000-0000-4000-8000-000000000102",
            name: { uk: `Місце ${i + 1}` },
            address: { uk: "м. Тестове" },
            location: { lat: 48.45, lon: 24.56 },
            distanceMeters: null,
            recommended: false,
            adLabel: null,
            openNow: true,
            phone: null,
            cover: null,
          })),
        },
      });
    },
  );
}

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

test.describe("в Telegram (QR отеля)", () => {
  test.use({ telegram: { startParam: "demoHotel01" } });

  test("главная → раздел → подраздел + запрос → место → назад×3 → главная; фильтр, запрос и прокрутка те же", async ({
    page,
  }) => {
    await manyPlaces(page);
    const state = apiMockState.get(page)!;
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    expect(await backVisible(page)).toBe(false);

    await page.getByTestId("featured-eat").click();
    await expect(page).toHaveURL(/#\/section\/eat$/);
    await page.getByRole("button", { name: "Кав'ярні" }).click();
    await page.getByLabel("Пошук за назвою").fill("Місце");
    await page.getByRole("button", { name: "Знайти" }).click();
    const link = page.getByTestId("place-list").getByRole("link", { name: "Місце 25", exact: true });
    await link.scrollIntoViewIfNeeded();
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled).toBeGreaterThan(300);
    expect(await backVisible(page)).toBe(true);

    await link.click();
    await expect(page).toHaveURL(/#\/place\//);
    // Новый экран открывается сверху.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(50);
    const searches = state.searches.length;

    // 1: место → список: подраздел, запрос, та же прокрутка, без нового поиска.
    await press(page);
    await expect(page).toHaveURL(/#\/section\/eat$/);
    await expect(page.getByRole("button", { name: "Кав'ярні" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Пошук за назвою")).toHaveValue("Місце");
    await expect(page.getByTestId("place-list").getByRole("link")).toHaveCount(30);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolled - 80);
    expect(state.searches.length).toBe(searches);

    // 2: подраздел → раздел целиком, экран тот же.
    await press(page);
    await expect(page).toHaveURL(/#\/section\/eat$/);
    await expect(page.getByRole("button", { name: "Усі" })).toHaveAttribute("aria-pressed", "true");

    // 3: раздел → главная, кнопка скрыта.
    await press(page);
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(false);
  });

  test("новый заход в раздел — чистые фильтры (состояние только у возврата)", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("featured-eat").click();
    await page.getByRole("button", { name: "Кав'ярні" }).click();
    await press(page);
    await press(page);
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await page.getByTestId("featured-eat").click();
    await expect(page.getByRole("button", { name: "Усі" })).toHaveAttribute("aria-pressed", "true");
  });

  test("поиск → место → назад: тот же запрос и результаты", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    await page.evaluate(() => (window.location.hash = "#/search"));
    await page.getByLabel("Пошук за назвою").fill("Смерека");
    await page.getByRole("button", { name: "Знайти" }).click();
    const link = page.getByTestId("place-list").getByRole("link", { name: "Кав'ярня «Смерека»" });
    await expect(page.getByTestId("place-list").getByRole("link")).toHaveCount(1);
    await link.click();
    await expect(page.getByRole("heading", { level: 1, name: "Кав'ярня «Смерека»" })).toBeVisible();
    await press(page);
    await expect(page).toHaveURL(/#\/search$/);
    await expect(page.getByLabel("Пошук за назвою")).toHaveValue("Смерека");
    await expect(page.getByTestId("place-list").getByRole("link")).toHaveCount(1);
  });

  test("«Поруч» с радиусом → место → назад: тот же радиус и фильтр, без нового запроса", async ({ page }) => {
    const state = apiMockState.get(page)!;
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    await page
      .getByRole("navigation", { name: "Основна навігація" })
      .getByRole("link", { name: "Поруч", exact: true })
      .click();
    const radius = page.getByRole("slider", { name: "Радіус пошуку" });
    // Шаг 6 шкалы — 10 км.
    await radius.fill("6");
    await expect(page.getByTestId("radius-value")).toHaveText("Радіус ≤ 10 км");
    await expect.poll(() => state.searches.at(-1)?.radius).toBe("10000");
    await expect(page.getByTestId("nearby-status")).not.toHaveText("Завантажуємо…");
    const count = state.searches.length;
    await page.getByTestId("place-list").getByRole("link", { name: "Кав'ярня «Смерека»" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Кав'ярня «Смерека»" })).toBeVisible();
    await press(page);
    await expect(page).toHaveURL(/#\/nearby$/);
    await expect(page.getByTestId("radius-value")).toHaveText("Радіус ≤ 10 км");
    await expect(radius).toHaveAttribute("aria-valuetext", "10 км");
    await expect(page.getByTestId("place-list").getByRole("link").first()).toBeVisible();
    expect(state.searches.length).toBe(count);
  });

  test("«Поруч»: раздел и режим карты возвращаются; строки поиска нет; радиус по умолчанию 1 км", async ({
    page,
  }) => {
    await page.goto("/#/nearby");
    await expect(page.getByTestId("radius-value")).toHaveText("Радіус ≤ 1 км");
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await page.getByRole("button", { name: /Список/ }).click();
    await expect(page.locator(".modern-nearby")).toHaveAttribute("data-map-mode", "split");
    const filters = page.getByRole("group", { name: "Категорії місць поруч" });
    await filters.getByRole("button", { name: /Де поїсти/ }).click();
    await expect(filters.getByRole("button", { name: /Де поїсти/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("place-list").getByRole("link").first().click();
    await expect(page).toHaveURL(/#\/place\//);
    await press(page);
    await expect(page).toHaveURL(/#\/nearby$/);
    await expect(page.locator(".modern-nearby")).toHaveAttribute("data-map-mode", "split");
    await expect(filters.getByRole("button", { name: /Де поїсти/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("новая шапка и нижняя панель: 🔥-меню, QR и 112 на главной; «Назад» из 112 и с вкладок", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    const top = page.getByTestId("app-top");
    await expect(top.getByTestId("menu-btn")).toBeVisible();
    await expect(top.getByTestId("scan-btn")).toBeVisible();
    const sos = top.getByRole("link", { name: "Допомога" });
    await expect(sos).toContainText("112");

    await sos.click();
    await expect(page).toHaveURL(/#\/help$/);
    expect(await backVisible(page)).toBe(true);
    await press(page);
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(false);

    const nav = page.getByTestId("bottom-nav");
    await nav.getByRole("link", { name: "Поруч", exact: true }).click();
    await expect(page).toHaveURL(/#\/nearby$/);
    // На вложенном экране вместо 112 — QR, а путь к «Допомога» — пункт меню.
    await expect(top.getByTestId("scan-btn")).toBeVisible();
    await expect(top.getByTestId("help-112")).toHaveCount(0);
    await top.getByTestId("menu-btn").click();
    await expect(page.getByTestId("app-settings")).toBeVisible();
    await expect(page.getByTestId("help-menu-item")).toHaveAttribute("href", "#/help");
    await press(page);
    await expect(page.getByTestId("app-settings")).toHaveCount(0);
    await expect(page).toHaveURL(/#\/nearby$/);
    await nav.getByRole("link", { name: "Головна" }).click(); // тап по предыдущей вкладке — шаг назад
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(false);
  });

  test("«Поруч зі мною» → место → назад: геолокация остаётся, тап по вкладке не сбрасывает", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 48.4512, longitude: 24.5612 });
    await page.goto("/");
    await page.getByTestId("near-me").click();
    await expect(page.getByTestId("nearby-caption")).toHaveText("Поруч із вами");
    const before = await historyLength(page);
    await page
      .getByRole("navigation", { name: "Основна навігація" })
      .getByRole("link", { name: "Поруч", exact: true })
      .click();
    await expect(page).toHaveURL(/#\/nearby\/me$/);
    expect(await historyLength(page)).toBe(before);
    await page.getByTestId("place-list").getByRole("link").first().click();
    await expect(page).toHaveURL(/#\/place\//);
    await press(page);
    await expect(page).toHaveURL(/#\/nearby\/me$/);
    await expect(page.getByTestId("nearby-caption")).toHaveText("Поруч із вами");
  });

  test("план → сценарий → назад: та же дата; «До списку» — шаг назад, вкладки — без записей", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    const nav = page.getByRole("navigation", { name: "Основна навігація" });
    await nav.getByRole("link", { name: "Мій план" }).click();
    await page.getByTestId("scenarios-date").fill("2030-07-01");
    await expect(page.getByTestId("scenario-item").first()).toBeVisible();
    await page.getByTestId("scenario-item").first().getByRole("link").click();
    await expect(page).toHaveURL(/#\/plan\/scenario\/.+\?date=2030-07-01$/);
    await press(page);
    await expect(page).toHaveURL(/#\/plan$/);
    await expect(page.getByTestId("scenarios-date")).toHaveValue("2030-07-01");

    // «До списку» со сценария: тот же список, а не новая запись поверх (нет цикла A→B→A→B).
    await page.getByTestId("scenario-item").first().getByRole("link").click();
    await expect(page).toHaveURL(/#\/plan\/scenario\//);
    await page.getByRole("link", { name: "До списку" }).click();
    await expect(page).toHaveURL(/#\/plan$/);
    await expect(page.getByTestId("scenarios-date")).toHaveValue("2030-07-01");

    // Переключатель вкладок плана не копит записи; «Назад» — на главную.
    await page.getByRole("button", { name: "Збережені" }).click();
    await expect(page).toHaveURL(/#\/plan\/saved$/);
    await press(page);
    await expect(page.getByTestId("home-sections")).toBeVisible();
  });

  test("сценарий → место → назад → назад → план", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    await page
      .getByRole("navigation", { name: "Основна навігація" })
      .getByRole("link", { name: "Мій план" })
      .click();
    await page.getByTestId("scenario-item").first().getByRole("link").click();
    await page.getByTestId("plan-item").first().getByRole("link").click();
    await expect(page).toHaveURL(/#\/place\//);
    await press(page);
    await expect(page).toHaveURL(/#\/plan\/scenario\//);
    await expect(page.getByTestId("plan-item").first()).toBeVisible();
    await press(page);
    await expect(page).toHaveURL(/#\/plan$/);
  });

  test("прямая ссылка на место → назад → главная (Mini App не закрывается); кнопка скрыта", async ({
    page,
  }) => {
    await page.goto(`/#/place/${CAFE_PLACE}`);
    await expect(page.getByRole("heading", { level: 1, name: "Кав'ярня «Смерека»" })).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(true);
    await press(page);
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(false);
  });

  test("прямая ссылка на сценарий плана → назад → план → назад → главная", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    await page
      .getByRole("navigation", { name: "Основна навігація" })
      .getByRole("link", { name: "Мій план" })
      .click();
    const href = await page.getByTestId("scenario-item").first().getByRole("link").getAttribute("href");
    await page.goto("about:blank");
    await page.goto(`/${href}`);
    await expect(page.getByTestId("plan-item").first()).toBeVisible();
    await press(page);
    await expect(page).toHaveURL(/#\/plan$/);
    await press(page);
    await expect(page.getByTestId("home-sections")).toBeVisible();
  });

  test("нижняя навигация: повторный тап без записи, «Назад» туда, откуда пришёл, тап по предыдущей — шаг назад", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    const nav = page.getByRole("navigation", { name: "Основна навігація" });
    const planTab = nav.getByRole("link", { name: "Мій план" });
    const nearbyTab = nav.getByRole("link", { name: "Поруч", exact: true });
    const homeTab = nav.getByRole("link", { name: "Головна" });

    await homeTab.click(); // на главной: без записи
    const start = await historyLength(page);
    await planTab.click();
    await expect(page).toHaveURL(/#\/plan$/);
    await planTab.click(); // повторный тап
    expect(await historyLength(page)).toBe(start + 1);

    await nearbyTab.click();
    await expect(page).toHaveURL(/#\/nearby$/);
    expect(await historyLength(page)).toBe(start + 2);
    // Тап по предыдущей вкладке — шаг назад, а не новая запись.
    await planTab.click();
    await expect(page).toHaveURL(/#\/plan$/);
    expect(await historyLength(page)).toBe(start + 2);
    await press(page);
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(false);
  });

  test("лист меню и «Локація» на экране: «Назад» закрывает лист и не уводит с экрана", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    // На главной кнопка появляется только на время листа.
    await page.getByTestId("menu-btn").click();
    await expect(page.getByTestId("app-settings")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(true);
    await press(page);
    await expect(page.getByTestId("app-settings")).toHaveCount(0);
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(false);

    await page.getByTestId("location-chip").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(true);
    await press(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(false);

    await page.getByTestId("featured-eat").click();
    await expect(page).toHaveURL(/#\/section\/eat$/);
    await page.getByTestId("menu-btn").click();
    await expect(page.getByTestId("app-settings")).toBeVisible();
    await press(page);
    await expect(page.getByTestId("app-settings")).toHaveCount(0);
    await expect(page).toHaveURL(/#\/section\/eat$/);
    expect(await backVisible(page)).toBe(true);
  });

  test("Обране из меню → место → назад → назад: список, затем экран, откуда открыли меню", async ({
    page,
  }) => {
    apiMockState.get(page)!.favorites = [CAFE_PLACE];
    await page.goto("/#/help");
    await page.getByTestId("menu-btn").click();
    await page.getByTestId("app-settings").getByRole("link", { name: "Обране" }).click();
    await page.getByTestId("favorites-list").getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Кав'ярня «Смерека»" })).toBeVisible();
    await press(page);
    await expect(page).toHaveURL(/#\/favorites$/);
    await expect(page.getByTestId("favorites-list").getByRole("link")).toHaveCount(1);
    await press(page);
    await expect(page).toHaveURL(/#\/help$/);
  });

  test("двойное нажатие «Назад» — один шаг", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    await page.getByTestId("featured-eat").click();
    await page.getByTestId("place-list").getByRole("link").first().click();
    await expect(page).toHaveURL(/#\/place\//);
    await page.evaluate(() => {
      const w = window as unknown as { __telegramPress(b: string): void };
      w.__telegramPress("BackButton");
      w.__telegramPress("BackButton");
    });
    await expect(page).toHaveURL(/#\/section\/eat$/);
    await page.waitForTimeout(200);
    await expect(page).toHaveURL(/#\/section\/eat$/);
  });
});

test.describe("лимит истории и партнёр", () => {
  test("больше 50 записей: кнопка не «мёртвая», доходит до главной", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await page.evaluate(async () => {
      for (let i = 1; i <= 60; i++) {
        window.location.hash = `/nope/${i}`;
        await new Promise((r) => window.addEventListener("hashchange", r, { once: true }));
      }
    });
    await expect(page).toHaveURL(/#\/nope\/60$/);
    // Назад до нижней сохранённой записи и ниже: каждое нажатие что-то делает, пока не главная.
    for (let i = 0; i < 70; i++) {
      if (await page.getByTestId("home-sections").isVisible()) break;
      const before = page.url();
      await press(page);
      await expect.poll(() => page.url(), { timeout: 3000 }).not.toBe(before);
    }
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expect.poll(() => backVisible(page)).toBe(false);
  });

  test("возврат: фокус на ссылке, с которой ушли", async ({ page }) => {
    await page.goto("/");
    const link = page.getByTestId("featured-eat");
    await link.click();
    await expect(page).toHaveURL(/#\/section\/eat$/);
    await press(page);
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expect(link).toBeFocused();
  });
});

test.describe("старый клиент Telegram (Bot API 6.0): BackButton без действия", () => {
  test.use({ telegram: { version: "6.0" } });

  test("своя кнопка «Назад» идёт по истории", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Допомога" }).click();
    await expect(page).toHaveURL(/#\/help$/);
    await page.evaluate(() => (window.location.hash = "#/nope"));
    await expect(page.getByRole("heading", { level: 1, name: "Сторінку не знайдено" })).toBeVisible();
    await page.getByRole("button", { name: "Назад" }).click();
    await expect(page).toHaveURL(/#\/help$/);
    await page.getByRole("button", { name: "Назад" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeAttached();
    await expect(page.getByRole("button", { name: "Назад" })).toHaveCount(0);
  });
});

test.describe("вне Telegram", () => {
  test.use({ telegram: null });

  test("своя кнопка: по истории, затем родитель; цепочка из прямой ссылки", async ({ page }) => {
    await page.goto("/#/help");
    await page.evaluate(() => (window.location.hash = "#/nope"));
    await expect(page.getByRole("heading", { level: 1, name: "Сторінку не знайдено" })).toBeVisible();
    await page.getByRole("button", { name: "Назад" }).click();
    await expect(page).toHaveURL(/#\/help$/);
    // Вход был сразу на #/help: истории нет — главная, заменой, страница не покидается.
    await page.getByRole("button", { name: "Назад" }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeAttached();
  });
});
