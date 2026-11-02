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
  await expect(page.getByTestId("role")).toHaveText("Режим: гість");
  await expect(page.getByTestId("health")).toHaveText("Сервер працює");
  expect(await telegramCalls(page)).toEqual(expect.arrayContaining(["ready", "expand"]));
  const bg = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--tg-theme-bg-color"),
  );
  expect(bg).toBe("#ffffff");
});

test("партнёр: кабинет и нативная BackButton", async ({ page }) => {
  await page.goto("/?role=partner");
  await expect(page.getByTestId("role")).toHaveText("Режим: партнер");
  await page.getByRole("link", { name: "Кабінет партнера" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Кабінет партнера" })).toBeVisible();
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
