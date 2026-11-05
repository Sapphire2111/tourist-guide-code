// Прайс заведения (миграция 0030): партнёр — дашборд → «Прайс» → пустой прайс с примером → «+ Страви» →
// «+ Позиція» (лист: название, цена, «від», единица) → вторая позиция → ▲ → скрыть одну; турист — «Ціни» в карточке
// места: только видимые позиции. День и Ніч, a11y. api не поднят — support/price-list-mock.ts поверх общих моков.
import type { Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState, CAFE_PLACE } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";
import { installPriceListMock } from "../../support/price-list-mock.js";

const CONSENTS = [
  { kind: "terms", version: "2026-11-01-draft" },
  { kind: "privacy", version: "2026-11-01-draft" },
];
const ORG = "00000000-0000-4000-8000-00000000a001";
/** Пробелы-разделители Intl (U+00A0, U+202F) → обычный пробел. */
const norm = (s: string) => s.replace(/\s/g, " ");

/** Менеджер организации, чьё место — карточка «Кав'ярня «Смерека»» туриста. */
function asPartner(page: Page) {
  const state = apiMockState.get(page)!;
  state.consents = [...CONSENTS];
  state.partner.orgs = [{ id: ORG, name: "ТОВ «Смерека»", role: "ORG_MANAGER" }];
  state.partner.places = [
    {
      id: CAFE_PLACE,
      orgId: ORG,
      role: "ORG_MANAGER",
      status: "published",
      name: { uk: "Кав'ярня «Смерека»" },
      address: null,
      description: null,
      phone: null,
      weekly: [],
      media: [],
      moderation: null,
      version: 1,
    },
  ];
}

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

test("кабинет: прайс с нуля → позиции, ▲▼, скрытие; карточка туриста — «Ціни» без скрытых; a11y", async ({
  page,
}) => {
  asPartner(page);
  const mock = await installPriceListMock(page, CAFE_PLACE);

  await page.goto("/#/partner");
  await page.getByTestId("partner-prices-link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Прайс" })).toBeVisible();
  const empty = page.getByTestId("prices-empty");
  await expect(empty).toContainText("Банош з бринзою");
  await expectNoSeriousA11yViolations(page);

  await empty.getByRole("button", { name: "Додати розділ «Страви»" }).click();
  await expect(page.getByTestId("prices-message")).toContainText("Розділ додано.");

  const addItem = async (name: string, price: string, unit?: string, from = false) => {
    await page.getByRole("button", { name: "Додати позицію в розділ «Страви»" }).click();
    const sheet = page.getByRole("dialog", { name: "Нова позиція" });
    await expect(sheet.getByLabel("Назва")).toBeFocused();
    await sheet.getByLabel("Назва").fill(name);
    await sheet.getByLabel("Ціна, грн").fill(price);
    if (from) await sheet.getByLabel("Ціна «від» (мінімальна)").check();
    if (unit) await sheet.getByLabel("Одиниця (необов'язково)").fill(unit);
    await sheet.getByRole("button", { name: "Зберегти" }).click();
    await expect(sheet).toBeHidden();
  };
  await addItem("Банош з бринзою", "180", "за порцію");
  await page.getByRole("button", { name: "Додати позицію в розділ «Страви»" }).click();
  const sheet = page.getByRole("dialog", { name: "Нова позиція" });
  await expectNoSeriousA11yViolations(page);
  // Неверная цена — подсказка, запрос не уходит.
  await sheet.getByLabel("Назва").fill("Деруни");
  await sheet.getByLabel("Ціна, грн").fill("сто");
  await sheet.getByRole("button", { name: "Зберегти" }).click();
  await expect(sheet.getByRole("alert")).toContainText("Вкажіть ціну числом");
  await sheet.getByRole("button", { name: "Скасувати" }).click();
  await addItem("Деруни", "150", undefined, true);

  const rows = page.getByTestId("price-item");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("від 150 грн");
  await page.getByRole("button", { name: "«Деруни» вище" }).click();
  await expect(rows.first()).toContainText("Деруни");

  // Тап по позиции → лист правки → скрыть от туристов.
  await rows
    .first()
    .getByRole("button", { name: /^Деруни/ })
    .click();
  const edit = page.getByRole("dialog", { name: "Редагування позиції" });
  await expect(edit.getByLabel("Ціна, грн")).toHaveValue("150");
  await edit.getByLabel("Приховати від туристів").check();
  await edit.getByRole("button", { name: "Зберегти" }).click();
  await expect(edit).toBeHidden();
  await expect(rows.first()).toContainText("Приховано");
  expect(mock.requests).toContain(
    `PATCH /partner/places/${CAFE_PLACE}/price-list/items/${mock.items[1]!.id}`,
  );
  await expectNoSeriousA11yViolations(page);

  // Турист: «Ціни» в карточке — только видимая позиция.
  await page.goto(`/#/place/${CAFE_PLACE}`);
  const prices = page.getByTestId("place-prices");
  await expect(prices.getByRole("heading", { level: 2, name: "Ціни" })).toBeVisible();
  await expect(prices.getByTestId("place-price")).toHaveCount(1);
  expect(norm(await prices.getByTestId("place-price").innerText())).toContain("180 грн за порцію");
  await expect(prices).not.toContainText("Деруни");
  await expectNoSeriousA11yViolations(page);
});

test.describe("Ніч", () => {
  test.use({ defaultTheme: null });

  test("карточка и кабинет: «Ціни» и «Прайс» читаются в тёмной теме; a11y", async ({ page }) => {
    asPartner(page);
    const mock = await installPriceListMock(page, CAFE_PLACE);
    const section = { id: "00000000-0000-4000-8000-00000000e101", hidden: false, sortOrder: 0, version: 1 };
    mock.sections.push({ ...section, title: { uk: "Кава" } });
    for (const [i, name] of ["Еспресо", "Капучино", "Лате", "Раф", "Какао", "Чай", "Узвар"].entries())
      mock.items.push({
        id: `00000000-0000-4000-8000-00000000e2${String(i).padStart(2, "0")}`,
        sectionId: section.id,
        name: { uk: name },
        description: null,
        priceMinor: 5000 + i * 500,
        currency: "UAH",
        priceFrom: false,
        unit: null,
        hidden: false,
        sortOrder: i,
        version: 1,
        updatedAt: "2026-11-05T10:00:00.000Z",
      });
    await page.goto(`/#/place/${CAFE_PLACE}`);
    const prices = page.getByTestId("place-prices");
    await expect(prices.getByTestId("place-price")).toHaveCount(6);
    await prices.getByRole("button", { name: "Показати все (7)" }).click();
    await expect(prices.getByTestId("place-price")).toHaveCount(7);
    await expectNoSeriousA11yViolations(page);

    // Кабинет в тёмной теме: скрытая позиция (курсив + бейдж) тоже контрастна.
    mock.items[0]!.hidden = true;
    await page.goto(`/#/partner/place/${CAFE_PLACE}/prices`);
    await expect(page.getByRole("heading", { level: 1, name: "Прайс" })).toBeVisible();
    await expect(page.getByTestId("price-item")).toHaveCount(7);
    await expect(page.getByTestId("price-item").first()).toContainText("Приховано");
    await expectNoSeriousA11yViolations(page);
  });
});
