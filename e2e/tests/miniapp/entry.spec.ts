// Блок 2: вход по initData, контекст QR (C01, «Про заклад»), онбординг согласий и профиль C15.
// api не поднят — ответы подставляет support/api-mock.ts (коды QR — как в seed api).
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { apiMockState } from "../../support/api-mock.js";
import { expect, test } from "../../support/fixtures.js";
import { telegramCalls } from "../../support/telegram-webapp.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { status: "ok" }, headers: { "access-control-allow-origin": "*" } }),
  );
});

test.describe("QR отеля demoHotel01", () => {
  test.use({ telegram: { startParam: "demoHotel01" } });

  test("«Про заклад» без ручного выбора, контекст запрошен один раз; a11y", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toHaveText("Ви відкрили гід: Тестовий готель");
    await page.getByRole("link", { name: "Про заклад" }).click();
    const venue = page.getByTestId("venue");
    await expect(venue.getByRole("heading", { name: "Тестовий готель" })).toBeVisible();
    await expect(venue.getByRole("link", { name: "+380501234567" })).toHaveAttribute(
      "href",
      "tel:+380501234567",
    );
    await expect(venue.getByRole("link", { name: "@test_hotel" })).toHaveAttribute(
      "href",
      "https://t.me/test_hotel",
    );
    expect(apiMockState.get(page)!.contextCalls).toBe(1);
    const anon = await page.evaluate(() => localStorage.getItem("tg.anonymousId"));
    expect(anon).toBe("7d0f3e1a-5b2c-4c8d-9e6f-0a1b2c3d4e5f");
    await expectNoSeriousA11yViolations(page);
  });

  test("онбординг: согласия, requestWriteAccess → профиль; смена языка; a11y профиля", async ({ page }) => {
    await page.goto("/");
    const next = page.getByRole("button", { name: "Продовжити" });
    await expect(next).toBeDisabled();
    await page.getByLabel("Погоджуюся з умовами користування").check();
    await page.getByLabel("Погоджуюся з політикою конфіденційності").check();
    await next.click();
    await page.getByRole("button", { name: "Меню" }).click();
    await page.getByRole("link", { name: "Профіль" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Профіль" })).toBeVisible();
    expect(await telegramCalls(page)).toContain("requestWriteAccess");
    const state = apiMockState.get(page)!;
    expect(state.consents.map((c) => c.kind).sort()).toEqual(["privacy", "terms"]);
    expect(state.messaging.service).toBe(true);
    await expect(page.getByLabel("Сервісні повідомлення")).toBeChecked();
    await expectNoSeriousA11yViolations(page);

    await page.getByLabel("Мова").selectOption("en");
    await expect(page.getByRole("heading", { level: 1, name: "Profile" })).toBeVisible();
    expect(state.language).toBe("en");
    expect(state.contextCalls).toBe(1);
  });
});

test.describe("деактивированный QR demoHotelOff1", () => {
  test.use({ telegram: { startParam: "demoHotelOff1" } });

  test("нейтральный контекст региона, без карточки заклада", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("neutral-context")).toHaveText("Ви на Прикарпатті.");
    await expect(page.getByTestId("venue-summary")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Про заклад" })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page);
  });
});

test.describe("открытие без QR", () => {
  test.use({ telegram: {} });

  test("регион по умолчанию через GET /context", async ({ page }) => {
    const paths: string[] = [];
    page.on("request", (r) => paths.push(new URL(r.url()).pathname));
    await page.goto("/");
    await expect(page.getByTestId("neutral-context")).toHaveText("Ви на Прикарпатті.");
    expect(apiMockState.get(page)!.contextCalls).toBe(1);
    expect(paths.filter((p) => p.startsWith("/context"))).toEqual(["/context"]);
  });
});

test.describe("вне Telegram", () => {
  test.use({ telegram: null });

  test("подсказка открыть в Telegram, вход не вызывается", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("browser-notice")).toBeVisible();
    expect(apiMockState.get(page)!.contextCalls).toBe(0);
  });
});

test.describe("сбои и подтверждения", () => {
  test.use({ telegram: { startParam: "demoHotel01" } });

  test("сбой /context (503) → «Повторити» → карточка заклада", async ({ page }) => {
    let failed = false;
    // Зарегистрирован позже мока — срабатывает первым; первый запрос падает, дальше — мок.
    await page.route("**/context/**", async (route) => {
      if (route.request().method() === "GET" && !failed) {
        failed = true;
        return route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, json: {} });
      }
      return route.fallback();
    });
    await page.goto("/");
    await expect(page.getByTestId("context-unavailable")).toBeVisible();
    await page.getByRole("button", { name: "Повторити" }).click();
    await expect(page.getByTestId("venue-summary")).toHaveText("Ви відкрили гід: Тестовий готель");
  });

  test("профиль: удаление данных — после подтверждения, открытый запрос блокирует кнопку", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("Погоджуюся з умовами користування").check();
    await page.getByLabel("Погоджуюся з політикою конфіденційності").check();
    await page.getByRole("button", { name: "Продовжити" }).click();
    await page.getByRole("button", { name: "Меню" }).click();
    await page.getByRole("link", { name: "Профіль" }).click();
    await page.getByRole("button", { name: "Запросити видалення даних" }).click();
    expect(apiMockState.get(page)!.privacyRequests).toHaveLength(0);
    await page.getByRole("button", { name: "Так, видалити мої дані" }).click();
    await expect(page.getByTestId("privacy-requests")).toHaveText("Запит на видалення: отримано");
    await expect(page.getByRole("button", { name: "Запросити видалення даних" })).toBeDisabled();
    await expectNoSeriousA11yViolations(page);
  });
});
