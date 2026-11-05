import { apiMockState } from "../../support/api-mock.js";
import { DEFAULT_TELEGRAM_USER, telegramCalls } from "../../support/telegram-webapp.js";
import { expect, test } from "../../support/fixtures.js";

// api в e2e не поднят: /health отвечает мок (проверяется вызов через клиент и отрисовка статуса).
test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) => route.fulfill({ json: { status: "ok" } }));
});

test("Mini App в Telegram: пользователь, тема, ready/expand, статус api", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeVisible();
  await expect(page.getByTestId("tg-user")).toHaveText(`Вітаємо, ${DEFAULT_TELEGRAM_USER.first_name}!`);
  // Роль и статус api — служебные: в боевой сборке туристу не показываются (у персонала — ниже).
  await expect(page.getByTestId("role")).toHaveCount(0);
  await expect(page.getByTestId("health")).toHaveCount(0);
  expect(await telegramCalls(page)).toEqual(
    expect.arrayContaining(["ready", "expand", "disableVerticalSwipes"]),
  );
  const bg = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--tg-theme-bg-color"),
  );
  expect(bg).toBe("#ffffff");
});

test("персонал: роль и статус api (связка фронт → api и CORS)", async ({ page }) => {
  apiMockState.get(page)!.staff = true;
  await page.goto("/");
  await expect(page.getByTestId("role")).toHaveText("Режим: гість");
  await expect(page.getByTestId("health")).toHaveText("Сервер працює");
});

test("партнёр: кабинет и нативная BackButton", async ({ page }) => {
  await page.goto("/?role=partner");
  await expect(page.getByTestId("role")).toHaveCount(0);
  await expect(page.getByTestId("partner-link")).toHaveCount(0);
  await page.goto("/?role=partner#/partner");
  await expect(page.getByRole("heading", { level: 1, name: "Мій заклад" })).toBeVisible();
  expect(await telegramCalls(page)).toEqual(
    expect.arrayContaining(["BackButton.onClick", "BackButton.show"]),
  );
  await expect(page.getByRole("button", { name: "Назад" })).toHaveCount(0);
});

test.describe("вне Telegram", () => {
  test.use({ telegram: null });

  test("открывается без пользователя, «Назад» — своя кнопка", async ({ page }) => {
    await page.goto("/#/partner");
    await expect(page.getByRole("alert")).toHaveText("Розділ доступний лише партнерам.");
    await page.getByRole("button", { name: "Назад" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Гід туриста" })).toBeVisible();
    await expect(page.getByTestId("tg-user")).toHaveCount(0);
  });
});
