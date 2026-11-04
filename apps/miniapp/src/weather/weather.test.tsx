// Unit: погода на главной — пилюля «иконка +2°» (точка — заклад QR), лист прогноза (aria-modal, Escape, фокус),
// предупреждения сверху, подпись источника; нет прогноза — ничего. Адаптер GET /weather: иконки только с нашего api.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ApiClient } from "@tg/api-client";
import { I18nProvider } from "@tg/ui";
import { noopAnalytics } from "../guide/analytics.js";
import { GuideProvider, noopGuideApi } from "../guide/context.js";
import { consumeBack, hasBackIntercept, type TelegramWebApp } from "../telegram.js";
import { formatTemp, WeatherChip } from "./Weather.js";
import {
  createWeatherApi,
  safeIcon,
  type Forecast,
  type WeatherApi,
  type WeatherDay,
} from "./weather-api.js";

afterEach(cleanup);

const API = "https://api.example.test";

const day = (date: string, over: Partial<WeatherDay> = {}): WeatherDay => ({
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

const forecast: Forecast = {
  source: "open-meteo",
  current: {
    time: null,
    temperature: 2.4,
    condition: "cloudy",
    description: null,
    iconUrl: null,
    windSpeed: 8,
    isDay: true,
  },
  days: [
    day("2026-11-03"),
    day("2026-11-04", { condition: "thunderstorm", warnings: ["thunderstorm"] }),
    day("2026-11-05"),
    day("2026-11-06"),
    day("2026-11-07"),
  ],
};

function tree(api: WeatherApi, point = { lat: 48.45, lng: 24.55 }, webApp?: TelegramWebApp) {
  return (
    <I18nProvider locale="uk">
      <GuideProvider
        value={{
          api: noopGuideApi(),
          analytics: noopAnalytics,
          base: { name: "Hotel", point },
          regionId: "r",
          signedIn: false,
          webApp,
        }}
      >
        <WeatherChip api={api} />
      </GuideProvider>
    </I18nProvider>
  );
}

function setup(api: WeatherApi) {
  return render(tree(api));
}

describe("погода на главной", () => {
  it("пилюля: иконка и t°; лист на 5 днів — предупреждения сверху, Escape закрывает, фокус возвращается", async () => {
    const api = { forecast: vi.fn(async () => forecast) };
    setup(api);
    const chip = await screen.findByTestId("weather-chip");
    expect(api.forecast).toHaveBeenCalledWith({ lat: 48.45, lng: 24.55 }, expect.anything());
    expect(chip.textContent).toContain("+2°");
    expect(chip.getAttribute("aria-label")).toBe("Погода: Хмарно, +2°. Відкрити прогноз");
    fireEvent.click(chip);
    const sheet = screen.getByRole("dialog", { name: "Погода на 5 днів" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(within(sheet).getByTestId("weather-warnings").textContent).toContain("Гроза");
    expect(within(sheet).getByTestId("weather-days").querySelectorAll("li")).toHaveLength(5);
    expect(within(sheet).getByText("Сьогодні")).toBeTruthy();
    expect(within(sheet).getAllByText("Опади 20%")).toHaveLength(5);
    expect(within(sheet).getByTestId("weather-source").textContent).toBe("Дані: Open-Meteo");
    expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Закрити прогноз" }));
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("Google: иконка с нашего прокси и описание источника; подпись Google без перевода", async () => {
    const icon = `${API}/weather/icons/cloudy.svg`;
    const g: Forecast = {
      ...forecast,
      source: "google",
      current: { ...forecast.current!, description: "Хмарно з проясненнями", iconUrl: icon },
    };
    setup({ forecast: async () => g });
    const chip = await screen.findByTestId("weather-chip");
    expect(chip.querySelector("img")?.getAttribute("src")).toBe(icon);
    fireEvent.click(chip);
    expect(screen.getByTestId("weather-source").textContent).toBe(
      "Source: Includes weather data from Google.",
    );
  });

  it("«Назад» Telegram закрывает лист (перехват для общей кнопки); смена точки не закрывает лист", async () => {
    const api = { forecast: vi.fn(async (): Promise<Forecast | null> => forecast) };
    const { rerender } = render(tree(api));
    expect(hasBackIntercept()).toBe(false);
    fireEvent.click(await screen.findByTestId("weather-chip"));
    expect(hasBackIntercept()).toBe(true);
    // Новая точка (сменили «Локація»): прогноз грузится — лист остаётся с прежними данными.
    api.forecast.mockImplementation(() => new Promise<Forecast | null>(() => {}));
    rerender(tree(api, { lat: 48.34, lng: 24.57 }));
    expect(api.forecast).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog", { name: "Погода на 5 днів" })).toBeTruthy();
    act(() => {
      expect(consumeBack()).toBe(true);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hasBackIntercept()).toBe(false);
  });

  it("нет прогноза — ничего не показывается", async () => {
    const api = { forecast: vi.fn(async () => null) };
    const { container } = setup(api);
    await act(async () => {});
    expect(api.forecast).toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});

describe("адаптер и формат", () => {
  it("formatTemp: знак и минус", () => {
    expect(formatTemp(2.4)).toBe("+2°");
    expect(formatTemp(-3.6)).toBe("−4°");
    expect(formatTemp(0.2)).toBe("0°");
    expect(formatTemp(null)).toBeNull();
  });

  it("safeIcon: только /weather/icons/…svg нашего api", () => {
    expect(safeIcon(`${API}/weather/icons/rain.svg`, API)).toBe(`${API}/weather/icons/rain.svg`);
    expect(safeIcon("https://maps.gstatic.com/weather/v1/rain.svg", API)).toBeNull();
    expect(safeIcon(`${API}/places/x`, API)).toBeNull();
    expect(safeIcon(null, API)).toBeNull();
  });

  it("GET /weather: регион и точка в запросе; available:false и сбой — null", async () => {
    const dto = {
      available: true,
      source: "google",
      point: null,
      timezone: "Europe/Kyiv",
      current: null,
      days: [day("2026-11-03", { iconUrl: "https://maps.gstatic.com/weather/v1/cloudy.svg" })],
    };
    const GET = vi.fn(async () => ({ data: dto, response: new Response(null, { status: 200 }) }));
    const api = createWeatherApi({ GET } as unknown as ApiClient, "region-1", API);
    const f = await api.forecast({ lat: 48.45123, lng: 24.55 });
    expect(GET).toHaveBeenCalledWith("/weather", {
      params: { query: { lat: 48.451, lng: 24.55, days: 5, regionId: "region-1" } },
      signal: undefined,
    });
    // Иконка не с нашего api — не используется (своя по condition).
    expect(f?.days[0]?.iconUrl).toBeNull();
    GET.mockResolvedValueOnce({ data: { ...dto, available: false }, response: new Response(null) });
    expect(await api.forecast({ lat: 1, lng: 2 })).toBeNull();
    GET.mockRejectedValueOnce(new Error("offline"));
    expect(await api.forecast({ lat: 1, lng: 2 })).toBeNull();
  });
});
