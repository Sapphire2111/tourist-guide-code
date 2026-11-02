// Фикстура Playwright для админки: мок api (support/admin-api-mock.ts) с состоянием на тест;
// `login(page)` — вход тестовым админом.
import { test as base, expect, type Page } from "@playwright/test";
import { ADMIN_LOGIN, ADMIN_PASSWORD, installAdminApiMock } from "./admin-api-mock.js";

export const test = base.extend({
  page: async ({ page }, use) => {
    await installAdminApiMock(page);
    await use(page);
  },
});

/** Открыть админку и войти; после входа — меню разделов. */
export async function login(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Логін").fill(ADMIN_LOGIN);
  await page.getByLabel("Пароль").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Увійти" }).click();
  await expect(page.getByRole("navigation", { name: "Розділи" })).toBeVisible();
}

export { expect };
