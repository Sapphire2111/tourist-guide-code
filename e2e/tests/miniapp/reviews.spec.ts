// Блок 10 (флаг module.reviews): турист — рейтинг и отзывы в карточке, жалоба, «Мої бронювання» → «Залишити відгук»
// → форма (валидация, автофильтр → модерация); партнёр — P07: ответ (автофильтр ответа) и жалоба. api не поднят —
// support/bookings-mock.ts + support/reviews-mock.ts.
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState, CAFE_PLACE } from "../../support/api-mock.js";
import { bookingDto, installBookingsMock, kyiv, PARTNER_PLACE } from "../../support/bookings-mock.js";
import { expect, test } from "../../support/fixtures.js";
import { COMPLETED_BOOKING_ID, ELIGIBILITY_ID, installReviewsMock } from "../../support/reviews-mock.js";

const CONSENTS = [
  { kind: "terms", version: "2026-11-01-draft" },
  { kind: "privacy", version: "2026-11-01-draft" },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

test("карточка: «Мало відгуків», отзыв с ответом заведения, жалоба; a11y", async ({ page }) => {
  await installBookingsMock(page);
  const mock = await installReviewsMock(page);
  await page.goto(`/#/place/${CAFE_PLACE}`);
  const block = page.getByTestId("place-guest-reviews");
  await expect(block.getByTestId("reviews-rating")).toContainText("Мало відгуків");
  await expect(block.getByTestId("guest-review")).toContainText("Дуже смачна кава");
  await expect(block.getByTestId("review-response")).toContainText("Дякуємо, чекаємо знову!");
  await expectNoSeriousA11yViolations(page);

  await block.getByTestId("complain-open").click();
  await block.getByLabel("Причина").selectOption("spam");
  await block.getByTestId("complaint-send").click();
  await expect(block).toContainText("Скаргу надіслано");
  expect(mock.complaints[0]?.body).toMatchObject({ reasonCode: "spam" });
});

test("турист: завершённая бронь → «Залишити відгук» → автофильтр отправляет на модерацию", async ({
  page,
}) => {
  const state = apiMockState.get(page)!;
  state.consents = [...CONSENTS];
  const bookings = await installBookingsMock(page);
  bookings.bookings.push(
    bookingDto({
      id: COMPLETED_BOOKING_ID,
      placeId: CAFE_PLACE,
      status: "completed",
      allowedTransitions: [],
      startsAt: kyiv(-3, 12),
      endsAt: kyiv(-3, 13),
    }),
  );
  const mock = await installReviewsMock(page);
  await page.goto("/#/bookings");
  await page.getByTestId("booking-review-link").click();
  await expect(page).toHaveURL(new RegExp(`#/review/${ELIGIBILITY_ID}`));
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Відгук про «Кав'ярня «Смерека»»");

  // Валидация: без оценки не отправляется.
  await page.getByTestId("review-submit").click();
  await expect(page.getByTestId("review-message")).toContainText("Оберіть оцінку");
  await expectNoSeriousA11yViolations(page);

  await page.getByRole("radio", { name: "4 з 5" }).click();
  await page.getByLabel("Ваш відгук").fill("Гарно, деталі на t.me/x");
  await page.getByTestId("review-submit").click();
  await expect(page.getByTestId("review-message")).toContainText("Відгук на перевірці модератора");
  await expect(page.getByTestId("my-review-flags")).toContainText("посилання");
  expect(mock.submitted[0]).toMatchObject({ eligibilityId: ELIGIBILITY_ID, rating: 4 });

  // Возврат к броням: право использовано — виден статус отзыва.
  await page.goto("/#/bookings");
  await expect(page.getByTestId("booking-review-status")).toHaveText("Ваш відгук: На перевірці модератора");
});

test("партнёр: P07 — ответ (автофильтр отклоняет ссылку), затем успешный ответ; жалоба", async ({ page }) => {
  const state = apiMockState.get(page)!;
  state.consents = [...CONSENTS];
  const orgId = "00000000-0000-4000-8000-00000000a001";
  state.partner.orgs = [{ id: orgId, name: "ТОВ «Смерека»", role: "ORG_MANAGER" }];
  state.partner.places = [
    {
      id: PARTNER_PLACE,
      orgId,
      role: "ORG_MANAGER",
      status: "published",
      name: { uk: "Садиба «Під Смерекою»" },
      address: null,
      description: null,
      phone: null,
      weekly: [],
      media: [],
      moderation: null,
      version: 1,
    },
  ];
  await installBookingsMock(page);
  const mock = await installReviewsMock(page);
  await page.goto("/#/partner");
  await page.getByTestId("partner-reviews-link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Відгуки про заклад" })).toBeVisible();
  const item = page.getByTestId("partner-review");
  await expect(item).toContainText("Довго чекали на заселення.");
  await expectNoSeriousA11yViolations(page);

  await item.getByTestId("respond-open").click();
  await item.getByLabel("Відповідь закладу").fill("Деталі на https://example.com");
  await item.getByTestId("response-send").click();
  await expect(item.getByTestId("response-error")).toContainText("посилання");
  await item.getByLabel("Відповідь закладу").fill("Перепрошуємо за очікування.");
  await item.getByTestId("response-send").click();
  await expect(item.getByTestId("review-response")).toContainText("Перепрошуємо за очікування.");
  await expect(item).toContainText("Довго чекали на заселення.");
  expect(mock.responses).toHaveLength(1);

  await item.getByTestId("complain-open").click();
  await item.getByLabel("Причина").selectOption("insult");
  await item.getByTestId("complaint-send").click();
  await expect(item.getByTestId("my-complaint")).toContainText("розглядається");
});
