// Раздел «Вершини»: сортировка/фильтр, список (значки сложности — форма + текст), блок вершины в картке місця,
// адаптер api (ссылки источников только https).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ApiSchemas } from "@tg/api-client";
import { FeatureFlagsProvider } from "@tg/ui";
import type { Analytics } from "./analytics.js";
import { GuideProvider, type GuideEnv } from "./context.js";
import { peakOf } from "./guide-api.js";
import { availableFilters, filterPeaks, sortPeaks, type PeakPlace } from "./peak-list.js";
import { PeakBadge, PeakDetails, PeakList, Peaks } from "./Peaks.js";
import type { GuideApi, Peak, PeakDifficulty } from "./types.js";
import type { WeatherApi } from "../weather/weather-api.js";

afterEach(cleanup);

const peak = (over: Partial<Peak> = {}): Peak => ({
  slug: "x",
  heightM: 1500,
  range: "chornohora",
  difficulty: null,
  route: null,
  note: null,
  warnings: [],
  sources: [{ title: "Вікіпедія (uk): X", url: "https://uk.wikipedia.org/w/index.php?oldid=1" }],
  weatherPoint: null,
  ...over,
});

let n = 0;
const place = (name: string, p: Partial<Peak>, distanceMeters: number | null = null): PeakPlace => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  name: { uk: name },
  categoryId: "peaks",
  location: { lat: 48.16, lng: 24.5 },
  distanceMeters,
  cover: null,
  openNow: null,
  recommended: false,
  adLabel: null,
  peak: peak({ slug: name, ...p }),
});

const d = (difficulty: PeakDifficulty | null, heightM = 1500) => ({ difficulty, heightM });
const LIST = [
  place("Говерла", d("moderate", 2061), 30_000),
  place("Маковиця", d("easy", 984.5), 2_000),
  place("Синяк", d(null, 1665), 15_000),
  place("Петрос", d("hard", 2020), 45_000),
  place("Ребра", d("moderate", 2001), 40_000),
];

function env(over: Partial<GuideEnv> = {}): GuideEnv {
  return {
    api: {} as GuideApi,
    analytics: { track: vi.fn(), flush: vi.fn(), dispose: vi.fn() } as unknown as Analytics,
    base: null,
    regionId: "r",
    signedIn: false,
    ...over,
  };
}

const names = () => screen.getAllByTestId("peak-item").map((li) => li.getAttribute("data-slug"));

describe("сортировка и фильтр", () => {
  it("від легких до складних; без даних — у кінці; рівні — нижча раніше", () => {
    expect(sortPeaks(LIST, "difficulty").map((p) => p.peak.slug)).toEqual([
      "Маковиця",
      "Ребра",
      "Говерла",
      "Петрос",
      "Синяк",
    ]);
  });
  it("ближчі — за відстанню; вищі — за висотою", () => {
    expect(sortPeaks(LIST, "distance").map((p) => p.peak.slug)[0]).toBe("Маковиця");
    expect(sortPeaks(LIST, "height").map((p) => p.peak.slug)[0]).toBe("Говерла");
  });
  it("фільтр за складністю й «немає даних»; порожні фільтри не показуються", () => {
    expect(filterPeaks(LIST, "moderate").map((p) => p.peak.slug)).toEqual(["Говерла", "Ребра"]);
    expect(filterPeaks(LIST, "unknown").map((p) => p.peak.slug)).toEqual(["Синяк"]);
    expect(availableFilters(LIST)).toEqual(["all", "easy", "moderate", "hard", "unknown"]);
  });
});

describe("значок і список", () => {
  it("значок: форма + текст для кожного рівня, «Немає даних» — пунктиром", () => {
    render(
      <>
        <PeakBadge difficulty="easy" />
        <PeakBadge difficulty="expert" />
        <PeakBadge difficulty={null} />
      </>,
    );
    const badges = screen.getAllByTestId("peak-badge");
    expect(badges.map((b) => b.textContent)).toEqual(["Легка", "Дуже складна", "Немає даних"]);
    expect(badges.map((b) => b.querySelector(".peak-shape")?.getAttribute("data-shape"))).toEqual([
      "easy",
      "expert",
      "unknown",
    ]);
  });

  it("список: висота й хребет, значок; фільтр і сортування перемикаються", () => {
    render(
      <GuideProvider value={env()}>
        <PeakList places={LIST} />
      </GuideProvider>,
    );
    expect(names()).toEqual(["Маковиця", "Ребра", "Говерла", "Петрос", "Синяк"]);
    const first = within(screen.getAllByTestId("peak-item")[0]!);
    expect(first.getByText("984,5 м · Чорногора")).toBeTruthy();
    expect(first.getByTestId("peak-badge").textContent).toBe("Легка");
    expect(first.getByRole("link").getAttribute("href")).toMatch(/^#\/place\//);

    fireEvent.click(screen.getByTestId("peak-filter-hard"));
    expect(names()).toEqual(["Петрос"]);
    expect(screen.getByTestId("peak-filter-hard").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("peak-filter-expert")).toBeNull();

    fireEvent.click(screen.getByTestId("peak-filter-all"));
    fireEvent.click(screen.getByTestId("peak-sort-distance"));
    expect(names()[0]).toBe("Маковиця");
    fireEvent.click(screen.getByTestId("peak-sort-height"));
    expect(names()[0]).toBe("Говерла");
  });

  it("без відстані сортування «Ближчі» не показується", () => {
    render(
      <GuideProvider value={env()}>
        <PeakList places={[place("A", d("easy")), place("B", d("hard"))]} />
      </GuideProvider>,
    );
    expect(screen.queryByTestId("peak-sort-distance")).toBeNull();
  });

  it("екран: категорія peaks за кодом, у списку — лише вершини", async () => {
    const search = vi.fn(async () => [LIST[0]!, { ...LIST[1]!, peak: null }]);
    const api = {
      categories: vi.fn(async () => [
        { id: "nearby", parentId: null, code: "nearby", name: { uk: "Що поруч" }, homeSection: "nearby" },
        { id: "pk", parentId: "nearby", code: "peaks", name: { uk: "Вершини" }, homeSection: null },
      ]),
      search,
    } as unknown as GuideApi;
    render(
      <GuideProvider value={env({ api })}>
        <Peaks />
      </GuideProvider>,
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ categoryId: "pk" }));
    expect(names()).toEqual(["Говерла"]);
    expect(screen.getByTestId("peak-rule").textContent).toContain("до 500 м");
  });
});

describe("блок вершини в картці", () => {
  const hoverla = peak({
    slug: "hoverla",
    heightM: 2061,
    difficulty: "moderate",
    route: {
      start: { uk: "База «Заросляк»" },
      startLocation: { lat: 48.164167, lng: 24.5375 },
      roundTripKm: null,
      elevationGainM: 731,
      gainKind: "difference",
      upHours: 3,
      downHours: 2,
      totalHours: 5,
      trail: { uk: "Синій маркер" },
    },
    warnings: [{ uk: "Взимку — лише з гідом і спорядженням." }],
    weatherPoint: { lat: 48.1602, lng: 24.5003 },
  });

  it("параметри маршруту, старт у Google Карти, попередження, джерела; погода на вершині", async () => {
    const forecast = vi.fn(async () => ({
      source: "open-meteo" as const,
      current: { temperature: -3, condition: null, iconUrl: null } as never,
      days: [{ temperatureMin: -8, temperatureMax: -1, warnings: ["strong_wind"] } as never],
    }));
    render(
      <GuideProvider value={env({ weather: { forecast } as WeatherApi })}>
        <PeakDetails peak={hoverla} name="Говерла" placeLocation={{ lat: 48.16, lng: 24.5 }} />
      </GuideProvider>,
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const box = within(screen.getByTestId("peak-details"));
    expect(box.getByTestId("peak-badge").textContent).toBe("Середня");
    expect(box.getByTestId("peak-summary").textContent).toBe("набір ~731 м · 5 год");
    expect(box.getByText("2061 м")).toBeTruthy();
    expect(box.getByText("↑ 3 год · ↓ 2 год (разом 5 год)")).toBeTruthy();
    expect(box.getByText("731 м (різниця висот старту й вершини)")).toBeTruthy();
    expect(box.getByTestId("peak-route").getAttribute("href")).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=48.164167,24.5375",
    );
    expect(box.getByTestId("peak-season").textContent).toContain("з гідом");
    expect(box.getByTestId("peak-sources").textContent).toContain("Вікіпедія");
    expect(forecast).toHaveBeenCalledWith({ lat: 48.1602, lng: 24.5003 }, expect.anything());
    expect(box.getByTestId("peak-weather").textContent).toContain("−3");
    // Без флага ассистента — кнопки «Спланувати похід» нет.
    expect(box.queryByTestId("peak-plan")).toBeNull();
  });

  it("без маршруту — «немає даних», маршрут до вершини; «Спланувати похід» з ассистентом", () => {
    render(
      <FeatureFlagsProvider flags={{ "module.assistant": true }}>
        <GuideProvider value={env({ signedIn: true })}>
          <PeakDetails
            peak={peak({ heightM: null })}
            name="Синяк"
            placeLocation={{ lat: 48.39, lng: 24.46 }}
          />
        </GuideProvider>
      </FeatureFlagsProvider>,
    );
    expect(screen.getByTestId("peak-no-data")).toBeTruthy();
    expect(screen.getByTestId("peak-badge").textContent).toBe("Немає даних");
    expect(screen.getByTestId("peak-route").textContent).toBe("Маршрут до вершини");
    expect(screen.queryByTestId("peak-weather")).toBeNull();
    expect(decodeURIComponent(screen.getByTestId("peak-plan").getAttribute("href")!)).toBe(
      "#/assistant?q=Хочу сходити на вершину Синяк. Сплануй похід на день.",
    );
  });
});

describe("адаптер", () => {
  it("peakOf: джерела лише https; api без поля — null", () => {
    const dto = {
      slug: "hoverla",
      heightM: 2061,
      range: "chornohora",
      difficulty: "moderate",
      route: null,
      note: null,
      warnings: [],
      sources: [
        { title: "ok", url: "https://uk.wikipedia.org/w/index.php?oldid=1" },
        { title: "bad", url: "javascript:alert(1)" },
      ],
      weatherPoint: null,
    } as ApiSchemas["PeakDto"];
    expect(peakOf(dto)!.sources.map((s) => s.title)).toEqual(["ok"]);
    expect(peakOf(undefined)).toBeNull();
    expect(peakOf(null)).toBeNull();
  });
});
