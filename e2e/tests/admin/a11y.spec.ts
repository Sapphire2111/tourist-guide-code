import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";

for (const path of ["/", "/#/audit", "/#/users"]) {
  test(`админка ${path}: нет нарушений a11y уровня serious/critical`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
  });
}
