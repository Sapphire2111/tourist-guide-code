// Скан QR из открытого Mini App: showScanQrPopup / qrTextReceived (мок Telegram), контекст без перезапуска.
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";
import { emitTelegramEvent, telegramCalls } from "../../support/telegram-webapp.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

test.describe("скан QR", () => {
  test("кнопка на главной: наша ссылка открывает заведение, a11y", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("neutral-context")).toBeVisible();
    await page.getByRole("button", { name: "Сканувати QR-код" }).click();
    expect(await telegramCalls(page)).toContain("showScanQrPopup");
    await emitTelegramEvent(page, "qrTextReceived", {
      data: "https://t.me/tg_gid_bot?startapp=demoHotel01",
    });
    const venue = page.getByTestId("venue");
    await expect(venue.getByRole("heading", { name: "Тестовий готель" })).toBeVisible();
    expect(await telegramCalls(page)).toContain("closeScanQrPopup");
    expect(apiMockState.get(page)!.contextCalls).toBe(2);
    await expectNoSeriousA11yViolations(page);
  });

  test("пункт меню; чужой QR — сообщение без запроса контекста и без открытия ссылки", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Меню" }).click();
    await page.getByRole("button", { name: "Сканувати QR-код" }).last().click();
    await emitTelegramEvent(page, "qrTextReceived", { data: "https://example.com/?startapp=demoHotel01" });
    await expect(page.getByTestId("scan-message")).toHaveText("Це не QR-код Гіда туриста");
    // Сообщение на виду: плашка под полосой, не сжата кнопками (шире половины экрана).
    await expect(page.getByTestId("scan-message")).toBeInViewport();
    expect((await page.getByTestId("scan-message").boundingBox())!.width).toBeGreaterThan(160);
    expect(apiMockState.get(page)!.contextCalls).toBe(1);
    expect(await telegramCalls(page)).not.toContain("openLink");
  });

  test("неактивный QR — сообщение", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Сканувати QR-код" }).click();
    await emitTelegramEvent(page, "qrTextReceived", {
      data: "tg://resolve?domain=tg_gid_bot&startapp=demoHotelOff1",
    });
    await expect(page.getByTestId("scan-message")).toHaveText("Цей QR-код більше не діє");
  });
});
