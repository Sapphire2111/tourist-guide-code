// Правки проверки 3C: загрузка фото с alt → превью без перезагрузки; смена региона SUPERADMIN; переходы статуса.
import { adminMockState } from "../../support/admin-api-mock.js";
import { expect, login, test } from "../../support/admin-fixtures.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("фото: проверка типа до загрузки; загрузка с alt → превью появляется само, поле файла сброшено", async ({
  page,
}) => {
  await login(page, "/#/places");
  await page.getByRole("link", { name: "Водоспад Пробій" }).click();
  const add = page.getByRole("form", { name: "Додати фото" });
  const file = add.getByLabel(/Файл/);
  await add
    .getByRole("group", { name: "Alt-текст (опис фото)" })
    .getByLabel("Українською")
    .fill("Водоспад узимку");

  await file.setInputFiles({ name: "x.gif", mimeType: "image/gif", buffer: PNG });
  await add.getByRole("button", { name: "Завантажити" }).click();
  await expect(add.getByRole("alert")).toHaveText("Дозволені лише фото JPEG, PNG або WebP.");

  await file.setInputFiles({ name: "falls.png", mimeType: "image/png", buffer: PNG });
  await add.getByRole("button", { name: "Завантажити" }).click();
  const photos = page.getByRole("region", { name: "Фото" });
  await expect(photos.getByText("Обкладинка")).toBeVisible();
  await expect(photos.getByRole("img", { name: "Водоспад узимку" })).toBeVisible({ timeout: 10_000 });
  await expect(add.getByLabel(/Файл/)).toHaveValue("");
});

test("переходы: неопубликованный черновик — «Видалити чернетку» вместо архива; архив — после публикации", async ({
  page,
}) => {
  await login(page, "/#/places/new");
  const form = page.getByRole("form", { name: "Дані місця" });
  await form.getByRole("group", { name: "Назва" }).getByLabel("Українською").fill("Чернетка");
  await form.getByLabel("Категорія").selectOption({ label: "Релакс" });
  await form.getByRole("button", { name: "Зберегти" }).click();
  const status = page.getByRole("region", { name: /Статус: Чернетка/ });
  await expect(status.getByRole("button", { name: "До архіву" })).toHaveCount(0);
  page.once("dialog", (d) => void d.accept());
  await status.getByRole("button", { name: "Видалити чернетку" }).click();
  await expect(page).toHaveURL(/#\/places$/);
  await expect(page.getByRole("link", { name: "Чернетка" })).toHaveCount(0);

  await page.goto("/#/places");
  await page.getByRole("link", { name: "Водоспад Пробій" }).click();
  const published = page.getByRole("region", { name: /Статус: Опубліковано/ });
  await published.getByRole("button", { name: "До архіву" }).click();
  const archived = page.getByRole("region", { name: /Статус: В архіві/ });
  await expect(archived).toBeVisible();
  await expect(archived.getByRole("button", { name: "Призупинити" })).toHaveCount(0);
  await expect(archived.getByRole("button", { name: "До архіву" })).toHaveCount(0);
});

test("SUPERADMIN: регион применяется кнопкой «Застосувати», одна PUT", async ({ page }) => {
  const state = adminMockState.get(page)!;
  state.platform = true;
  state.activeRegionId = null;
  await login(page);
  await expect(page.getByRole("note")).toContainText("Оберіть регіон");
  const picker = page.getByLabel("Регіон роботи");
  await picker.selectOption({ label: "Регіон Б" });
  expect(state.regionChoices).toHaveLength(0);
  await page.getByRole("complementary").getByRole("button", { name: "Застосувати" }).click();
  await expect(page.getByRole("note")).toHaveCount(0);
  expect(state.regionChoices).toEqual([{ regionId: "00000000-0000-4000-8000-0000000000a2" }]);
  await expect(picker).toHaveValue("00000000-0000-4000-8000-0000000000a2");
});
