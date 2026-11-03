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
test("modern home, preference persistence, nearby search/map/list and original restoration", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("venue-summary")).toBeVisible();
  await page.getByRole("button", { name: "Сучасний", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Що хочеться сьогодні?" })).toBeVisible();
  await expect(page.getByTestId("home-sections").getByRole("link")).toHaveCount(4);
  await expectNoSeriousA11yViolations(page);
  await page.screenshot({ path: "../output/design-concepts/implemented-modern-home.png", fullPage: false });
  await page.reload();
  await expect(page.getByRole("button", { name: "Сучасний", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page
    .getByRole("navigation", { name: "Основна навігація" })
    .getByRole("link", { name: "Поруч", exact: true })
    .click();
  await expect(page.getByTestId("nearby-caption")).toContainText("Тестовий готель");
  await expect(page.getByTestId("places-map")).toBeVisible();
  await page.locator("summary").click();
  await expect(page.getByRole("slider")).toBeVisible();
  await page.getByRole("slider").fill("1000");
  await expect(page.getByTestId("radius-value")).toContainText("1");
  await page.getByRole("slider").fill("500");
  await page.locator("summary").click();
  const search = page.getByRole("searchbox", { name: "Знайти місце" });
  await page
    .getByRole("group", { name: "Категорії місць поруч" })
    .getByRole("button", { name: "Де поїсти", exact: true })
    .click();
  await search.fill("Смерека");
  await expect(page.getByTestId("place-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Список", exact: true }).click();
  await expect(page.getByTestId("places-map")).toHaveCount(0);
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
    path: "../output/design-concepts/implemented-modern-nearby-list.png",
    fullPage: true,
  });
  await search.fill("немає такого місця");
  await expect(page.getByTestId("nearby-empty")).toBeVisible();
  await page.getByRole("button", { name: "Скинути фільтри" }).click();
  await page.getByRole("button", { name: "Карта", exact: true }).click();
  await expect(page.getByTestId("places-map")).toBeVisible();
  await page.screenshot({
    path: "../output/design-concepts/implemented-modern-nearby-map.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Оригінальний", exact: true }).click();
  await expect(page).toHaveURL(/nearby/);
  await expect(page.getByTestId("places-map")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Основна навігація" })
    .getByRole("link", { name: "Головна", exact: true })
    .click();
  await expect(page.getByTestId("home-sections").getByRole("link")).toHaveCount(11);
});
test("modern narrow screen retains working list", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.getByRole("button", { name: "Сучасний", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Що хочеться сьогодні?" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoSeriousA11yViolations(page);
  await page.getByRole("link", { name: "Відкрити місця поруч" }).click();
  await expect(page.getByTestId("place-item").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test.describe("without map provider", () => {
  test.use({ googleMaps: false });
  test("list remains available", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Сучасний", exact: true }).click();
    await page.getByRole("link", { name: "Відкрити місця поруч" }).click();
    await expect(page.getByTestId("map-unavailable")).toBeVisible();
    await expect(page.getByTestId("place-item").first()).toBeVisible();
    await page.getByRole("button", { name: "Список", exact: true }).click();
    await expect(page.getByTestId("place-item").first()).toBeVisible();
  });
});
