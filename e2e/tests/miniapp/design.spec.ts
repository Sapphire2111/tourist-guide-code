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
test("modern home (legacy saved choice ignored), nearby filters/map/list", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("tg.design", "original"));
  await page.goto("/");
  await expect(page.getByTestId("venue-summary")).toBeAttached();
  await expect(page.locator("html")).toHaveAttribute("data-design", "modern");
  await expect(page.getByRole("heading", { name: "Запитай у гір, чого бажаєш" })).toBeVisible();
  await expect(page.getByTestId("home-sections").getByRole("link")).toHaveCount(9);
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
  const radius = page.getByRole("slider", { name: "Радіус пошуку" });
  // По умолчанию 1 км; поля поиска на экране нет.
  await expect(radius).toHaveAttribute("aria-valuetext", "1 км");
  await expect(page.getByTestId("radius-value")).toHaveText("Радіус ≤ 1 км");
  await radius.fill("1");
  await expect(radius).toHaveAttribute("aria-valuetext", "500 м");
  await expect(page.getByTestId("radius-value")).toHaveText("Радіус ≤ 500 м");
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await page.getByTestId("nearby-filter").click();
  await page.getByRole("dialog").getByRole("radio", { name: "Де поїсти", exact: true }).click();
  await expect(page.getByTestId("place-item")).toHaveCount(2);
  // «Список ↓»: карта 465 → 310 px, лист в зоне видимости; фильтры сохраняются.
  const frame = page.locator(".modern-map-stage");
  expect((await frame.boundingBox())!.height).toBe(465);
  await page.getByRole("button", { name: "Список ↓" }).click();
  await expect(frame).toHaveCSS("height", "310px");
  await expect(page.getByTestId("nearby-status")).toBeInViewport();
  await expect(page.getByTestId("nearby-filter")).toContainText("Де поїсти");
  await expect(page.getByRole("link", { name: "Маршрут", exact: true }).first()).toHaveAttribute(
    "href",
    /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/,
  );
  await expectNoSeriousA11yViolations(page);
  await page.screenshot({
    path: testInfo.outputPath("implemented-modern-nearby-list.png"),
    fullPage: true,
  });
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
  await expect(page.getByRole("heading", { name: "Запитай у гір, чого бажаєш" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoSeriousA11yViolations(page);
  await page
    .getByRole("navigation", { name: "Основна навігація" })
    .getByRole("link", { name: "Поруч", exact: true })
    .click();
  await expect(page.getByTestId("place-item").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // На 320 px панель поверх карты — два компактных ряда без наезда, цели радиуса и категорий не меньше 44 px.
  // Замер одним вызовом: экран ещё может доезжать анимацией появления.
  const { track, radius, chips } = await page.evaluate(() => {
    const box = (s: string) => {
      const b = document.querySelector(s)!.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    return {
      track: box(".kosiv-radius-overlay"),
      radius: box(".kosiv-radius-overlay input"),
      chips: box(".modern-filters button"),
    };
  });
  expect(Math.round(track.height)).toBe(44);
  expect(chips.y).toBeGreaterThanOrEqual(track.y + track.height);
  // Ряд радиуса (капсула и цели 44 px) целиком над видимым чипом.
  expect(chips.y).toBeGreaterThanOrEqual(radius.y + radius.height);
  // Расширение цели — псевдоэлемент: точка выше видимой пилюли всё ещё попадает в неё.
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, {
    x: chips.x + chips.width / 2,
    y: chips.y - 3,
  });
  expect(hit).toContain("Шукати все");
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
