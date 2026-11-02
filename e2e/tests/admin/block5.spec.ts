// Блок 5 в админке (на моках api): модуль готелю места, персонал, сценарии «Мій план».
import { adminMockState } from "../../support/admin-api-mock.js";
import { expect, login, test } from "../../support/admin-fixtures.js";

test("модуль готелю: правила, Wi-Fi, часы приёма и услуга с SLA сохраняются; SLA вне диапазона не уходит", async ({
  page,
}) => {
  const state = adminMockState.get(page)!;
  await login(page, "/#/places");
  await page.getByRole("link", { name: "Готель Карпати" }).click();
  const host = page.getByRole("region", { name: "Модуль готелю" });
  await expect(host.getByText("Модуль ще не налаштовано")).toBeVisible();
  const form = host.getByRole("form", { name: "Модуль готелю" });

  await form.getByLabel("Модуль увімкнено").check();
  await form.getByLabel("Wi-Fi: назва мережі").fill("Hotel-Guest");
  await form.getByLabel("Wi-Fi: пароль").fill("secret-123");
  await form.getByLabel("Телефон рецепції (+380…)").fill("+380501234567");
  await form.getByLabel("Прийом заявок з").fill("08:00");
  await form.getByLabel("Прийом заявок до").fill("22:00");

  await form.getByRole("button", { name: "Додати розділ" }).click();
  await form.getByLabel("Тип розділу 1").selectOption({ label: "Правила" });
  await form
    .getByRole("group", { name: "Заголовок розділу 1" })
    .getByLabel("Українською")
    .fill("Правила проживання");
  await form
    .getByRole("group", { name: "Текст розділу 1" })
    .getByLabel("Українською")
    .fill("Тиша після 23:00.");

  await form.getByRole("button", { name: "Додати послугу" }).click();
  await form.getByLabel("Код послуги (латиницею) 1").fill("cleaning");
  await form
    .getByRole("group", { name: "Назва послуги 1" })
    .getByLabel("Українською")
    .fill("Прибирання номера");
  await form.getByLabel("SLA, хвилин 1").fill("1");
  await form.getByRole("button", { name: "Зберегти модуль готелю" }).click();
  await expect(form.getByRole("alert")).toHaveText("SLA — ціле число хвилин від 5 до 1440.");
  expect(state.hostPuts).toHaveLength(0);

  await form.getByLabel("SLA, хвилин 1").fill("45");
  await form.getByRole("button", { name: "Зберегти модуль готелю" }).click();
  await expect(form.getByRole("status")).toHaveText("Збережено.");
  expect(state.hostPuts).toHaveLength(1);
  expect(state.hostPuts[0]).toMatchObject({
    enabled: true,
    wifiSsid: "Hotel-Guest",
    wifiPassword: "secret-123",
    receptionPhone: "+380501234567",
    hours: { from: "08:00", to: "22:00" },
    sections: [{ kind: "rules", title: { uk: "Правила проживання" }, content: { uk: "Тиша після 23:00." } }],
    services: [{ code: "cleaning", title: { uk: "Прибирання номера" }, slaMinutes: 45, enabled: true }],
  });

  // После перезагрузки настройки на месте.
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Модуль готелю" }).getByLabel("Wi-Fi: назва мережі"),
  ).toHaveValue("Hotel-Guest");
});

test("модуль готелю: часы приёма только парой", async ({ page }) => {
  const state = adminMockState.get(page)!;
  await login(page, "/#/places");
  await page.getByRole("link", { name: "Готель Карпати" }).click();
  const form = page.getByRole("form", { name: "Модуль готелю" });
  await form.getByLabel("Прийом заявок з").fill("08:00");
  await form.getByRole("button", { name: "Зберегти модуль готелю" }).click();
  await expect(form.getByRole("alert")).toContainText("обидва значення");
  expect(state.hostPuts).toHaveLength(0);
});

test("персонал: назначить по username и по Telegram id, дубль и неизвестный id — ошибка, снять", async ({
  page,
}) => {
  await login(page, "/#/places");
  await page.getByRole("link", { name: "Готель Карпати" }).click();
  const staff = page.getByRole("region", { name: "Персонал закладу" });
  await expect(staff.getByText("Персоналу ще не призначено.")).toBeVisible();
  const form = staff.getByRole("form", { name: "Призначити співробітника" });

  await form.getByLabel("Шукати за").selectOption({ label: "Telegram username" });
  await form.getByLabel(/^Значення/).fill("ab");
  await form.getByRole("button", { name: "Призначити співробітника" }).click();
  await expect(form.getByRole("alert")).toContainText("Вкажіть коректний Telegram id");

  await form.getByLabel(/^Значення/).fill("@hotel_staff");
  await form.getByRole("button", { name: "Призначити співробітника" }).click();
  await expect(staff.getByRole("row", { name: /@hotel_staff/ })).toContainText("Співробітник");

  await form.getByLabel(/^Значення/).fill("@hotel_staff");
  await form.getByRole("button", { name: "Призначити співробітника" }).click();
  await expect(form.getByRole("alert")).toBeVisible();

  await form.getByLabel("Шукати за").selectOption({ label: "Telegram id" });
  await form.getByLabel(/^Значення/).fill("404404");
  await form.getByRole("button", { name: "Призначити співробітника" }).click();
  await expect(form.getByRole("alert")).toBeVisible();

  await form.getByLabel(/^Значення/).fill("123456789");
  await form.getByLabel("Роль").selectOption({ label: "Власник" });
  await form.getByRole("button", { name: "Призначити співробітника" }).click();
  await expect(staff.getByRole("row", { name: /123456789/ })).toContainText("Власник");

  const dialogs: string[] = [];
  page.once("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await staff.getByRole("button", { name: /^Зняти: .*@hotel_staff/ }).click();
  await expect(staff.getByRole("row", { name: /@hotel_staff/ })).toBeVisible();
  expect(dialogs[0]).toContain("Зняти співробітника");
  page.once("dialog", (d) => void d.accept());
  await staff.getByRole("button", { name: /^Зняти: .*@hotel_staff/ }).click();
  await expect(staff.getByRole("row", { name: /@hotel_staff/ })).toHaveCount(0);
  await expect(staff.getByRole("row", { name: /123456789/ })).toBeVisible();
});

test("обычное место (не готель): секций модуля и персонала нет", async ({ page }) => {
  await login(page, "/#/places");
  await page.getByRole("link", { name: "Водоспад Пробій" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Графік роботи" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Модуль готелю" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Персонал закладу" })).toHaveCount(0);
});

test("сценарии: создание с пунктами по дням и альтернативой, правка, публикация", async ({ page }) => {
  const state = adminMockState.get(page)!;
  await login(page, "/#/scenarios");
  await expect(page.getByRole("heading", { level: 1, name: "Сценарії «Мій план»" })).toBeVisible();
  await page.getByRole("link", { name: "Новий сценарій" }).click();

  const form = page.getByRole("form", { name: "Новий сценарій" });
  await form.getByRole("button", { name: "Зберегти" }).click();
  // Пустая форма не уходит: браузерная проверка обязательных полей.
  expect(state.scenarioWrites).toHaveLength(0);

  await form.getByLabel(/Код \(латиницею\)/).fill("day-in-yaremche");
  await form.getByRole("group", { name: "Назва" }).getByLabel("Українською").fill("День у Яремче");
  await form.getByLabel(/Днів/).fill("2");
  await form.getByLabel("З дітьми").check();
  await form.getByRole("button", { name: "Зберегти" }).click();
  await expect(form.getByRole("alert")).toHaveText("Додайте хоча б один пункт.");

  await form.getByRole("button", { name: "Додати пункт: День 1" }).click();
  await form.getByLabel(/^Місце 1\.1/).selectOption({ label: "Водоспад Пробій" });
  await form.getByLabel("Час (ГГ:ХХ) 1.1").fill("10:00");
  await form.getByLabel("Тривалість, хв 1.1").fill("90");
  await form.getByRole("button", { name: "Додати альтернативу 1.1" }).click();
  await form.getByLabel(/^Альтернативи 1\.1\.1/).selectOption({ label: "Водоспад Пробій" });
  await form.getByRole("button", { name: "Додати пункт: День 2" }).click();
  await form.getByRole("button", { name: "Зберегти" }).click();
  await expect(form.getByRole("alert")).toHaveText("У кожному пункті оберіть місце.");

  await form.getByLabel(/^Місце 2\.1/).selectOption({ label: "Водоспад Пробій" });
  await form.getByRole("button", { name: "Зберегти" }).click();
  await expect(page.getByRole("region", { name: /Статус: Чернетка/ })).toBeVisible();
  await expect(page).toHaveURL(/#\/scenarios\/[0-9a-f-]+$/);
  expect(state.scenarioWrites[0]).toMatchObject({
    code: "day-in-yaremche",
    title: { uk: "День у Яремче" },
    days: 2,
    tags: ["kids"],
    items: [
      { dayNo: 1, timeHint: "10:00", durationMin: 90 },
      { dayNo: 2, timeHint: null, durationMin: null, alternatives: [] },
    ],
  });

  // Правка: убрать пункт второго дня и опубликовать.
  const edit = page.getByRole("form", { name: "Редагування" });
  await edit.getByRole("button", { name: "Прибрати пункт 2.1" }).click();
  await edit.getByRole("button", { name: "Зберегти" }).click();
  await expect(page.getByRole("region", { name: /Статус: Чернетка/ })).toContainText("Версія 2");
  await page
    .getByRole("region", { name: /Статус: Чернетка/ })
    .getByRole("button", { name: /^Опублікувати/ })
    .click();
  await expect(page.getByRole("region", { name: /Статус: Опубліковано/ })).toBeVisible();

  await page.getByRole("link", { name: "← Сценарії «Мій план»" }).click();
  const row = page.getByRole("row", { name: /День у Яремче/ });
  await expect(row).toContainText("Опубліковано");
  await row.getByRole("button", { name: /^Зняти з публікації/ }).click();
  await expect(row).toContainText("Чернетка");
});

test("сценарии: публикация пустого сценария — ошибка 422 в списке", async ({ page }) => {
  const state = adminMockState.get(page)!;
  state.scenarios.push({
    id: "00000000-0000-4000-8000-0000000009a1",
    regionId: "00000000-0000-4000-8000-0000000000a1",
    code: "empty",
    title: { uk: "Порожній" },
    description: null,
    days: 1,
    tags: [],
    status: "draft",
    version: 1,
    adLabel: null,
    sortOrder: 0,
    updatedAt: "2026-11-02T10:00:00Z",
    items: [],
  });
  await login(page, "/#/scenarios");
  const row = page.getByRole("row", { name: /Порожній/ });
  await row.getByRole("button", { name: /^Опублікувати/ }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(row).toContainText("Чернетка");
});

test("модератор без прав на модуль и персонал: секций и красных ошибок нет", async ({ page }) => {
  adminMockState.get(page)!.noHostAccess = true;
  await login(page, "/#/places");
  await page.getByRole("link", { name: "Готель Карпати" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Графік роботи" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Модуль готелю" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Персонал закладу" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("сценарии: уменьшение числа дней предупреждает об удалении пунктов; пустое число дней — ошибка", async ({
  page,
}) => {
  await login(page, "/#/scenarios/new");
  const form = page.getByRole("form", { name: "Новий сценарій" });
  await form.getByLabel(/Днів/).fill("2");
  await form.getByRole("button", { name: "Додати пункт: День 2" }).click();
  await form.getByLabel(/Днів/).fill("1");
  await expect(form.getByText(/Пунктів, що вийдуть за межі днів/)).toContainText("1");
  await form.getByLabel(/Днів/).fill("");
  await expect(form.getByText("Кількість днів — ціле число від 1 до 5.")).toBeVisible();
});
