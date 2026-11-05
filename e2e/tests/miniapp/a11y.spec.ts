import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { expect, test } from "../../support/fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) => route.fulfill({ json: { status: "ok" } }));
});

test("Mini App: нет нарушений a11y уровня serious/critical (главная)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("home-sections")).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test("Mini App: нет нарушений a11y уровня serious/critical (кабинет партнёра)", async ({ page }) => {
  await page.goto("/?role=partner#/partner");
  await expect(page.getByRole("heading", { level: 1, name: "Мій заклад" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
