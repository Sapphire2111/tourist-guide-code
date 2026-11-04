// Unit: погода на главной — пилюля «иконка +2°» (точка — заклад QR), лист прогноза (aria-modal, Escape, фокус),
// предупреждения сверху, подпись источника; нет прогноза — ничего. Адаптер GET /weather: иконки только с нашего api.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ApiClient } from "@tg/api-client";
import { I18nProvider } from "@tg/ui";
import { noopAnalytics } from "../guide/analytics.js";
import { GuideProvider, noopGuideApi } from "../guide/context.js";
import { LOCATION_STORAGE_KEY, LocationProvider } from "../guide/LocationProvider.js";
import type { TelegramWebApp } from "../telegram.js";
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
    expect(chip.getAttribute("aria-label")).toBe("Погода, Hotel: Хмарно, +2°. Відкрити прогноз");
    expect(within(chip).getByTestId("weather-place").textContent).toBe("Hotel");
    fireEvent.click(chip);
    const sheet = screen.getByRole("dialog", { name: "Погода на 5 днів: Hotel" });
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

  it("«Назад» Telegram: кнопка видна, пока лист открыт, и закрывает его; смена точки не закрывает лист", async () => {
    let onBack: (() => void) | null = null;
    const back = {
      show: vi.fn(),
      hide: vi.fn(),
      onClick: vi.fn((cb: () => void) => (onBack = cb)),
      offClick: vi.fn(),
    };
    const webApp = { BackButton: back } as unknown as TelegramWebApp;
    const api = { forecast: vi.fn(async (): Promise<Forecast | null> => forecast) };
    const { rerender } = render(tree(api, undefined, webApp));
    fireEvent.click(await screen.findByTestId("weather-chip"));
    expect(back.show).toHaveBeenCalledTimes(1);
    // Новая точка (сменили «Локація»): прогноз грузится — лист остаётся с прежними данными.
    api.forecast.mockImplementation(() => new Promise<Forecast | null>(() => {}));
    rerender(tree(api, { lat: 48.34, lng: 24.57 }, webApp));
    expect(api.forecast).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog", { name: "Погода на 5 днів: Hotel" })).toBeTruthy();
    // Перерисовка не перезапускает эффект листа (onClose стабилен).
    expect(back.show).toHaveBeenCalledTimes(1);
    act(() => onBack!());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(back.hide).toHaveBeenCalled();
    expect(back.offClick).toHaveBeenCalled();
  });

  describe("для какой точки прогноз", () => {
    const YAR = { id: "yar", name: { uk: "Яремче" }, placeCount: 3, location: { lat: 48.45, lng: 24.55 } };
    const TAT = { id: "tat", name: { uk: "Татарів" }, placeCount: 2, location: { lat: 48.35, lng: 24.58 } };
    const located = (api: WeatherApi, base: { name: string; point: { lat: number; lng: number } } | null) => (
      <I18nProvider locale="uk">
        <GuideProvider
          value={{
            api: { ...noopGuideApi(), localities: async () => [YAR, TAT] },
            analytics: noopAnalytics,
            base,
            regionId: "r",
            signedIn: false,
          }}
        >
          <LocationProvider>
            <WeatherChip api={api} />
          </LocationProvider>
        </GuideProvider>
      </I18nProvider>
    );
    afterEach(() => localStorage.clear());

    it("без выбора — название первого пункта региона, а не «регион»", async () => {
      const api = { forecast: vi.fn(async () => forecast) };
      render(located(api, null));
      const chip = await screen.findByTestId("weather-chip");
      expect(within(chip).getByTestId("weather-place").textContent).toBe("Яремче");
      expect(chip.getAttribute("aria-label")).toContain("Погода, Яремче:");
      expect(api.forecast).toHaveBeenCalledWith(YAR.location, expect.anything());
    });

    it("несколько выбранных: прогноз первого, переключатель городов; другой город запрашивается только при выборе", async () => {
      localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: "r", ids: ["yar", "tat"] }));
      const api = { forecast: vi.fn(async () => forecast) };
      render(located(api, null));
      const chip = await screen.findByTestId("weather-chip");
      expect(api.forecast).toHaveBeenCalledTimes(1);
      fireEvent.click(chip);
      const sheet = screen.getByRole("dialog", { name: "Погода на 5 днів: Яремче" });
      const group = within(sheet).getByRole("group", { name: "Місто прогнозу" });
      expect(within(group).getByRole("button", { name: "Яремче" }).getAttribute("aria-pressed")).toBe("true");
      expect(api.forecast).toHaveBeenCalledTimes(1);
      fireEvent.click(within(group).getByRole("button", { name: "Татарів" }));
      await screen.findByRole("dialog", { name: "Погода на 5 днів: Татарів" });
      expect(api.forecast).toHaveBeenCalledTimes(2);
      expect(api.forecast).toHaveBeenLastCalledWith(TAT.location, expect.anything());
      expect(within(group).getByRole("button", { name: "Татарів" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(chip.getAttribute("aria-label")).toContain("Погода, Татарів:");
    });

    it("у выбранного города нет прогноза: сообщение и переключатель; после закрытия пилюля возвращается", async () => {
      localStorage.setItem(LOCATION_STORAGE_KEY, JSON.stringify({ regionId: "r", ids: ["yar", "tat"] }));
      const api = {
        forecast: vi.fn(async (p: { lat: number }) => (p.lat === TAT.location.lat ? null : forecast)),
      };
      render(located(api, null));
      fireEvent.click(await screen.findByTestId("weather-chip"));
      fireEvent.click(screen.getByRole("button", { name: "Татарів" }));
      expect(await screen.findByText("Для «Татарів» прогнозу зараз немає.")).toBeTruthy();
      expect(screen.getByRole("dialog", { name: "Погода на 5 днів: Татарів" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Закрити прогноз" }));
      const chip = await screen.findByTestId("weather-chip");
      expect(chip.getAttribute("aria-label")).toContain("Погода, Яремче:");
    });
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
