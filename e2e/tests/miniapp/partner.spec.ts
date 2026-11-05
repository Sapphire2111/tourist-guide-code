// Блок 6: «Стати партнером» → редактор (поля, график, фото) → «Надіслати на перевірку»; приглашение сотрудника
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
  const historyBefore = await page.evaluate(() => window.history.length);
  await page.getByRole("button", { name: "Створити заклад" }).click();

  // P06: черновик, незаполненные поля шаблона.
  await expect(page.getByRole("heading", { level: 1, name: "Садиба «Смерека»" })).toBeVisible();
  await expect(page.getByTestId("place-status")).toHaveText("Не опубліковано");
  // Форма создания заменена: «Назад» с черновика не вернёт на неё (второе заведение).
  expect(await page.evaluate(() => window.history.length)).toBe(historyBefore);
  // Секции-аккордеон: основное открыто, фото и часы — раскрыты, потому что их ещё нужно заполнить; «Додатково» свёрнуто.
  const needed = page.getByTestId("missing-fields");
  for (const f of ["Адреса", "Телефон", "Графік роботи", "Фото"])
    await expect(needed.getByRole("button", { name: f })).toBeVisible();
  await expect(page.getByRole("button", { name: "Надіслати на перевірку" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Додатково" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#basic")).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByLabel("Адреса").fill("Косів, вул. Ринкова, 1");
  await page.getByLabel("Телефон").fill("+380501112233");
  // Часы — чипом «Пн–Пт»; правки основной секции и графика сохраняются одной кнопкой.
  await page.getByRole("button", { name: "Пн–Пт", exact: true }).click();
  await expect(page.getByTestId("editor-unsaved")).toBeVisible();
  // Ещё не сохранено, но «Ще потрібно» уже учитывает ввод.
  await expect(needed).not.toContainText("Адреса");
  await expect(needed).not.toContainText("Графік роботи");
  await page.getByRole("button", { name: "Зберегти", exact: true }).click();
  await expect(page.getByTestId("editor-message")).toHaveText("Зміни збережено.");
  await expect(page.getByTestId("editor-unsaved")).toHaveCount(0);
  await expect(page.getByLabel("Адреса")).toHaveValue("Косів, вул. Ринкова, 1");
  expect(state.partner.places[0]!.weekly).toHaveLength(5);
  await expect(needed).toContainText("Фото");

  // Фото: подпись, «Додати фото» — загрузка сразу без отдельной кнопки.
  await page.getByLabel("Підпис до фото").fill("Фасад садиби");
  await page
    .getByTestId("photo-input")
    .setInputFiles({ name: "facade.jpg", mimeType: "image/jpeg", buffer: JPEG });
  await expect(page.getByTestId("photos").getByRole("img", { name: "Фасад садиби" })).toBeVisible();
  await expect(page.getByTestId("photos").getByText("Обкладинка")).toBeVisible();
  await expect(needed).toHaveText("Усі обов'язкові поля заповнено.");
  await expectNoSeriousA11yViolations(page);

  // Удаление фото — только после подтверждения.
  await page.getByRole("button", { name: "Видалити фото: Фасад садиби" }).click();
  await expect(page.getByRole("alertdialog", { name: "Видалити це фото?" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole("button", { name: "Скасувати" }).click();
  await expect(page.getByTestId("photos").getByRole("img", { name: "Фасад садиби" })).toBeVisible();

  // Модерация внизу: условия и необязательный комментарий.
  await page.getByLabel("Погоджуюся з умовами для партнерів").check();
  await page.getByText("Додати коментар для модератора").click();
  await page
    .getByLabel("Коментар для модератора (як підтвердити право керувати закладом)")
    .fill("Телефонуйте");
  await page.getByRole("button", { name: "Надіслати на перевірку" }).click();
  await expect(page.getByTestId("place-status")).toHaveText("На перевірці");
  await expect(page.getByTestId("editor-readonly")).toBeVisible();
  expect(state.partner.submitNote).toBe("Телефонуйте");
  await expectNoSeriousA11yViolations(page);

  // P01: статус в кабинете, переключатель режима.
  // Назад: в Telegram — только нативная BackButton, текстовой ссылки «← Мій заклад» нет (иначе «Назад» двоится).
  await expect(page.getByRole("link", { name: "← Мій заклад" })).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { __telegramPress(b: string): void }).__telegramPress("BackButton"),
  );
  // Нативная «Назад» идёт по истории приложения: вход был из профиля.
  await expect(page.getByRole("heading", { level: 1, name: "Профіль" })).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "#/partner";
  });
  await expect(page.getByRole("heading", { level: 1, name: "Мій заклад" })).toBeVisible();
  await expect(page.getByTestId("partner-place").getByTestId("place-status")).toHaveText("На перевірці");
  await expect(page.getByRole("link", { name: "Співробітники" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Профиль → карточка «Мій заклад» (название и статус) → кабинет.
  await page.goto("/#/profile");
  const cabinetEntry = page.getByTestId("partner-entry");
  await expect(cabinetEntry.getByTestId("partner-entry-status")).toHaveText("На перевірці");
  await cabinetEntry.getByRole("link", { name: "Мій заклад" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Мій заклад" })).toBeVisible();
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

    await expect(page.getByRole("heading", { level: 1, name: "Мій заклад" })).toBeVisible();
    await expect(page.getByTestId("partner-org")).toContainText("Ваша роль: працівник");
    // Працівник: без редактора и сотрудников.
    await expect(page.getByRole("link", { name: "Редагувати заклад" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Співробітники" })).toHaveCount(0);
    expect(state.partner.acceptedInvite).toBe(true);
    await expectNoSeriousA11yViolations(page);
  });
});
