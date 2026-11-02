// Блок 6: «Стати партнером» → редактор (поля, график, фото) → «Надіслати на модерацію»; приглашение сотрудника
// по start_param inv_<токен> → «Прийняти» → кабинет. api не поднят — support/partner-mock.ts.
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";
import { INVITE_TOKEN } from "../../support/partner-mock.js";

const CONSENTS = [
  { kind: "terms", version: "2026-11-01-draft" },
  { kind: "privacy", version: "2026-11-01-draft" },
];
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////2Q==",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

test("онбординг → редактор → отправка на модерацию; a11y", async ({ page }) => {
  const state = apiMockState.get(page)!;
  state.consents = [...CONSENTS];
  await page.goto("/#/profile");
  const entry = page.getByTestId("partner-entry");
  await entry.getByRole("link", { name: "Стати партнером" }).click();

  // P12: шаблон, категория, название.
  await expect(page.getByRole("heading", { level: 1, name: "Стати партнером" })).toBeVisible();
  await page.getByRole("radio", { name: "Готель / садиба" }).check();
  await page.getByLabel("Назва закладу").fill("Садиба «Смерека»");
  await expectNoSeriousA11yViolations(page);
  await page.getByRole("button", { name: "Створити заклад" }).click();

  // P06: черновик, незаполненные поля шаблона.
  await expect(page.getByRole("heading", { level: 1, name: "Садиба «Смерека»" })).toBeVisible();
  await expect(page.getByTestId("place-status")).toHaveText("Чернетка");
  await expect(page.getByTestId("missing-fields")).toHaveText(
    "Для модерації заповніть: Адреса, Телефон, Графік роботи, Фото",
  );
  await expect(page.getByRole("button", { name: "Надіслати на модерацію" })).toBeDisabled();
  await expectNoSeriousA11yViolations(page);

  await page.getByLabel("Адреса").fill("Косів, вул. Ринкова, 1");
  await page.getByLabel("Телефон").fill("+380501112233");
  // Сохранение графика (updatedAt меняется) не теряет несохранённые правки основной формы.
  await page.getByRole("button", { name: "Додати інтервал" }).click();
  await page.getByRole("button", { name: "Зберегти графік" }).click();
  await expect(page.getByTestId("schedule-message")).toHaveText("Графік збережено.");
  await expect(page.getByTestId("missing-fields")).toHaveText(
    "Для модерації заповніть: Адреса, Телефон, Фото",
  );
  await expect(page.getByLabel("Адреса")).toHaveValue("Косів, вул. Ринкова, 1");
  await expect(page.getByLabel("Телефон")).toHaveValue("+380501112233");
  await page.getByRole("button", { name: "Зберегти", exact: true }).click();
  await expect(page.getByTestId("missing-fields")).toHaveText("Для модерації заповніть: Фото");
  await expect(page.getByTestId("schedule-rows").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("schedule-message")).toHaveText("Графік збережено.");

  await page.getByLabel("Опис фото (для незрячих)").fill("Фасад садиби");
  await page
    .getByLabel("Файл (JPEG, PNG або WebP)")
    .setInputFiles({ name: "facade.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await page.getByRole("button", { name: "Завантажити фото" }).click();
  await expect(page.getByTestId("photos").getByRole("img", { name: "Фасад садиби" })).toBeVisible();
  await expect(page.getByTestId("missing-fields")).toHaveText("Усі обов'язкові поля заповнено.");

  await page.getByLabel("Погоджуюся з умовами для партнерів").check();
  await page
    .getByLabel("Коментар для модератора (як підтвердити право керувати закладом)")
    .fill("Телефонуйте");
  await page.getByRole("button", { name: "Надіслати на модерацію" }).click();
  await expect(page.getByTestId("place-status")).toHaveText("На модерації");
  await expect(page.getByTestId("editor-readonly")).toBeVisible();
  expect(state.partner.submitNote).toBe("Телефонуйте");
  await expectNoSeriousA11yViolations(page);

  // P01: статус в кабинете, переключатель режима.
  await page.getByRole("link", { name: "До кабінету" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Кабінет партнера" })).toBeVisible();
  await expect(page.getByTestId("partner-place").getByTestId("place-status")).toHaveText("На модерації");
  await expect(page.getByRole("link", { name: "Співробітники" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test.describe("приглашение сотрудника", () => {
  test.use({ telegram: { startParam: `inv_${INVITE_TOKEN}` } });

  test("start_param inv_<токен> → P14 → «Прийняти» → кабинет; a11y", async ({ page }) => {
    const state = apiMockState.get(page)!;
    state.consents = [...CONSENTS];
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Запрошення до закладу" })).toBeVisible();
    await expect(page.getByTestId("invite-preview")).toContainText(
      "Вас запрошено як працівник до «Садиба «Під Смерекою»».",
    );
    // Контекст — регион по умолчанию, не скан QR.
    expect(state.contextCalls).toBe(1);
    await expectNoSeriousA11yViolations(page);
    await page.getByRole("button", { name: "Прийняти" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Кабінет партнера" })).toBeVisible();
    await expect(page.getByTestId("partner-org")).toContainText("Ваша роль: працівник");
    // Працівник: без редактора и сотрудников.
    await expect(page.getByRole("link", { name: "Редагувати заклад" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Співробітники" })).toHaveCount(0);
    expect(state.partner.acceptedInvite).toBe(true);
    await expectNoSeriousA11yViolations(page);
  });
});
