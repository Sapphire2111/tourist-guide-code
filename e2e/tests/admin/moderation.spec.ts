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
  await expect(page.getByText("Шаблон: Кафе")).toBeVisible();
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

test("можливі дублікати: заметний блок зі ссылкою на місце, відстанню й джерелом", async ({ page }) => {
  const state = adminMockState.get(page)!;
  state.moderationDuplicates.push({
    id: "00000000-0000-4000-8000-000000000777",
    name: { uk: "Кафе Говерла (Google)" },
    status: "published",
    source: "google",
    distanceMeters: 42.4,
  });
  await login(page, `/#/moderation/${CASE_ID}`);
  const block = page.getByRole("region", { name: "Можливі дублікати" });
  await expect(block.getByRole("link", { name: "Кафе Говерла (Google)" })).toHaveAttribute(
    "href",
    /#\/places\/00000000-0000-4000-8000-000000000777/,
  );
  await expect(block).toContainText("імпорт Google");
  await expect(block).toContainText("42 м");
});

test("заявка своєї організації: позначка в черзі, форм рішення немає, пояснення є", async ({ page }) => {
  const state = adminMockState.get(page)!;
  state.moderationCases[0]!.ownOrganization = true;
  await login(page, "/#/moderation");
  await expect(page.getByText("· Ваша організація")).toBeVisible();
  await page.getByRole("link", { name: "Кафе Говерла" }).click();
  await expect(page.getByRole("note").filter({ hasText: "Ваша організація" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Схвалити" })).toHaveCount(0);
});

test("шаблон — назва, рішення — з іменем того, хто вирішив", async ({ page }) => {
  await login(page, `/#/moderation/${CASE_ID}`);
  await expect(page.getByText("Шаблон: Кафе")).toBeVisible();
  const form = page.getByRole("form", { name: "Відхилити" });
  await form.getByLabel("Причина відмови (побачить партнер)").fill("Дубль");
  await form.getByRole("button", { name: "Відхилити" }).click();
  await expect(page.getByText(/admin@example\.com/)).toBeVisible();
});

test("партнерське місце, що ще не публікувалось: у чернетці немає «Опублікувати», з архіву — зрозуміла відмова", async ({
  page,
}) => {
  const state = adminMockState.get(page)!;
  const base = { ...state.places[0]!, organizationId: "00000000-0000-4000-8000-000000000903" };
  state.places.push({ ...base, id: "00000000-0000-4000-8000-000000000888", status: "draft" });
  state.places.push({ ...base, id: "00000000-0000-4000-8000-000000000889", status: "archived" });
  await login(page, "/#/places/00000000-0000-4000-8000-000000000888");
  await expect(page.getByRole("button", { name: "Перевірити готовність" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Опублікувати" })).toHaveCount(0);

  await page.goto("/#/places/00000000-0000-4000-8000-000000000889");
  await page.getByRole("button", { name: "Опублікувати" }).click();
  await expect(page.getByRole("alert")).toHaveText("Заклад партнера публікується лише через модерацію.");
});

test("місце на модерації: немає «До архіву» й «Опублікувати»", async ({ page }) => {
  const state = adminMockState.get(page)!;
  state.places.push({
    ...state.places[0]!,
    id: "00000000-0000-4000-8000-000000000890",
    status: "pending_moderation",
    organizationId: "00000000-0000-4000-8000-000000000903",
  });
  await login(page, "/#/places/00000000-0000-4000-8000-000000000890");
  await expect(page.getByRole("button", { name: "Перевірити готовність" })).toBeVisible();
  await expect(page.getByRole("button", { name: "До архіву" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Опублікувати" })).toHaveCount(0);
});
