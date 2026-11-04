import { apiMockState } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";

test.use({ telegram: { startParam: "demoHotel01" } });
test.beforeEach(async ({ page }) => {
  apiMockState.get(page)!.consents = [
    { kind: "terms", version: "2026-11-01-draft" },
    { kind: "privacy", version: "2026-11-01-draft" },
  ];
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});
test("modern home (legacy saved choice ignored), nearby search/map/list", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("tg.design", "original"));
  await page.goto("/");
  await expect(page.getByTestId("venue-summary")).toBeAttached();
  await expect(page.locator("html")).toHaveAttribute("data-design", "modern");
  await expect(page.getByRole("heading", { name: "Що хочеться сьогодні?" })).toBeVisible();
  await expect(page.getByTestId("home-sections").getByRole("link")).toHaveCount(8);
  await expectNoSeriousA11yViolations(page);
  await page.screenshot({ path: testInfo.outputPath("implemented-modern-home.png"), fullPage: false });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-design", "modern");
  await page.getByTestId("menu-btn").click();
  // Сначала лист открылся, потом проверка отсутствия: иначе toHaveCount(0) проходит до появления листа.
  await expect(page.getByRole("dialog", { name: "Меню" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Дизайн інтерфейсу" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page
    .getByRole("navigation", { name: "Основна навігація" })
    .getByRole("link", { name: "Поруч", exact: true })
    .click();
  await expect(page.getByTestId("nearby-caption")).toContainText("Тестовий готель");
  await expect(page.getByTestId("places-map")).toBeVisible();
  const radius = page.getByRole("group", { name: "Радіус" });
  await radius.getByRole("button", { name: "1 км" }).click();
  await expect(radius.getByRole("button", { name: "1 км" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("radius-value")).toHaveText("Радіус ≤ 1 км");
  await radius.getByRole("button", { name: "500 м" }).click();
  const search = page.getByRole("searchbox", { name: "Знайти місце" });
  await page
    .getByRole("group", { name: "Категорії місць поруч" })
    .getByRole("button", { name: "Де поїсти", exact: true })
    .click();
  await search.fill("Смерека");
  await expect(page.getByTestId("place-item")).toHaveCount(1);
  // «Список ↓»: карта 465 → 310 px, лист в зоне видимости; фильтры и запрос сохраняются.
  const frame = page.locator(".modern-map-stage");
  expect((await frame.boundingBox())!.height).toBe(465);
  await page.getByRole("button", { name: "Список ↓" }).click();
  await expect(frame).toHaveCSS("height", "310px");
  await expect(page.getByTestId("nearby-status")).toBeInViewport();
  await expect(
    page
      .getByRole("group", { name: "Категорії місць поруч" })
      .getByRole("button", { name: "Де поїсти", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(search).toHaveValue("Смерека");
  await expect(page.getByRole("link", { name: "Маршрут", exact: true })).toHaveAttribute(
    "href",
    /openstreetmap.org\/directions/,
  );
  await expectNoSeriousA11yViolations(page);
  await page.screenshot({
    path: testInfo.outputPath("implemented-modern-nearby-list.png"),
    fullPage: true,
  });
  await search.fill("немає такого місця");
  await expect(page.getByTestId("nearby-empty")).toBeVisible();
  await page.getByRole("button", { name: "Скинути фільтри" }).click();
  await page.getByRole("button", { name: "Розгорнути" }).click();
  await expect(frame).toHaveCSS("height", "465px");
  await expect(page.getByTestId("places-map")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("implemented-modern-nearby-map.png"),
    fullPage: true,
  });
});
test("modern narrow screen retains working list", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Що хочеться сьогодні?" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoSeriousA11yViolations(page);
  await page
    .getByRole("navigation", { name: "Основна навігація" })
    .getByRole("link", { name: "Поруч", exact: true })
    .click();
  await expect(page.getByTestId("place-item").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // На 320 px панель поверх карты — два ряда без наезда, цели радиуса и категорий не меньше 44 px.
  // Замер одним вызовом: экран ещё может доезжать анимацией появления.
  const { search, radius, chips } = await page.evaluate(() => {
    const box = (s: string) => {
      const b = document.querySelector(s)!.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    return {
      search: box(".modern-search"),
      radius: box(".modern-radius"),
      chips: box(".modern-filters button"),
    };
  });
  expect(search.y).toBe(radius.y);
  expect(radius.x).toBeGreaterThanOrEqual(search.x + search.width);
  expect(chips.y).toBeGreaterThanOrEqual(search.y + search.height);
  // Расширение цели — псевдоэлемент: точка выше видимой пилюли всё ещё попадает в неё.
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, {
    x: chips.x + chips.width / 2,
    y: chips.y - 3,
  });
  expect(hit).toContain("Усі поруч");
});
test.describe("without map provider", () => {
  test.use({ googleMaps: false });
  test("list remains available", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("navigation", { name: "Основна навігація" })
      .getByRole("link", { name: "Поруч", exact: true })
      .click();
    await expect(page.getByTestId("map-unavailable")).toBeVisible();
    await expect(page.getByTestId("place-item").first()).toBeVisible();
    await page.getByRole("button", { name: "Список ↓" }).click();
    await expect(page.getByTestId("place-item").first()).toBeVisible();
  });
});
