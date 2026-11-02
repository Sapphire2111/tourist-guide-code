// Блок 4: гид туриста — главная C02, каталог C04, «Що поруч» C05, картка місця C06, «Халепа?» C14, обране.
// api не поднят — каталог отдаёт support/api-mock.ts; карта OSM и фото — заглушки без сети (fixtures.ts).
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState, CAFE_PLACE } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

test.describe("QR отеля demoHotel01", () => {
  test.use({ telegram: { startParam: "demoHotel01" } });

  test("главная: 8 разделов и нижняя навигация; a11y", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeVisible();
    const sections = page.getByTestId("home-sections").getByRole("link");
    await expect(sections).toHaveText([
      "Про заклад",
      "Де поїсти",
      "Де купити",
      "Де відпочити",
      "Розваги",
      "Що поруч",
      "Трансфер",
      "Халепа?",
    ]);
    const nav = page.getByRole("navigation", { name: "Основна навігація" });
    await expect(nav.getByRole("link", { name: "Головна" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Халепа?" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test("каталог: раздел, подкатегория, поиск; реклама помечена; события без текста запроса; a11y", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Де поїсти" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Де поїсти" })).toBeVisible();
    await expect(page.getByTestId("place-item")).toHaveCount(2);
    const ad = page.getByTestId("place-item").filter({ hasText: "Піцерія «Реклама»" });
    await expect(ad.getByTestId("badge-ad")).toHaveText("Реклама");
    await expect(ad.getByTestId("badge-recommended")).toHaveCount(0);
    await expectNoSeriousA11yViolations(page);

    await page.getByRole("searchbox").fill("смерека");
    await page.getByRole("button", { name: "Знайти" }).click();
    await expect(page.getByTestId("place-item")).toHaveCount(1);
    await page.getByRole("button", { name: "Карта" }).click();
    await expect(page.getByTestId("places-map").locator(".leaflet-tile-pane")).toBeAttached();
    await expectNoSeriousA11yViolations(page);

    await page.getByRole("searchbox").fill("немає такого");
    await page.getByRole("button", { name: "Знайти" }).click();
    await expect(page.getByTestId("catalog-empty")).toBeVisible();
    await page.getByRole("button", { name: "Скинути" }).click();
    await expect(page.getByTestId("place-item")).toHaveCount(2);

    const state = apiMockState.get(page)!;
    await expect.poll(() => state.events.map((e) => e.event)).toContain("search_used");
    expect(state.events.map((e) => e.event)).toContain("category_opened");
    const search = state.events.find((e) => e.event === "search_used")!;
    expect(search.props).toEqual({ categoryId: expect.any(String), resultCount: 1 });
    expect(JSON.stringify(state.events)).not.toContain("смерека");
    expect(search.regionId).toBe("00000000-0000-4000-8000-0000000000a1");
  });

  test("картка місця: бейджи, маршрут, звонок, обране; события; a11y", async ({ page }) => {
    await page.goto(`/#/place/${CAFE_PLACE}`);
    await expect(page.getByRole("heading", { level: 1, name: "Кав'ярня «Смерека»" })).toBeVisible();
    await expect(page.getByTestId("badge-availability")).toHaveText("Уточнити доступність");
    await expect(page.getByTestId("badge-recommended")).toBeVisible();
    await expect(page.getByTestId("badge-open")).toBeVisible();
    await expect(page.getByRole("img", { name: "Фото: Кав'ярня «Смерека»" })).toBeVisible();
    await expect(page.getByTestId("place-call")).toHaveAttribute("href", "tel:+380501112233");
    await expect(page.getByTestId("place-route")).toHaveAttribute("href", /openstreetmap\.org\/directions/);
    await expectNoSeriousA11yViolations(page);

    // Ссылки не уводят со страницы в тесте: tel: и внешний маршрут перехватываем.
    await page.evaluate(() =>
      document.addEventListener("click", (e) => {
        if ((e.target as Element).closest('a[href^="tel:"], a[target="_blank"]')) e.preventDefault();
      }),
    );
    await page.getByTestId("place-call").click();
    await page.getByTestId("place-route").click();
    await page.getByRole("button", { name: "Додати в обране" }).click();
    await expect(page.getByRole("button", { name: "Прибрати з обраного" })).toBeVisible();
    const state = apiMockState.get(page)!;
    expect(state.favorites).toEqual([CAFE_PLACE]);
    await expect
      .poll(() => state.events.map((e) => e.event))
      .toEqual(expect.arrayContaining(["place_viewed", "call_clicked", "route_clicked"]));

    await page
      .getByRole("navigation", { name: "Основна навігація" })
      .getByRole("link", { name: "Обране" })
      .click();
    await expect(page.getByTestId("favorites-list").getByRole("link")).toHaveText(["Кав'ярня «Смерека»"]);
    await expectNoSeriousA11yViolations(page);
  });

  test("неопубликованное/неизвестное место — «Заклад недоступний»", async ({ page }) => {
    await page.goto("/#/place/00000000-0000-4000-8000-000000000999");
    await expect(page.getByTestId("place-not-found")).toHaveText("Заклад недоступний.");
  });

  test("«Що поруч» без геолокации: от базовой точки отеля, радиус; a11y", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("home-sections").getByRole("link", { name: "Що поруч" }).click();
    await expect(page.getByTestId("nearby-caption")).toHaveText("Поруч із Тестовий готель");
    await expect(page.getByTestId("place-item")).toHaveCount(2);
    const state = apiMockState.get(page)!;
    expect(state.searches.at(-1)).toMatchObject({ lat: "48.45", lng: "24.56", radius: "500" });
    await page.getByLabel("Радіус").selectOption("300");
    await expect(page.getByTestId("place-item")).toHaveCount(1);
    await expect(page.getByTestId("places-map")).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });

  test("«Що поруч зі мною зараз»: отказ — плашка и режим базовой точки", async ({ page, context }) => {
    await context.clearPermissions();
    await page.goto("/");
    await page.getByTestId("near-me").click();
    await expect(page.getByTestId("geo-off")).toHaveText(
      "Геолокацію вимкнено. Показуємо місця біля Тестовий готель.",
    );
    await expect(page.getByTestId("place-item")).toHaveCount(2);
  });

  test("«Що поруч зі мною зараз»: разрешение — «Поруч із вами», поиск от устройства", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 48.4535, longitude: 24.5635 });
    await page.goto("/#/nearby/me");
    await expect(page.getByTestId("nearby-caption")).toHaveText("Поруч із вами");
    const state = apiMockState.get(page)!;
    await expect.poll(() => state.searches.at(-1)?.lat).toBe("48.4535");
    await expect(page.getByTestId("place-item").first()).toContainText("Піцерія «Реклама»");
  });

  test("«Халепа?»: 112 и контакты региона, звонок в одно нажатие; a11y", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("home-sections").getByRole("link", { name: "Халепа?" }).click();
    await expect(page.getByTestId("call-112")).toHaveAttribute("href", "tel:112");
    await expect(page.getByRole("link", { name: "Подзвонити: Поліція, 102" })).toHaveAttribute(
      "href",
      "tel:102",
    );
    await expect(
      page.getByRole("link", { name: "Подзвонити: Гірська рятувальна служба, +380342000000" }),
    ).toHaveAttribute("href", "tel:+380342000000");
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe("тёмная тема Telegram", () => {
  test.use({
    telegram: {
      startParam: "demoHotel01",
      colorScheme: "dark",
      themeParams: {
        bg_color: "#17212b",
        text_color: "#f5f5f5",
        hint_color: "#708499",
        link_color: "#6ab3f3",
        button_color: "#5288c1",
        button_text_color: "#ffffff",
        secondary_bg_color: "#232e3c",
      },
    },
  });

  test("главная, каталог и «Халепа?» без нарушений a11y", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("home-sections")).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("link", { name: "Де поїсти" }).click();
    await expect(page.getByTestId("place-item")).toHaveCount(2);
    await expectNoSeriousA11yViolations(page);
    await page.goto("/#/help");
    await expect(page.getByRole("link", { name: "Подзвонити: Поліція, 102" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe("вне Telegram", () => {
  test.use({ telegram: null });

  test("без региона — понятное сообщение; «Халепа?» с 112 доступна", async ({ page }) => {
    await page.goto("/#/section/eat");
    await expect(page.getByTestId("no-region")).toBeVisible();
    await page.goto("/#/help");
    await expect(page.getByTestId("call-112")).toBeVisible();
    await page.goto("/#/favorites");
    await expect(page.getByTestId("no-region")).toBeVisible();
  });
});
