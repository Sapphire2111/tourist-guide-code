// Unit: «Мій план» — параметры поездки (свой план, правка), варианты с галочками по частям дня, подпись «что это»,
// «потрібен транспорт», «якщо дощ», адаптер PATCH (addItem / параметры).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createApiClient } from "@tg/api-client";
import { FeatureFlagsProvider, I18nProvider } from "@tg/ui";
import { noopAnalytics } from "../guide/analytics.js";
import { GuideProvider, noopGuideApi } from "../guide/context.js";
import { HostProvider, noopHostApi, type HostEnv } from "../host/context.js";
import { createHostApi, seasonOfDate } from "../host/host-api.js";
import { ConflictError, type HostApi, type PlanOption, type UserPlan } from "../host/types.js";
import { MyPlan, NewPlanScreen, PLAN_WAIT_MS, SavedPlanScreen } from "./MyPlan.js";
import { markPlanPartial } from "./partial-notice.js";

afterEach(() => {
  cleanup();
  window.location.hash = "";
});

const HOTEL = "00000000-0000-4000-8000-000000000201";
const PLAN = "00000000-0000-4000-8000-000000000901";

function setup(
  ui: ReactNode,
  api: Partial<HostApi>,
  env: Partial<HostEnv> = {},
  signedIn = true,
  flags: Record<string, boolean> = {},
) {
  const host: HostEnv = {
    api: { ...noopHostApi(), ...api },
    hotelPlaceId: HOTEL,
    entryContextId: null,
    staff: "no",
    timeZone: "Europe/Kyiv",
    ...env,
  };
  return render(
    <I18nProvider locale="uk">
      <FeatureFlagsProvider flags={{ "module.host_requests": true, ...flags }}>
        <GuideProvider
          value={{ api: noopGuideApi(), analytics: noopAnalytics, base: null, regionId: "r", signedIn }}
        >
          <HostProvider value={host}>{ui}</HostProvider>
        </GuideProvider>
      </FeatureFlagsProvider>
    </I18nProvider>,
  );
}

const option = (id: string, name: string, over: Partial<PlanOption> = {}): PlanOption => ({
  place: { id, name: { uk: name }, categoryName: { uk: "Ресторани" } },
  kind: "restaurants",
  reason: "lunch",
  distanceMeters: 600,
  travel: "walk",
  travelMinutes: 10,
  kidsFriendly: false,
  ...over,
});

const plan = (over: Partial<UserPlan> = {}): UserPlan => ({
  id: PLAN,
  scenarioId: null,
  title: { uk: "Мій план" },
  schedule: [{ day: 1, items: [] }],
  scenarioUpdated: false,
  updatedAt: "",
  startDate: "2026-11-10",
  trip: { adults: 2, children: 1, withCar: false, days: 1 },
  base: { uk: "Hotel Sofia" },
  options: [
    {
      day: 1,
      slots: [
        {
          slot: "morning",
          options: [option("m1", "Кав'ярня «Ранок»", { kind: "cafes", reason: "breakfast" })],
        },
        {
          slot: "afternoon",
          options: [
            option("a1", "Водоспад Пробій", { kind: "waterfall", reason: "walk" }),
            option("a2", "Колиба «Гражда»", {
              kind: "unknown-kind",
              travel: "transport",
              travelMinutes: 15,
              distanceMeters: 6200,
            }),
          ],
        },
        { slot: "evening", options: [] },
        { slot: "rain", options: [option("r1", "Музей писанки", { kind: "museums", reason: "indoor" })] },
      ],
    },
  ],
  weather: [],
  weatherSource: null,
  generation: null,
  ...over,
});

describe("Мій план: погода", () => {
  const day = {
    day: 1,
    date: "2026-11-10",
    condition: "thunderstorm" as const,
    description: "Гроза",
    iconUrl: null,
    temperatureMax: 9.4,
    temperatureMin: -1.2,
    precipitationSum: 12,
    precipitationProbabilityMax: 80,
    snowfallSum: null,
    windSpeedMax: 30,
    windGustsMax: 70,
    rainy: true,
    warnings: ["thunderstorm" as const, "strong_wind" as const],
    noMountains: true,
  };
  it("день: иконка и t°, предупреждения, без гор, «якщо дощ» раскрыт; поход — с предупреждением; подпись Google", async () => {
    const hike = {
      id: "i1",
      time: "10:00",
      place: { id: "p1", name: { uk: "Гора Хом'як" } },
      note: null,
      alternatives: [],
      distanceMeters: null,
      slot: "morning" as const,
      weatherWarnings: ["thunderstorm" as const],
    };
    setup(
      <SavedPlanScreen id={PLAN} />,
      {
        plan: async () =>
          plan({ schedule: [{ day: 1, items: [hike] }], weather: [day], weatherSource: "google" }),
      },
      {},
      true,
      { "module.weather": true },
    );
    const w = await screen.findByTestId("plan-day-weather");
    expect(w.textContent).toContain("+9° / −1°");
    expect(within(w).getByRole("img", { name: "Гроза" })).toBeTruthy();
    expect(screen.getByTestId("plan-day-warnings").textContent).toContain(
      "Сильний вітер — у горах небезпечно",
    );
    expect(screen.getByTestId("plan-no-mountains")).toBeTruthy();
    // «Якщо дощ» раскрыт сам: по прогнозу дождь.
    expect(screen.getByTestId("plan-rain-forecast")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Якщо дощ/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("plan-item-weather").textContent).toContain("Похід у гори: гроза");
    expect(screen.getByTestId("weather-source").textContent).toBe(
      "Source: Includes weather data from Google.",
    );
  });

  it("план перечитан с дождём в прогнозе — «якщо дощ» раскрывается", async () => {
    const updatePlan = vi.fn(async () => plan({ weather: [day], weatherSource: "open-meteo" }));
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan(), updatePlan }, {}, true, {
      "module.weather": true,
    });
    const rain = await screen.findByRole("button", { name: /Якщо дощ/ });
    expect(rain.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Змінити параметри" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Зберегти параметри" })));
    expect(updatePlan).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Якщо дощ/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("без даты начала — подсказка про погоду; без флага — ничего; «якщо дощ» без дождя свёрнут", async () => {
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan({ startDate: null }) }, {}, true, {
      "module.weather": true,
    });
    expect(await screen.findByTestId("plan-weather-nodate")).toBeTruthy();
    expect(screen.queryByTestId("weather-source")).toBeNull();
    expect(screen.getByRole("button", { name: /Якщо дощ/ }).getAttribute("aria-expanded")).toBe("false");
    cleanup();
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan({ startDate: null }) });
    await screen.findByTestId("trip-line");
    expect(screen.queryByTestId("plan-weather-nodate")).toBeNull();
  });
});

describe("Мій план: параметри поїздки", () => {
  it("«Скласти свій план»: дорослі, діти, без авто, дні → createPlan с базой из QR → экран плана", async () => {
    setup(<MyPlan tab="scenarios" />, { scenarios: async () => [] });
    expect(screen.getByRole("link", { name: "Скласти свій план" }).getAttribute("href")).toContain(
      "/plan/new",
    );
    cleanup();
    const createPlan = vi.fn(async () => plan());
    setup(<NewPlanScreen />, { createPlan });
    fireEvent.click(screen.getByRole("button", { name: "Більше: Дорослі" }));
    fireEvent.click(screen.getByRole("button", { name: "Більше: Діти" }));
    fireEvent.click(screen.getByRole("button", { name: "Більше: Днів" }));
    fireEvent.click(screen.getByRole("button", { name: "Більше: Днів" }));
    expect(screen.getByRole("button", { name: "Менше: Діти" })).not.toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Без авто" }));
    expect(screen.getByRole("button", { name: "Без авто" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/не пропонуємо бари й нічні клуби/)).toBeTruthy();
    expect(screen.getByText(/куди можна дійти пішки/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Дата початку (необов'язково)"), {
      target: { value: "2026-11-10" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Підібрати варіанти" })));
    // Без флага planner.ai — без выбора интересов.
    expect(screen.queryByTestId("trip-interests")).toBeNull();
    expect(createPlan).toHaveBeenCalledWith(
      {
        adults: 3,
        children: 1,
        withCar: false,
        days: 3,
        startDate: "2026-11-10",
        basePlaceId: HOTEL,
      },
      expect.any(String),
    );
    expect(window.location.hash).toBe(`#/plan/saved/${PLAN}`);
  });

  it("без сессии — просим войти; дорослих не меньше 1", () => {
    setup(<NewPlanScreen />, {}, {}, false);
    expect(screen.getByTestId("plan-login")).toBeTruthy();
    cleanup();
    setup(<NewPlanScreen />, {});
    fireEvent.click(screen.getByRole("button", { name: "Менше: Дорослі" }));
    expect(screen.getByRole("button", { name: "Менше: Дорослі" })).toHaveProperty("disabled", true);
  });

  it("правка параметров: меньше дней — предупреждение; сохранение — PATCH trip", async () => {
    const updatePlan = vi.fn<HostApi["updatePlan"]>(async () => plan({ trip: { ...plan().trip, days: 1 } }));
    setup(<SavedPlanScreen id={PLAN} />, {
      plan: async () =>
        plan({ trip: { ...plan().trip, days: 2 }, schedule: [1, 2].map((day) => ({ day, items: [] })) }),
      updatePlan,
    });
    expect((await screen.findByTestId("trip-line")).textContent).toBe(
      "Дорослих: 2 · Дітей: 1 · Без авто · Днів: 2",
    );
    expect(screen.getByText("Відстані — по прямій від: Hotel Sofia")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Змінити параметри" }));
    fireEvent.click(screen.getByRole("button", { name: "Менше: Днів" }));
    expect(screen.getByText("Місця, обрані для днів після 1-го, буде прибрано з плану.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Зберегти параметри" })));
    expect(updatePlan).toHaveBeenCalledWith(PLAN, {
      trip: { adults: 2, children: 1, withCar: false, days: 1, startDate: "2026-11-10" },
    });
    expect(screen.getByTestId("plan-status").textContent).toBe("Параметри збережено — варіанти оновлено.");
    expect(screen.queryByTestId("trip-form")).toBeNull();
  });
});

describe("Мій план: частично добавленный ассистентом", () => {
  it("флаг ассистента — «Додано не все місця» один раз; без флага — нет", async () => {
    markPlanPartial(PLAN);
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan() });
    expect((await screen.findByTestId("plan-partial")).textContent).toContain("Додано не все місця");
    cleanup();
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan() });
    await screen.findByRole("region", { name: /День 1/ });
    expect(screen.queryByTestId("plan-partial")).toBeNull();
  });
});

describe("Мій план: варіанти на вибір", () => {
  it("части дня с вариантами: что это, почему, сколько идти; «потрібен транспорт»; день с датой", async () => {
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan() });
    const day = await screen.findByRole("region", { name: /День 1/ });
    expect(within(day).getByRole("heading", { level: 2 }).textContent).toMatch(/День 1 · вт, 10\.11/);
    const afternoon = screen.getByTestId("plan-slot-afternoon");
    const [waterfall, kolyba] = within(afternoon).getAllByTestId("plan-option");
    expect(within(waterfall!).getByTestId("option-kind").textContent).toBe("Водоспад");
    expect(waterfall!.textContent).toContain("Прогулянка й краєвиди");
    expect(waterfall!.textContent).toContain("≈ 10 хв пішки");
    // Неизвестный вид — название категории из справочника.
    expect(within(kolyba!).getByTestId("option-kind").textContent).toBe("Ресторани");
    expect(kolyba!.textContent).toContain("Потрібен транспорт: ≈ 15 хв на авто");
    expect(kolyba!.textContent).toContain("6,2 км");
    expect(within(screen.getByTestId("plan-slot-evening")).getByText(/немає відповідних місць/)).toBeTruthy();
    const rain = screen.getByTestId("plan-slot-rain");
    // План Б свёрнут: кнопка-заголовок.
    const toggle = within(rain).getByRole("button", { name: "Якщо дощ — план Б" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(rain).getByText("Під дахом — підійде в дощ").closest("[hidden]")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(rain).getByText("Під дахом — підійде в дощ")).toBeTruthy();
    expect(within(rain).getByRole("link", { name: "Деталі: Музей писанки" }).getAttribute("href")).toContain(
      "/place/r1",
    );
  });

  it("галочка — PATCH add в эту часть дня; выбранное — отмечено, остальное свёрнуто в «Ще варіанти»", async () => {
    const chosen = plan({
      schedule: [
        {
          day: 1,
          items: [
            {
              id: "i1",
              time: null,
              place: { id: "a1", name: { uk: "Водоспад Пробій" } },
              note: null,
              alternatives: [],
              distanceMeters: null,
              slot: "afternoon",
            },
          ],
        },
      ],
    });
    chosen.options[0]!.slots[1]!.options.shift();
    const updatePlan = vi.fn<HostApi["updatePlan"]>(async () => chosen);
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan(), updatePlan });
    const box = await screen.findByRole("checkbox", { name: "Водоспад Пробій" });
    await act(async () => fireEvent.click(box));
    expect(updatePlan).toHaveBeenCalledWith(PLAN, { add: { day: 1, slot: "afternoon", placeId: "a1" } });
    expect(screen.getByTestId("plan-status").textContent).toBe("Додано в план: Водоспад Пробій");
    const afternoon = screen.getByTestId("plan-slot-afternoon");
    expect(within(afternoon).getByRole("checkbox", { name: "Водоспад Пробій" })).toHaveProperty(
      "checked",
      true,
    );
    const more = within(afternoon).getByText("Ще варіанти: 1").closest("details")!;
    expect(more.open).toBe(false);
  });
});

describe("Мій план: галочки — відкат, блокування, фокус", () => {
  it("409: галочка возвращается, текст errors.plan.*, план перечитан", async () => {
    let fail: (e: unknown) => void = () => undefined;
    const updatePlan = vi.fn<HostApi["updatePlan"]>(() => new Promise((_, reject) => (fail = reject)));
    const reloaded = plan({ title: { uk: "Перечитаний план" } });
    const planFn = vi.fn<HostApi["plan"]>().mockResolvedValueOnce(plan()).mockResolvedValueOnce(reloaded);
    setup(<SavedPlanScreen id={PLAN} />, { plan: planFn, updatePlan });
    const box = await screen.findByRole("checkbox", { name: "Водоспад Пробій" });
    fireEvent.click(box);
    // Пока идёт запрос: галочка поставлена сразу, остальные — aria-disabled, клики игнорируются.
    expect(box).toHaveProperty("checked", true);
    const other = screen.getByRole("checkbox", { name: "Колиба «Гражда»" });
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(other).toHaveProperty("disabled", false);
    fireEvent.click(other);
    expect(updatePlan).toHaveBeenCalledTimes(1);
    await act(async () => fail(new ConflictError("errors.plan.alreadyInPlan")));
    expect(screen.getByTestId("plan-status").textContent).toBe("Це місце вже є в плані на цей день.");
    expect(planFn).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("heading", { level: 1, name: "Перечитаний план" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Водоспад Пробій" })).toHaveProperty("checked", false);
  });

  it("после ответа фокус — на галочку того же места в списке выбранного", async () => {
    const chosen = plan({
      schedule: [
        {
          day: 1,
          items: [
            {
              id: "i1",
              time: null,
              place: { id: "a1", name: { uk: "Водоспад Пробій" } },
              note: null,
              alternatives: [],
              distanceMeters: null,
              slot: "afternoon",
            },
          ],
        },
      ],
    });
    chosen.options[0]!.slots[1]!.options.shift();
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan(), updatePlan: async () => chosen });
    const box = await screen.findByRole("checkbox", { name: "Водоспад Пробій" });
    box.focus();
    await act(async () => fireEvent.click(box));
    const now = within(screen.getByTestId("plan-slot-afternoon")).getAllByTestId("plan-item")[0]!;
    expect(document.activeElement).toBe(within(now).getByRole("checkbox"));
  });
});

describe("Мій план: згорнуті дні", () => {
  it("открыт первый день; остальные свёрнуты с «Обрано: N»; в части дня — 3 варианта и «Ще варіанти»", async () => {
    const two = plan({
      trip: { ...plan().trip, days: 2 },
      schedule: [1, 2].map((day) => ({ day, items: [] })),
    });
    two.options.push({ ...two.options[0]!, day: 2 });
    two.options[0]!.slots[1]!.options.push(option("a3", "Ресторан «Три»"), option("a4", "Ресторан «Чотири»"));
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => two });
    const [day1, day2] = await screen.findAllByTestId("plan-day");
    const [b1, b2] = [day1!, day2!].map((d) => within(d).getByRole("button", { name: /День/ }));
    expect(b1!.getAttribute("aria-expanded")).toBe("true");
    expect(b2!.getAttribute("aria-expanded")).toBe("false");
    expect(within(day2!).getByTestId("day-chosen").textContent).toBe("Обрано: 0");
    expect(within(day2!).getByTestId("plan-slot-morning").closest("[hidden]")).toBeTruthy();
    const afternoon = within(day1!).getByTestId("plan-slot-afternoon");
    const more = within(afternoon).getByText("Ще варіанти: 1").closest("details")!;
    expect(more.open).toBe(false);
    expect(within(afternoon).getAllByTestId("plan-option")).toHaveLength(4);
    fireEvent.click(b2!);
    expect(b2!.getAttribute("aria-expanded")).toBe("true");
    expect(within(day2!).getByTestId("plan-slot-morning").closest("[hidden]")).toBeNull();
  });
});

describe("адаптер host-api: «Мій план»", () => {
  it("POST без сценария с параметрами; PATCH addItem и параметры; slot и варианты из DTO", async () => {
    const calls: { method: string; body: unknown }[] = [];
    const dto = {
      id: PLAN,
      regionId: "reg",
      scenarioId: null,
      scenarioVersion: null,
      scenarioUpdated: false,
      title: { uk: "Мій план" },
      startDate: null,
      trip: { adults: 2, children: 0, withCar: true, days: 1, base: null },
      plan: [{ dayNo: 1, items: [] }],
      options: [
        {
          dayNo: 1,
          slots: [
            {
              slot: "morning",
              options: [
                {
                  place: {
                    id: "p1",
                    categoryId: "c",
                    name: { uk: "Кафе" },
                    address: null,
                    location: { lon: 24, lat: 48 },
                    categoryName: { uk: "Кафе" },
                  },
                  kind: "cafes",
                  reason: "breakfast",
                  distanceMeters: 100,
                  travel: "walk",
                  travelMinutes: 2,
                  kidsFriendly: false,
                },
              ],
            },
          ],
        },
      ],
      createdAt: "",
      updatedAt: "",
    };
    const fetchMock = vi.fn(async (req: Request) => {
      calls.push({ method: req.method, body: await req.json() });
      return new Response(JSON.stringify(dto), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const api = createHostApi(createApiClient({ baseUrl: "http://api", fetch: fetchMock }), "reg");
    const p = await api.createPlan({ adults: 2, children: 0, withCar: true, days: 1 });
    expect(p.options[0]!.slots[0]!.options[0]).toMatchObject({ kind: "cafes", place: { id: "p1" } });
    await api.updatePlan(PLAN, { add: { day: 1, slot: "rain", placeId: "p1" } });
    await api.updatePlan(PLAN, { trip: { days: 3, withCar: false } });
    expect(calls.map((c) => c.body)).toEqual([
      { regionId: "reg", adults: 2, children: 0, withCar: true, days: 1 },
      { regionId: "reg", addItem: { dayNo: 1, slot: "rain", placeId: "p1" } },
      { regionId: "reg", days: 3, withCar: false },
    ]);
  });
});

describe("Мій план: сценарії за датою поїздки", () => {
  it("дата поїздки → сценарии её сезона; сезон даты — как в api", async () => {
    const scenarios = vi.fn(async (_d?: string | null) => []);
    setup(<MyPlan tab="scenarios" />, { scenarios });
    await act(async () => {});
    expect(scenarios).toHaveBeenLastCalledWith(null);
    await act(async () => {
      fireEvent.change(screen.getByTestId("scenarios-date"), { target: { value: "2027-07-10" } });
    });
    expect(scenarios).toHaveBeenLastCalledWith("2027-07-10");
    expect(seasonOfDate("2027-07-10")).toBe("summer");
    expect(seasonOfDate("2026-12-01")).toBe("winter");
    expect(seasonOfDate("2027-03-31")).toBe("spring");
    expect(seasonOfDate("2027-11-30")).toBe("autumn");
  });
});

describe("Мій план: живий план через Claude (planner.ai)", () => {
  const AI = { "planner.ai": true };

  it("«Скласти план»: «Складаємо план…» пока ждём; fallback — подсказка один раз на экране плана", async () => {
    let resolve: (p: UserPlan) => void = () => undefined;
    const createPlan = vi.fn(() => new Promise<UserPlan>((r) => (resolve = r)));
    setup(<NewPlanScreen />, { createPlan }, {}, true, AI);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Скласти план" })));
    expect(screen.getByTestId("plan-status").textContent).toBe("Складаємо план… Це займе до хвилини.");
    expect(screen.getByRole("button", { name: "Скласти план" })).toHaveProperty("disabled", true);
    await act(async () => resolve(plan({ generation: "fallback" })));
    expect(window.location.hash).toBe(`#/plan/saved/${PLAN}`);
    cleanup();
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan() }, {}, true, AI);
    expect((await screen.findByTestId("plan-ai-fallback")).textContent).toContain("оберіть варіанти");
    cleanup();
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan() }, {}, true, AI);
    await screen.findByRole("region", { name: /День 1/ });
    expect(screen.queryByTestId("plan-ai-fallback")).toBeNull();
  });

  it("без вечного ожидания: дольше PLAN_WAIT_MS — сообщение и «Збережені плани»; повтор — тот же Idempotency-Key", async () => {
    vi.useFakeTimers();
    try {
      const createPlan = vi.fn<HostApi["createPlan"]>(() => new Promise<UserPlan>(() => undefined));
      setup(<NewPlanScreen />, { createPlan }, {}, true, AI);
      fireEvent.click(screen.getByRole("button", { name: "Гастро" }));
      expect(screen.getByRole("button", { name: "Гастро" }).getAttribute("aria-pressed")).toBe("true");
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Скласти план" })));
      await act(async () => vi.advanceTimersByTime(PLAN_WAIT_MS + 1));
      expect(screen.getByTestId("plan-status").textContent).toBe(
        "План складається задовго. Спробуйте ще раз.",
      );
      expect(screen.getByTestId("plan-open-saved").getAttribute("href")).toContain("/plan/saved");
      expect(screen.getByRole("button", { name: "Скласти план" })).toHaveProperty("disabled", false);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Скласти план" })));
      expect(createPlan).toHaveBeenCalledTimes(2);
      const [first, second] = createPlan.mock.calls;
      expect(first![0]).toMatchObject({ interests: ["gastro"] });
      expect(second![1]).toBe(first![1]);
      expect(PLAN_WAIT_MS).toBeLessThan(100_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("«Інший варіант» при пунктах в плане — сначала подтверждение; 409 — сообщение и план перечитан", async () => {
    const withItem = plan({
      schedule: [
        {
          day: 1,
          items: [
            {
              id: "i1",
              time: "10:00",
              durationMin: 60,
              place: { id: "m1", name: { uk: "Кав'ярня «Ранок»" } },
              note: null,
              alternatives: [],
              distanceMeters: null,
              slot: "morning",
            },
          ],
        },
      ],
    } as unknown as Partial<UserPlan>);
    const planFn = vi.fn(async () => withItem);
    const regeneratePlan = vi.fn<HostApi["regeneratePlan"]>(async () => {
      throw new ConflictError("errors.plan.changedMeanwhile");
    });
    setup(<SavedPlanScreen id={PLAN} />, { plan: planFn, regeneratePlan }, {}, true, AI);
    fireEvent.click(await screen.findByRole("button", { name: "Інший варіант" }));
    expect(screen.getByText("Новий варіант замінить ваш план разом із вашими змінами.")).toBeTruthy();
    expect(regeneratePlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Залишити як є" }));
    expect(screen.queryByTestId("plan-replace-confirm")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Інший варіант" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Замінити план" })));
    expect(regeneratePlan).toHaveBeenCalledWith(PLAN, expect.any(String));
    expect(screen.getByTestId("plan-status").textContent).toContain("План змінився");
    expect(planFn).toHaveBeenCalledTimes(2);
  });

  it("«Інший варіант»: новый план с теми же параметрами; не вышло — план без изменений; без флага — кнопки нет", async () => {
    const next = plan({ title: { uk: "Інший день" }, generation: "ai" });
    const regeneratePlan = vi.fn<HostApi["regeneratePlan"]>(async () => next);
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan(), regeneratePlan }, {}, true, AI);
    const another = await screen.findByRole("button", { name: "Інший варіант" });
    await act(async () => fireEvent.click(another));
    expect(regeneratePlan).toHaveBeenCalledWith(PLAN, expect.any(String));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Інший день");
    expect(screen.getByTestId("plan-status").textContent).toBe("Готово: новий варіант плану.");
    regeneratePlan.mockResolvedValueOnce(plan({ generation: "fallback" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Інший варіант" })));
    expect(screen.getByTestId("plan-status").textContent).toBe(
      "Не вдалося скласти інший варіант — план без змін.",
    );
    cleanup();
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan() });
    await screen.findByRole("region", { name: /День 1/ });
    expect(screen.queryByTestId("plan-regenerate")).toBeNull();
    cleanup();
    // План из сценария — без «Інший варіант».
    setup(<SavedPlanScreen id={PLAN} />, { plan: async () => plan({ scenarioId: "sc1" }) }, {}, true, AI);
    await screen.findByRole("region", { name: /День 1/ });
    expect(screen.queryByTestId("plan-regenerate")).toBeNull();
  });

  it("адаптер: POST /me/plan/{id}/regenerate с регионом; generation из ответа", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const dto = {
      id: PLAN,
      regionId: "reg",
      scenarioId: null,
      scenarioVersion: null,
      scenarioUpdated: false,
      title: { uk: "Мій план" },
      startDate: null,
      trip: { adults: 2, children: 0, withCar: true, days: 1, base: null },
      plan: [{ dayNo: 1, items: [] }],
      options: [],
      weather: [],
      weatherSource: null,
      generation: "ai",
      createdAt: "",
      updatedAt: "",
    };
    const fetchMock = vi.fn(async (req: Request) => {
      calls.push({ url: req.url, body: await req.json() });
      return new Response(JSON.stringify(dto), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const api = createHostApi(createApiClient({ baseUrl: "http://api", fetch: fetchMock }), "reg");
    expect((await api.regeneratePlan(PLAN)).generation).toBe("ai");
    expect(calls).toEqual([{ url: `http://api/me/plan/${PLAN}/regenerate`, body: { regionId: "reg" } }]);
  });
});
