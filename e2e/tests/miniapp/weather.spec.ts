// Погода на главной (флаг module.weather): пилюля «иконка +2°» рядом с «Локація», лист прогноза на 5 днів с
// предупреждениями и подписью источника; оба дизайна. api не поднят — GET /weather отдаём здесь; прогноза нет — пилюли нет.
import type { Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y.js";
import { expect, test } from "../../support/fixtures.js";

const cors = { "access-control-allow-origin": "*" };

const day = (date: string, over: Record<string, unknown> = {}) => ({
  date,
  condition: "cloudy",
  description: null,
  iconUrl: null,
  temperatureMax: 6,
  temperatureMin: -2,
  precipitationSum: 0,
  precipitationProbabilityMax: 20,
  snowfallSum: 0,
  windSpeedMax: 12,
  windGustsMax: 20,
  rainy: false,
  warnings: [],
  ...over,
});

const forecast = {
  available: true,
  source: "open-meteo",
  point: { lat: 48.45, lng: 24.56, elevation: 600 },
  timezone: "Europe/Kyiv",
  current: {
    time: "2026-11-03T10:00",
    temperature: 2.3,
    condition: "cloudy",
    description: null,
    iconUrl: null,
    windSpeed: 8,
    isDay: true,
  },
  days: [
    day("2026-11-03"),
    day("2026-11-04", { condition: "thunderstorm", rainy: true, warnings: ["thunderstorm"] }),
    day("2026-11-05"),
    day("2026-11-06"),
    day("2026-11-07"),
  ],
};

async function mockWeather(page: Page, body: unknown) {
  // Позже зарегистрированный маршрут Playwright проверяется первым — флаги с module.weather.
  await page.route("**/feature-flags*", (route) =>
    route.fulfill({
      json: {
        items: [
          { key: "module.host_requests", enabled: true },
          { key: "module.weather", enabled: true },
        ],
      },
      headers: cors,
    }),
  );
  await page.route(
    (url) => url.pathname === "/weather",
    (route) => route.fulfill({ json: body, headers: cors }),
  );
}

test.describe("погода на главной", () => {
  test.use({ telegram: { startParam: "demoHotel01" } });

  test("пилюля и лист прогноза: предупреждение, 5 днів, Escape; a11y", async ({ page }) => {
    await mockWeather(page, forecast);
    await page.goto("/");
    const chip = page.getByTestId("weather-chip");
    await expect(chip).toContainText("+2°");
    await expect(chip).not.toContainText("Тестовий готель");
    expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(chip).toHaveAccessibleName("Погода, Тестовий готель: Хмарно, +2°. Відкрити прогноз");
    await chip.click();
    const sheet = page.getByRole("dialog", { name: "Погода на 5 днів: Тестовий готель" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("weather-warnings")).toContainText("Гроза");
    await expect(sheet.getByTestId("weather-days").getByRole("listitem")).toHaveCount(5);
    await expect(sheet.getByTestId("weather-source")).toHaveText("Дані: Open-Meteo");
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(chip).toBeFocused();
  });

  test("прогноза нет — пилюли нет", async ({ page }) => {
    await mockWeather(page, { ...forecast, available: false, source: null, current: null, days: [] });
    await page.goto("/");
    await expect(page.getByTestId("venue-summary")).toBeAttached();
    await expect(page.getByTestId("weather-chip")).toHaveCount(0);
  });
});
