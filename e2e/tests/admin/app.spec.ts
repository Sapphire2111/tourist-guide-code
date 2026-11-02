import { adminMockState } from "../../support/admin-api-mock.js";
import { expect, login, test } from "../../support/admin-fixtures.js";

test("вход: неверный пароль — одно сообщение; верный — меню переключает разделы", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Логін").fill("admin@example.com");
  await page.getByLabel("Пароль").fill("wrong-password");
  await page.getByRole("button", { name: "Увійти" }).click();
  await expect(page.getByRole("alert")).toHaveText("Невірний логін або пароль.");

  await login(page);
  const nav = page.getByRole("navigation", { name: "Розділи" });
  for (const name of ["Місця", "QR-коди", "Екстрені контакти", "Аудит", "Регіон"]) {
    await nav.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(nav.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
  }
  await page.getByRole("button", { name: "Вийти" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Вхід до адмінки" })).toBeVisible();
});

test("места: список → создание → публикация с ошибкой 422 → исправление → опубликовано", async ({ page }) => {
  await login(page, "/#/places");
  await expect(page.getByRole("link", { name: "Водоспад Пробій" })).toBeVisible();

  await page.getByRole("link", { name: "Нове місце" }).click();
  const form = page.getByRole("form", { name: "Дані місця" });
  await form.getByRole("group", { name: "Назва" }).getByLabel("Українською").fill("Кав'ярня «Гуцулка»");
  await form.getByLabel("Категорія").selectOption({ label: "Де відпочити" });
  await form.getByRole("button", { name: "Зберегти" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Кав'ярня «Гуцулка»" })).toBeVisible();
  await expect(page).toHaveURL(/#\/places\/[0-9a-f-]+$/);

  const status = page.getByRole("region", { name: /Статус: Чернетка/ });
  await status.getByRole("button", { name: "Опублікувати" }).click();
  const alert = status.getByRole("alert");
  await expect(alert).toContainText("Місце не можна опублікувати");
  await expect(alert).toContainText("Немає опису українською.");
  await expect(alert).toContainText("Немає адреси українською.");
  await expect(alert).toContainText("Не вказано точку на мапі");

  await form
    .getByRole("group", { name: "Опис" })
    .getByLabel("Українською")
    .fill("Затишна кав'ярня в центрі.");
  await form.getByRole("group", { name: "Адреса" }).getByLabel("Українською").fill("Яремче, вул. Свободи, 1");
  await form.getByLabel("Широта").fill("48.4475");
  await form.getByLabel("Довгота").fill("24.5626");
  await form.getByRole("button", { name: "Зберегти" }).click();
  await expect(form.getByRole("status")).toHaveText("Збережено.");

  await status.getByRole("button", { name: "Опублікувати" }).click();
  await expect(page.getByRole("region", { name: /Статус: Опубліковано/ })).toBeVisible();
  expect(adminMockState.get(page)?.publishCalls).toBe(2);

  await page.getByRole("link", { name: "← Місця" }).click();
  await page.getByLabel("Пошук за назвою").fill("гуцулка");
  await page.getByRole("button", { name: "Застосувати" }).click();
  const row = page.getByRole("row", { name: /Гуцулка/ });
  await expect(row).toContainText("Опубліковано");
  await expect(page.getByRole("link", { name: "Водоспад Пробій" })).toHaveCount(0);
});

test("QR: создание отеля → печать → деактивация", async ({ page }) => {
  await login(page, "/#/qr");
  const form = page.getByRole("form", { name: "Новий QR-код" });
  await form.getByLabel("Тип").selectOption({ label: "Готель" });
  await form.getByLabel("Підпис").fill("Ресепшн готелю");
  await form
    .getByRole("group", { name: "Про заклад (для готелю)" })
    .getByRole("group", { name: "Назва" })
    .getByLabel("Українською")
    .fill("Тестовий готель");
  await form.getByRole("button", { name: "Створити" }).click();
  await expect(form.getByRole("status")).toContainText("QR-код створено: e2eQr0000001");

  const row = page.getByRole("row", { name: /Ресепшн готелю/ });
  await expect(row).toContainText("Готель");
  await row.getByRole("link", { name: "Друк: Ресепшн готелю" }).click();
  await expect(page.getByRole("img", { name: "QR-код «Ресепшн готелю»" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "https://t.me/tourist_guide_bot?startapp=e2eQr0000001" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Друкувати" })).toBeVisible();

  await page.getByRole("link", { name: "← QR-коди" }).click();
  await page
    .getByRole("row", { name: /Ресепшн готелю/ })
    .getByRole("button", { name: "Деактивувати: Ресепшн готелю" })
    .click();
  await expect(page.getByRole("row", { name: /Ресепшн готелю/ })).toContainText("Деактивований");
  await expect(page.getByRole("link", { name: "Друк: Ресепшн готелю" })).toHaveCount(0);
});
