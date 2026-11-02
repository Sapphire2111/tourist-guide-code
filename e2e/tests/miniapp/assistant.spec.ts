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
  await box.getByRole("button", { name: "Знайти" }).click();

  await expect(page).toHaveURL(/#\/assistant$/);
  await expect(page.getByTestId("assistant-status")).toHaveText("Знайдено в каталозі: 2");
  await expect(page.getByTestId("assistant-reply")).toHaveText("Шукаю: Кав'ярні");
  const places = page.getByTestId("assistant-place");
  await expect(places).toHaveCount(2);
  await expect(places.first()).toContainText("Кав'ярня «Смерека»");
  await expect(places.first()).toContainText("Середні ціни");
  await expect(places.first()).toContainText("Згенеровано ШІ");
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
  await page.getByRole("button", { name: "Знайти" }).click();
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
  // Линия маршрута Leaflet — путь SVG поверх карты.
  await expect(page.getByTestId("places-map").locator("path.leaflet-interactive").first()).toBeVisible();

  await page.locator("#assistant-next").fill("Як справи?");
  await page.getByRole("button", { name: "Знайти" }).click();
  await expect(page.getByTestId("assistant-reply").last()).toContainText("Уточніть, будь ласка");
});

test.describe("голос", () => {
  test("микрофон: запись → POST /assistant/transcribe (audio/webm) → реплика ассистенту", async ({
    page,
  }) => {
    await installFakeMicrophone(page);
    const mock = await installAssistantMock(page);
    await page.goto("/");
    const mic = page.getByTestId("assistant-mic");
    await expect(mic).toHaveAccessibleName("Скажи, чого душа бажає");
    await expect(mic).toHaveText("Скажи, чого душа бажає");
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
