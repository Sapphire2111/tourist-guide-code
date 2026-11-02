import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { expect, login, test } from "../../support/admin-fixtures.js";

test("вход: нет нарушений a11y уровня serious/critical", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Вхід до адмінки" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

for (const [path, heading] of [
  ["/#/region", "Регіон"],
  ["/#/localities", "Населені пункти"],
  ["/#/taxonomy", "Категорії та теги"],
  ["/#/places", "Місця"],
  ["/#/places/new", "Місця"],
  ["/#/moderation", "Модерація"],
  ["/#/qr", "QR-коди"],
  ["/#/scenarios", "Сценарії «Мій план»"],
  ["/#/scenarios/new", "Сценарії «Мій план»"],
  ["/#/emergency", "Екстрені контакти"],
  ["/#/audit", "Аудит"],
] as const) {
  test(`админка ${path}: нет нарушений a11y уровня serious/critical`, async ({ page }) => {
    await login(page, path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText("Завантаження…")).toHaveCount(0);
    await expectNoSeriousA11yViolations(page);
  });
}

test("карточка места и печать QR: нет нарушений a11y", async ({ page }) => {
  await login(page, "/#/places");
  await page.getByRole("link", { name: "Водоспад Пробій" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Графік роботи" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByRole("navigation").getByRole("link", { name: "QR-коди" }).click();
  const form = page.getByRole("form", { name: "Новий QR-код" });
  await form.getByLabel("Тип").selectOption({ label: "Регіон" });
  await form.getByLabel("Підпис").fill("Стенд на вокзалі");
  await form.getByRole("button", { name: "Створити" }).click();
  await page.getByRole("link", { name: "Друк: Стенд на вокзалі" }).click();
  await expect(page.getByRole("img", { name: "QR-код «Стенд на вокзалі»" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test("карточка места: модуль готелю и персонал без нарушений a11y", async ({ page }) => {
  await login(page, "/#/places");
  await page.getByRole("link", { name: "Готель Карпати" }).click();
  const host = page.getByRole("form", { name: "Модуль готелю" });
  await host.getByRole("button", { name: "Додати розділ" }).click();
  await host.getByRole("button", { name: "Додати послугу" }).click();
  await expect(page.getByRole("region", { name: "Персонал закладу" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
