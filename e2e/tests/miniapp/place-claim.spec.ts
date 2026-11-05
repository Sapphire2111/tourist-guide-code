// «Це мій заклад» (0031): карточка места → «Це мій заклад?» → одна форма (роль, телефон из Telegram, новая
// организация) → заявка на рассмотрении → «Мій заклад» показывает статус «На перевірці». api не поднят —
// support/api-mock.ts и support/partner-mock.ts.
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState, CAFE_PLACE } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";

const CONSENTS = [
  { kind: "terms", version: "2026-11-01-draft" },
  { kind: "privacy", version: "2026-11-01-draft" },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
  // requestContact (Bot API 6.9+): номер без «+», как отдаёт Telegram.
  await page.addInitScript(() => {
    const w = window as unknown as { Telegram?: { WebApp?: Record<string, unknown> } };
    if (w.Telegram?.WebApp)
      w.Telegram.WebApp.requestContact = (cb: (sent: boolean, res?: unknown) => void) =>
        cb(true, { status: "sent", responseUnsafe: { contact: { phone_number: "380671112233" } } });
  });
});

test("карточка → «Це мій заклад?» → заявка → «На перевірці» в кабинете; a11y", async ({ page }) => {
  const state = apiMockState.get(page)!;
  state.consents = [...CONSENTS];
  await page.goto(`/#/place/${CAFE_PLACE}`);
  const link = page.getByTestId("place-claim");
  await expect(link).toHaveText("Це мій заклад?");
  const box = await link.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await link.click();

  await expect(page.getByRole("heading", { level: 1, name: "Це мій заклад" })).toBeVisible();
  await expect(page.getByLabel("Назва організації")).toHaveValue("Кав'ярня «Смерека»");
  await expectNoSeriousA11yViolations(page);
  await page.getByLabel("Власник").check();
  await page.getByTestId("claim-share-contact").click();
  await expect(page.getByLabel("Ваш телефон для зв'язку")).toHaveValue("+380671112233");
  await page.getByLabel("Коментар модератору (необов'язково)").fill("Дзвоніть після 18:00");
  await page.getByTestId("claim-submit").click();

  await expect(page.getByTestId("claim-pending").getByTestId("claim-status")).toHaveText("На перевірці");
  expect(state.partner.claims).toHaveLength(1);
  expect(state.partner.claims[0]).toMatchObject({
    placeId: CAFE_PLACE,
    role: "owner",
    organizationName: "Кав'ярня «Смерека»",
  });
  await expectNoSeriousA11yViolations(page);

  await page.getByRole("link", { name: "До розділу «Мій заклад»" }).click();
  const mine = page.getByTestId("my-claims");
  await expect(mine.getByTestId("my-claim")).toHaveCount(1);
  await expect(mine.getByTestId("claim-status")).toHaveText("На перевірці");
  await expectNoSeriousA11yViolations(page);

  // Повторно открыть форму: вместо неё — статус заявки, второй заявки не будет.
  await page.goto(`/#/partner/claim/${CAFE_PLACE}`);
  await expect(page.getByTestId("claim-pending")).toContainText("Ваша заявка на цей заклад уже на розгляді.");
  await expect(page.getByTestId("claim-submit")).toHaveCount(0);
});
