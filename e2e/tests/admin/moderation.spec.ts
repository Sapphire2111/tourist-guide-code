// Модерація партнерів (блок 6) в админке на моках api: очередь, схвалення, повернення, відхилення, 403.
import { adminMockState } from "../../support/admin-api-mock.js";
import { expect, login, test } from "../../support/admin-fixtures.js";

const CASE_ID = "00000000-0000-4000-8000-000000000901";

test("черга: заявка «на модерації» → картка з організацією, власником і шаблоном", async ({ page }) => {
  await login(page, "/#/moderation");
  await expect(page.getByRole("link", { name: "Кафе Говерла" })).toBeVisible();
  await expect(page.getByText("ФОП Іваненко")).toBeVisible();

  await page.getByRole("link", { name: "Кафе Говерла" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Кафе Говерла" })).toBeVisible();
  await expect(page.getByText("Організація: ФОП Іваненко")).toBeVisible();
  await expect(page.getByText("Шаблон: cafe")).toBeVisible();
  await expect(page.getByText("Олена · @olena_cafe")).toBeVisible();
});

test("схвалити: без способу перевірки не йде; зі способом — рішення збережено", async ({ page }) => {
  const state = adminMockState.get(page)!;
  await login(page, `/#/moderation/${CASE_ID}`);
  const form = page.getByRole("form", { name: "Схвалити" });
  await form.getByRole("button", { name: "Схвалити" }).click();
  await expect(form.getByRole("alert")).toHaveText("Оберіть спосіб підтвердження права на заклад.");
  expect(state.moderationDecisions).toHaveLength(0);

  await form.getByLabel("Спосіб підтвердження права на заклад").selectOption({ label: "Дзвінок" });
  await form.getByLabel("Коментар").fill("Зателефонували власнику");
  await form.getByRole("button", { name: "Схвалити" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Рішення ухвалено" })).toBeVisible();
  expect(state.moderationDecisions).toEqual([
    {
      id: CASE_ID,
      decision: "approve",
      body: { verificationMethod: "phone_call", comment: "Зателефонували власнику" },
    },
  ]);

  // У черзі «на модерації» заявки вже немає, у «розглянутих» — є.
  await page
    .getByRole("link", { name: /Модерація/ })
    .first()
    .click();
  await expect(page.getByText("Заявок немає.")).toBeVisible();
  await page.getByLabel("Статус").selectOption({ label: "Розглянуті" });
  await expect(page.getByRole("link", { name: "Кафе Говерла" })).toBeVisible();
});

test("повернути на доопрацювання: причина йде партнеру", async ({ page }) => {
  const state = adminMockState.get(page)!;
  await login(page, `/#/moderation/${CASE_ID}`);
  const form = page.getByRole("form", { name: "Повернути на доопрацювання" });
  await form.getByLabel("Що виправити (побачить партнер)").fill("Додайте фото фасаду");
  await form.getByRole("button", { name: "Повернути на доопрацювання" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Рішення ухвалено" })).toBeVisible();
  await expect(page.getByText("Коментар: Додайте фото фасаду")).toBeVisible();
  expect(state.moderationDecisions[0]).toMatchObject({
    decision: "changes_requested",
    body: { reason: "Додайте фото фасаду" },
  });
});

test("відхилити без причини — помилка валідації й жодного запиту; з причиною — відхилено", async ({
  page,
}) => {
  const state = adminMockState.get(page)!;
  await login(page, `/#/moderation/${CASE_ID}`);
  const form = page.getByRole("form", { name: "Відхилити" });
  await form.getByRole("button", { name: "Відхилити" }).click();
  await expect(form.getByRole("alert")).toHaveText("Вкажіть причину — партнер її побачить.");
  expect(state.moderationDecisions).toHaveLength(0);

  await form.getByLabel("Причина відмови (побачить партнер)").fill("Не вдалося підтвердити право");
  await form.getByRole("button", { name: "Відхилити" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Рішення ухвалено" })).toBeVisible();
  expect(state.moderationDecisions[0]).toMatchObject({ decision: "reject" });
});

test("роль без права модерації: 403 — зрозумілий текст", async ({ page }) => {
  adminMockState.get(page)!.noModeration = true;
  await login(page, "/#/moderation");
  await expect(page.getByRole("alert")).toHaveText("Немає права модерувати заявки цього регіону.");
});

test("рішення вже ухвалив інший модератор: 409 — повідомлення й оновлена картка", async ({ page }) => {
  const state = adminMockState.get(page)!;
  await login(page, `/#/moderation/${CASE_ID}`);
  await expect(page.getByRole("form", { name: "Відхилити" })).toBeVisible();
  // Інший модератор встиг раніше.
  Object.assign(state.moderationCases[0]!, { status: "decided", decision: "reject", comment: "Дубль" });
  const form = page.getByRole("form", { name: "Повернути на доопрацювання" });
  await form.getByLabel("Що виправити (побачить партнер)").fill("Додайте фото");
  await form.getByRole("button", { name: "Повернути на доопрацювання" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Рішення ухвалено" })).toBeVisible();
  await expect(page.getByText("Коментар: Дубль")).toBeVisible();
});

test("картка заявки: точка з посиланням на мапу, графік і фото читабельно", async ({ page }) => {
  await login(page, `/#/moderation/${CASE_ID}`);
  await expect(page.getByRole("link", { name: /48\.45, 24\.55/ })).toHaveAttribute(
    "href",
    /openstreetmap\.org\/\?mlat=48\.45&mlon=24\.55/,
  );
  await expect(page.getByText("Пн: 09:00–18:00")).toBeVisible();
  await expect(page.getByText("обкладинка · Фасад кафе")).toBeVisible();
});

test("після схвалення повідомлення про успіх лишається видимим", async ({ page }) => {
  await login(page, `/#/moderation/${CASE_ID}`);
  const form = page.getByRole("form", { name: "Схвалити" });
  await form.getByLabel("Спосіб підтвердження права на заклад").selectOption({ label: "Документ" });
  await form.getByRole("button", { name: "Схвалити" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "Рішення ухвалено" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Заклад схвалено й опубліковано." })).toBeVisible();
});

test("картка місця на модерації: посилання веде на конкретну заявку", async ({ page }) => {
  const state = adminMockState.get(page)!;
  const placeId = state.moderationCases[0]!.placeId as string;
  state.places.push({
    ...state.places[0]!,
    id: placeId,
    status: "pending_moderation",
    name: { uk: "Кафе Говерла" },
  });
  await login(page, `/#/places/${placeId}`);
  await page.getByRole("link", { name: "Відкрити заявку на модерацію" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Кафе Говерла" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Схвалити" })).toBeVisible();
});

test("список місць: фільтр за статусом «На модерації»", async ({ page }) => {
  await login(page, "/#/places");
  await expect(page.getByLabel("Статус").locator("option", { hasText: "На модерації" })).toHaveCount(1);
});
