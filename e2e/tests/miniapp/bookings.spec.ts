// Блок 7 (флаг module.bookings): турист — карточка «Доступно зараз» → C07 слот → C08 телефон из Telegram и
// обязательная согласие → «Мої бронювання» → ответ на альтернативу; партнёр — P04 брони дня → P05 подтверждение,
// ручная запись, ресурсы (409 version → обновить, ручной статус с TTL). api не поднят — support/bookings-mock.ts.
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState, CAFE_PLACE } from "../../support/api-mock.js";
import { bookingDto, installBookingsMock, kyiv, PARTNER_PLACE } from "../../support/bookings-mock.js";
import { expect, test } from "../../support/fixtures.js";

const CONSENTS = [
  { kind: "terms", version: "2026-11-01-draft" },
  { kind: "privacy", version: "2026-11-01-draft" },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
  // requestContact (Bot API 6.9+): пользователь делится номером — номер без «+», как отдаёт Telegram.
  await page.addInitScript(() => {
    const w = window as unknown as { Telegram?: { WebApp?: Record<string, unknown> } };
    if (w.Telegram?.WebApp)
      w.Telegram.WebApp.requestContact = (cb: (sent: boolean, res?: unknown) => void) =>
        cb(true, { status: "sent", responseUnsafe: { contact: { phone_number: "380671112233" } } });
  });
});

test("турист: «Доступно зараз» → слот → согласие обязательно → заявка → альтернатива принята; a11y", async ({
  page,
}) => {
  const mock = await installBookingsMock(page);
  await page.goto(`/#/place/${CAFE_PLACE}`);
  await expect(page.getByTestId("badge-availability")).toHaveText("Доступно зараз");
  await page.getByTestId("place-book").click();

  // C07: завтра 10:00 — первый свободный.
  await expect(
    page.getByRole("heading", { level: 1, name: "Кав'ярня «Смерека» — оберіть час" }),
  ).toBeVisible();
  await expect(page.getByTestId("booking-availability")).toContainText("Доступно зараз");
  await page.getByTestId("slots").getByRole("button", { name: "10:00" }).click();
  await expectNoSeriousA11yViolations(page);
  await page.getByTestId("slot-pick").click();

  // C08: без галочки отправить нельзя.
  await expect(page.getByTestId("booking-summary")).toContainText("Чан №1");
  await page.getByTestId("share-contact").click();
  await expect(page.getByLabel("Телефон для підтвердження")).toHaveValue("+380671112233");
  await expect(page.getByTestId("booking-submit")).toBeDisabled();
  await page.getByRole("button", { name: "Більше осіб" }).click();
  await page
    .getByLabel(
      "Погоджуюся на передачу мого номера телефону закладу «Кав'ярня «Смерека»» для підтвердження бронювання",
    )
    .check();
  await expectNoSeriousA11yViolations(page);
  await page.getByTestId("booking-submit").click();

  await expect(page.getByRole("heading", { level: 1, name: "Заявку надіслано" })).toBeVisible();
  await expect(page.getByTestId("booking-done").getByTestId("booking-status")).toHaveText(
    "Очікує підтвердження",
  );
  expect(mock.created).toHaveLength(1);
  expect(mock.created[0]!.key).toMatch(/.+/);
  expect(mock.created[0]!.body).toMatchObject({
    startsAt: kyiv(1, 10),
    peopleCount: 2,
    phone: "+380671112233",
    phoneSource: "telegram_contact",
    phoneShareConsent: true,
  });

  // C21: партнёр предложил другой время — принять.
  const booking = mock.bookings[0]!;
  Object.assign(booking, {
    status: "alternative_proposed",
    alternative: { startsAt: kyiv(1, 12), endsAt: kyiv(1, 13), respondBy: kyiv(1, 9) },
    allowedTransitions: ["confirmed", "cancelled_by_user"],
  });
  await page.getByRole("link", { name: "Мої бронювання" }).click();
  const item = page.getByTestId("my-booking");
  await expect(item.getByTestId("booking-status")).toHaveText("Запропоновано інший час");
  await expect(item.getByTestId("booking-alternative")).toContainText("Заклад пропонує інший час");
  await expect(item.getByTestId("booking-alternative")).toContainText("12:00");
  await expectNoSeriousA11yViolations(page);
  await item.getByRole("button", { name: "Прийняти" }).click();
  await expect(item.getByTestId("booking-status")).toHaveText("Підтверджено");
  await expect(item.getByTestId("cancel-rule")).toHaveText(
    "Скасувати онлайн можна не пізніше ніж за 2 год до початку.",
  );
  expect(mock.statusChanges.at(-1)).toMatchObject({ status: "confirmed" });
});

test("«Назад» в бронировании: форма → выбор времени → карточка места → экран, откуда пришли", async ({
  page,
}) => {
  await installBookingsMock(page);
  await page.goto(`/#/place/${CAFE_PLACE}`);
  await page.getByTestId("place-book").click();
  await page.getByTestId("slots").getByRole("button", { name: "10:00" }).click();
  await page.getByTestId("slot-pick").click();
  await expect(page.getByTestId("booking-summary")).toBeVisible();
  const press = () =>
    page.evaluate(() =>
      (window as unknown as { __telegramPress(b: string): void }).__telegramPress("BackButton"),
    );
  await press();
  await expect(page.getByTestId("slots")).toBeVisible();
  await expect(page).toHaveURL(/#\/book\//);
  await press();
  await expect(page).toHaveURL(/#\/place\//);
  await expect(page.getByRole("heading", { level: 1, name: "Кав'ярня «Смерека»" })).toBeVisible();
  // Вход был по прямой ссылке на карточку: дальше — главная.
  await press();
  await expect(page.getByTestId("home-sections")).toBeVisible();
});

test("партнёр: P04 брони дня → P05 подтвердить; ручная запись; ресурсы — 409 version и ручной статус; a11y", async ({
  page,
}) => {
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
  const mock = await installBookingsMock(page);
  mock.bookings.push(bookingDto({ id: "00000000-0000-4000-8000-000000000499" }));

  await page.goto("/#/partner");
  await page.getByTestId("partner-bookings-link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Бронювання" })).toBeVisible();
  const row = page.getByTestId("pbooking-row");
  await expect(row).toContainText("18:00–19:00 · Олена Коваль · осіб: 3");
  await expect(row.getByTestId("booking-status")).toHaveText("Очікує відповіді");
  await expectNoSeriousA11yViolations(page);
  await row.click();

  // P05.
  await expect(page.getByRole("heading", { level: 1, name: "Картка бронювання" })).toBeVisible();
  await expect(page.getByTestId("pbooking-phone")).toHaveText("+380501234567");
  await expectNoSeriousA11yViolations(page);
  await page.getByTestId("pbooking-actions").getByRole("button", { name: "Підтвердити" }).click();
  await expect(page.getByTestId("pbooking-card").getByTestId("booking-status")).toHaveText("Підтверджено");
  await expect(page.getByTestId("pbooking-actions").getByRole("button")).toHaveText([
    "Відбулося",
    "Клієнт не прийшов",
    "Відхилити",
  ]);
  await page.getByRole("button", { name: "До календаря" }).click();

  // Ручная запись.
  await page.getByTestId("manual-add").click();
  const form = page.getByTestId("manual-form");
  await form.getByLabel("Час").fill("20:00");
  await form.getByLabel("Імʼя клієнта").fill("Іван");
  await form.getByLabel("Джерело").selectOption("phone");
  await expectNoSeriousA11yViolations(page);
  await form.getByRole("button", { name: "Зберегти запис" }).click();
  await expect(page.getByTestId("pbooking-notice")).toContainText("Запис додано");
  await expect(page.getByTestId("pbooking-row")).toHaveCount(2);
  expect(mock.manual[0]).toMatchObject({ customerName: "Іван", source: "phone", startsAt: kyiv(0, 20) });

  // Ресурсы: правка с устаревшей версией → «Оновити дані»; ручной статус с TTL.
  await page.getByRole("link", { name: "Ресурси і доступність" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ресурси бронювання" })).toBeVisible();
  mock.conflictOnce = true;
  await page.getByRole("button", { name: "Налаштування" }).click();
  await page.getByLabel("Осіб на слот").fill("8");
  await page.getByRole("button", { name: "Зберегти", exact: true }).click();
  await expect(page.getByTestId("resource-message")).toContainText(
    "Ресурс щойно змінили — оновіть сторінку.",
  );
  await page.getByTestId("resource-refresh").click();
  await page.getByRole("button", { name: "Налаштування" }).click();
  await page.getByLabel("Осіб на слот").fill("8");
  await page.getByRole("button", { name: "Зберегти", exact: true }).click();
  await expect(page.getByTestId("pres-notice")).toHaveText("Ресурс збережено.");
  await expect(page.getByTestId("resource")).toContainText("до 8 осіб");

  await page.getByLabel("Діє").selectOption("30");
  await page.getByRole("button", { name: "Є вільні місця" }).click();
  await expect(page.getByTestId("manual-status")).toContainText("Зараз: є вільні місця");
  expect(mock.manualStatus[0]).toEqual({ status: "available_now", ttlMinutes: 30 });
  await expectNoSeriousA11yViolations(page);
});
