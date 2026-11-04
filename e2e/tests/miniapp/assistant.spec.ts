// Ассистент на главной (флаг module.assistant): текст → места каталога, уточнение чипом с контекстом диалога,
// «готель поруч», экскурсия с маршрутом на карте, голос (MediaRecorder подменён) → распознавание → реплика; a11y.
// api не поднят — ответы support/assistant-mock.ts (Claude и Google не вызываются).
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { REGION_ID } from "../../support/api-mock.js";
import { installAssistantMock, installFakeMicrophone } from "../../support/assistant-mock.js";
import { expect, test } from "../../support/fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

test.use({ telegram: { startParam: "demoHotel01" } });

test("текст: «Що шукаєте?» → места каталога и карта; чип «Дешевше» — уточнение с контекстом; a11y", async ({
  page,
}) => {
  const mock = await installAssistantMock(page);
  await page.goto("/");
  const box = page.getByTestId("assistant-box");
  await expect(box).toBeVisible();
  await box.getByLabel("Що шукаєте?").fill("Недорога кав'ярня");
  await box.getByRole("button", { name: "Надіслати" }).click();

  await expect(page).toHaveURL(/#\/assistant$/);
  await expect(page.getByTestId("assistant-status")).toHaveText("Знайдено в каталозі: 2");
  await expect(page.getByTestId("assistant-reply")).toHaveText("Шукаю: Кав'ярні");
  const places = page.getByTestId("assistant-place");
  await expect(places).toHaveCount(2);
  await expect(places.first()).toContainText("Кав'ярня «Смерека»");
  await expect(places.first()).toContainText("Середні ціни");
  await expect(places.first()).not.toContainText("Згенеровано ШІ");
  await expect(page.getByTestId("places-map")).toBeVisible();
  // Точка — базовая (QR отеля), а не устройство.
  expect(mock.queries[0]).toMatchObject({ regionId: REGION_ID, text: "Недорога кав'ярня", history: [] });
  expect(mock.queries[0]).toHaveProperty("lat");
  await expectNoSeriousA11yViolations(page);

  await page.getByTestId("assistant-chips").getByRole("button", { name: "Дешевше" }).click();
  await expect(page.getByTestId("assistant-reply")).toHaveText([
    "Шукаю: Кав'ярні",
    "Шукаю: Кав'ярні, недорого",
  ]);
  await expect(places).toHaveCount(1);
  await expect(places.first()).toContainText("Кав'ярня «Ватра»");
  await expect(places.first()).toContainText("Підходить для дітей");
  expect(mock.queries[1]).toMatchObject({
    text: "Дешевше",
    history: ["Недорога кав'ярня"],
    previous: { categories: ["cafes"], priceMax: null },
  });

  // Карточка — обычная карточка места каталога.
  await places.first().getByRole("link", { name: "Кав'ярня «Ватра»" }).click();
  await expect(page).toHaveURL(/#\/place\//);

  // «Назад» — тот же диалог без повторного (платного) запроса.
  await page.goBack();
  await expect(page).toHaveURL(/#\/assistant$/);
  await expect(page.getByTestId("assistant-reply")).toHaveText([
    "Шукаю: Кав'ярні",
    "Шукаю: Кав'ярні, недорого",
  ]);
  await expect(places).toHaveCount(1);
  expect(mock.queries).toHaveLength(2);
});

test("«готель поруч» — места проживания из каталога", async ({ page }) => {
  await installAssistantMock(page);
  await page.goto("/");
  await page.getByLabel("Що шукаєте?").fill("Готель поруч");
  await page.getByRole("button", { name: "Надіслати" }).click();
  await expect(page.getByTestId("assistant-place")).toHaveCount(1);
  await expect(page.getByTestId("assistant-place")).toContainText("Готель «Карпати»");
});

test("экскурсия: остановки по порядку, маршрут на карте; непонятный запрос — уточнить", async ({ page }) => {
  await installAssistantMock(page);
  await page.goto("/#/assistant?q=" + encodeURIComponent("Екскурсія по пам'ятках"));
  await expect(page.getByTestId("assistant-route")).toHaveText(
    "Маршрут екскурсії: зупинок — 2, між ними ≈ 320 м по прямій",
  );
  await expect(page.getByText("Зупинка 1")).toBeVisible();
  await expect(page.getByTestId("assistant-place").nth(1)).toContainText("Водоспад Пробій");
  // Линия маршрута (Polyline) и номера остановок на маркерах.
  await expect(page.getByTestId("places-map").locator('[data-fake="polyline"]')).toBeAttached();

  await page.locator("#assistant-next").fill("Як справи?");
  await page.getByRole("button", { name: "Надіслати" }).click();
  await expect(page.getByTestId("assistant-reply").last()).toContainText("Уточніть, будь ласка");
});

test("«суші»: блюдо в сводке, по 10 мест — «Показати ще»", async ({ page }) => {
  await installAssistantMock(page);
  await page.goto("/#/assistant?q=" + encodeURIComponent("Де поїсти суші"));
  await expect(page.getByTestId("assistant-status")).toHaveText("Знайдено в каталозі: 12");
  await expect(page.getByTestId("assistant-reply")).toHaveText("Шукаю: «суші», Кав'ярні");
  await expect(page.getByTestId("assistant-place")).toHaveCount(10);
  await page.getByTestId("assistant-more").click();
  await expect(page.getByTestId("assistant-place")).toHaveCount(12);
  await expect(page.getByTestId("assistant-more")).toHaveCount(0);
});

test("«Назад» Telegram из карточки места: тот же список, «Показати ще» и прокрутка; одна строка ввода", async ({
  page,
}) => {
  const mock = await installAssistantMock(page);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/#/assistant?q=" + encodeURIComponent("Де поїсти суші"));
  await expect(page.getByTestId("assistant-place")).toHaveCount(10);
  await page.getByTestId("assistant-more").click();
  await expect(page.getByTestId("assistant-place")).toHaveCount(12);
  // Строка ввода одна — уточнения («Скажіть, що додати або змінити»).
  await expect(page.getByTestId("assistant-box")).toHaveCount(1);
  await expect(page.getByLabel("Що додати або змінити?")).toHaveAttribute(
    "placeholder",
    "Скажіть, що додати або змінити",
  );
  const card = page.getByTestId("assistant-place").nth(10);
  await card.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(200);
  await card.getByRole("link", { name: "Суші-бар 11" }).click();
  await expect(page).toHaveURL(/#\/place\//);
  // Нативная BackButton Telegram — обратно в ассистент (не на главную).
  await page.evaluate(() =>
    (window as unknown as { __telegramPress(b: string): void }).__telegramPress("BackButton"),
  );
  await expect(page).toHaveURL(/#\/assistant$/);
  await expect(page.getByTestId("assistant-place")).toHaveCount(12);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolled - 80);
  expect(mock.queries).toHaveLength(1);
  // Вход прямо на #/assistant (одна запись истории): «Назад» — на главную, из Mini App не выходит.
  const press = () =>
    page.evaluate(() =>
      (window as unknown as { __telegramPress(b: string): void }).__telegramPress("BackButton"),
    );
  await press();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId("home-sections")).toBeVisible();
});

test("вход по ссылке на карточку: «Назад» — на главную, из Mini App не выходит", async ({ page }) => {
  await installAssistantMock(page);
  await page.goto("/#/place/00000000-0000-4000-8000-000000000300");
  await expect(page).toHaveURL(/#\/place\//);
  await page.evaluate(() =>
    (window as unknown as { __telegramPress(b: string): void }).__telegramPress("BackButton"),
  );
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByTestId("home-sections")).toBeVisible();
});

test("«5 днів з дітьми»: уточнение области и передвижения чипами; без авто — переезд с такси и подсказкой", async ({
  page,
}) => {
  const mock = await installAssistantMock(page);
  await page.goto("/#/assistant?q=" + encodeURIComponent("Я приїхав на 5 днів з дітьми, склади план"));
  const q = page.getByTestId("assistant-questions");
  await expect(q).toContainText("Де плануєте відпочивати?");
  await expect(q).toContainText("Як пересуваєтесь?");
  await expectNoSeriousA11yViolations(page);
  await q.getByRole("button", { name: "По всьому Прикарпаттю" }).click();
  await q.getByRole("button", { name: /Пішки/ }).click();
  await expect(page.getByRole("heading", { name: "План відпочинку" })).toBeVisible();
  expect(mock.queries[1]).toMatchObject({
    text: "По всьому Прикарпаттю, Пішки (без авто)",
    // Ответ на уточнения — структурой, без повторного разбора моделью.
    answer: true,
    previous: { kind: "plan", days: 5, scope: "region", transport: "foot", scopeLocalityIds: [] },
  });
  await expect(page.getByTestId("assistant-plan-travel").first()).toContainText("🚶");
  await page.getByTestId("assistant-plan-day").nth(1).click();
  const transfer = page.getByTestId("assistant-plan-transfer");
  await expect(transfer).toContainText("24 км");
  await expect(transfer).toContainText("Таксі «Говерла»");
  await expect(page.getByTestId("assistant-bus-hint")).toHaveText(
    "Розклад автобусів уточнюйте на автостанції / у перевізника.",
  );
});

test("план відпочинку: частини дня, час, пояснення, маршрут на карті; a11y", async ({ page }) => {
  await installAssistantMock(page);
  await page.goto("/#/assistant?q=" + encodeURIComponent("Склади план на день"));
  await expect(page.getByRole("heading", { name: "План відпочинку" })).toBeVisible();
  await expect(page.getByTestId("assistant-plan-part")).toHaveCount(2);
  const stops = page.getByTestId("assistant-plan-stop");
  await expect(stops).toHaveCount(3);
  await expect(stops.first()).toContainText("09:30 · Огляд");
  await expect(stops.first()).toContainText("Водоспад Пробій");
  await expect(page.getByTestId("assistant-plan-note")).toHaveText("Почніть день біля водоспаду.");
  await expect(stops.nth(2)).toContainText("≈ 5 хв пішки");
  await expect(page.getByTestId("places-map").locator('[data-fake="polyline"]')).toBeAttached();
  await expectNoSeriousA11yViolations(page);
});

test.describe("голос", () => {
  test("микрофон: запись → POST /assistant/transcribe (audio/webm) → реплика ассистенту", async ({
    page,
  }) => {
    await installFakeMicrophone(page);
    const mock = await installAssistantMock(page);
    await page.goto("/");
    const mic = page.getByTestId("assistant-mic");
    await expect(mic).toHaveAccessibleName("Сказати голосом");
    // Круглая кнопка — цель касания не меньше 44 px.
    const size = await mic.boundingBox();
    expect(size!.width).toBeGreaterThanOrEqual(44);
    expect(size!.height).toBeGreaterThanOrEqual(44);
    await mic.click();
    await expect(page.getByTestId("assistant-voice-status")).toHaveText(
      "Слухаю… Натисніть ще раз, щоб завершити.",
    );
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await mic.click();
    await expect(page).toHaveURL(/#\/assistant$/);
    await expect(page.getByTestId("assistant-place")).toHaveCount(2);
    expect(mock.transcribes).toEqual([
      { contentType: "audio/webm", bytes: "OggS-fake-opus-audio".length, regionId: REGION_ID },
    ]);
    expect(mock.queries[0]).toMatchObject({ text: "кав'ярня поруч" });
  });

  test("без MediaRecorder с Opus (iOS) — кнопки микрофона нет, текст работает", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "MediaRecorder", { value: undefined, configurable: true });
    });
    await installAssistantMock(page);
    await page.goto("/");
    await expect(page.getByTestId("assistant-box")).toBeVisible();
    await expect(page.getByTestId("assistant-mic")).toHaveCount(0);
  });
});
