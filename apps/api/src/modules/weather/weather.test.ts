// Unit (без БД и сети): прогноз погоды — разбор Google Weather и Open-Meteo, предупреждения, выбор ближайшей точки,
// снимки и ленивое обновление, запасной источник (429, предел квоты, ошибка), период обновления по квоте, HTTP GET
// /weather (валидация, «прогноза нет» — 200 без кеша). fetch и хранилище подменены.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule, type JsonObject } from "../../db/index.js";
import { FeatureFlagsModule, FeatureFlagsService } from "../feature-flags/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
} from "../rbac/index.js";
import { googleCondition, googleIcon, parseGoogleCurrent, parseGoogleDays } from "./google-weather.js";
import { MOUNTAIN_POINTS, nearestPoint } from "./weather-points.js";
import { WeatherController } from "./weather.controller.js";
import type { WeatherRepository, WeatherRow } from "./weather.repository.js";
import { dayWarnings, parseOpenMeteo, wmoCondition, type Forecast } from "./weather-rules.js";
import { contentHash, refreshEveryMs, todayIn, WeatherService } from "./weather.service.js";

const NOW = Date.parse("2026-11-03T08:00:00Z");
const YAREMCHE = { lat: 48.45, lng: 24.55 };

const openMeteoBody = (over: Record<string, unknown[]> = {}) => ({
  latitude: 48.45,
  longitude: 24.55,
  elevation: 530,
  timezone: "Europe/Kyiv",
  current: { time: "2026-11-03T10:00", temperature_2m: 2.4, weather_code: 3, wind_speed_10m: 8, is_day: 1 },
  daily: {
    time: ["2026-11-03", "2026-11-04", "2026-11-05"],
    weather_code: [3, 95, 75],
    temperature_2m_max: [6, 9, -4],
    temperature_2m_min: [-1, 2, -12],
    precipitation_sum: [0, 25, 12],
    rain_sum: [0, 25, 0],
    showers_sum: [0, 0, 0],
    snowfall_sum: [0, 0, 14],
    precipitation_probability_max: [10, 90, 80],
    wind_speed_10m_max: [10, 25, 45],
    wind_gusts_10m_max: [20, 50, 75],
    ...over,
  },
});

const gPart = (type: string, over: Record<string, unknown> = {}) => ({
  weatherCondition: {
    iconBaseUri: `https://maps.gstatic.com/weather/v1/${type.toLowerCase()}`,
    description: { text: type === "CLEAR" ? "Ясно" : "Гроза", languageCode: "uk" },
    type,
  },
  precipitation: { probability: { percent: 10, type: "RAIN" }, qpf: { quantity: 0, unit: "MILLIMETERS" } },
  thunderstormProbability: 0,
  wind: {
    speed: { value: 10, unit: "KILOMETERS_PER_HOUR" },
    gust: { value: 20, unit: "KILOMETERS_PER_HOUR" },
  },
  ...over,
});
const googleDaysBody = {
  forecastDays: [
    {
      displayDate: { year: 2026, month: 11, day: 3 },
      daytimeForecast: gPart("CLEAR"),
      nighttimeForecast: gPart("CLEAR"),
      maxTemperature: { degrees: 7, unit: "CELSIUS" },
      minTemperature: { degrees: 0, unit: "CELSIUS" },
    },
    {
      displayDate: { year: 2026, month: 11, day: 4 },
      daytimeForecast: gPart("THUNDERSTORM", {
        precipitation: {
          probability: { percent: 80, type: "RAIN" },
          qpf: { quantity: 9, unit: "MILLIMETERS" },
        },
      }),
      nighttimeForecast: gPart("CLOUDY", {
        wind: {
          speed: { value: 30, unit: "KILOMETERS_PER_HOUR" },
          gust: { value: 65, unit: "KILOMETERS_PER_HOUR" },
        },
      }),
      maxTemperature: { degrees: 9, unit: "CELSIUS" },
      minTemperature: { degrees: 3, unit: "CELSIUS" },
    },
  ],
  timeZone: { id: "Europe/Kyiv" },
};
const googleCurrentBody = {
  currentTime: "2026-11-03T08:00:00Z",
  timeZone: { id: "Europe/Kyiv" },
  isDaytime: true,
  weatherCondition: {
    iconBaseUri: "https://maps.gstatic.com/weather/v1/cloudy",
    description: { text: "Хмарно", languageCode: "uk" },
    type: "CLOUDY",
  },
  temperature: { degrees: 2.1, unit: "CELSIUS" },
  wind: { speed: { value: 7, unit: "KILOMETERS_PER_HOUR" } },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("разбор источников и предупреждения", () => {
  it("Open-Meteo: погода по коду WMO, гроза и сильный дождь, снегопад, мороз и ветер; «якщо дощ» по дождю", () => {
    const f = parseOpenMeteo(openMeteoBody())!;
    expect(f).toMatchObject({ source: "open-meteo", elevation: 530, timezone: "Europe/Kyiv" });
    expect(f.current).toMatchObject({ temperature: 2.4, condition: "cloudy", isDay: true, iconUrl: null });
    expect(f.days.map((d) => [d.date, d.condition, d.rainy, d.warnings])).toEqual([
      ["2026-11-03", "cloudy", false, []],
      ["2026-11-04", "thunderstorm", true, ["thunderstorm", "heavy_rain"]],
      ["2026-11-05", "heavy_snow", false, ["strong_wind", "frost", "heavy_snow"]],
    ]);
    expect(parseOpenMeteo({ latitude: 1 })).toBeNull();
    expect(parseOpenMeteo("oops")).toBeNull();
  });

  it("пороги: жара от 32 °C, ветер от 40 км/ч, ледяной дождь — гололёд; нет значений — нет предупреждений", () => {
    const base = {
      conditions: [],
      temperatureMax: null,
      temperatureMin: null,
      liquidMm: null,
      snowfallCm: null,
      windSpeedMax: null,
      windGustsMax: null,
    };
    expect(dayWarnings(base)).toEqual([]);
    expect(dayWarnings({ ...base, temperatureMax: 32 })).toEqual(["heat"]);
    expect(dayWarnings({ ...base, windSpeedMax: 40 })).toEqual(["strong_wind"]);
    expect(dayWarnings({ ...base, conditions: [wmoCondition(67)] })).toEqual(["ice"]);
    expect(dayWarnings({ ...base, thunderProbability: 50 })).toEqual(["thunderstorm"]);
  });

  it("Google: дни (день+ночь), описание на украинском, иконка maps.gstatic.com, порывы ночью — сильный ветер", () => {
    const d = parseGoogleDays(googleDaysBody)!;
    expect(d.timezone).toBe("Europe/Kyiv");
    expect(d.days[0]).toMatchObject({
      date: "2026-11-03",
      condition: "clear",
      description: "Ясно",
      iconUrl: "https://maps.gstatic.com/weather/v1/clear.svg",
      temperatureMax: 7,
      rainy: false,
      warnings: [],
    });
    expect(d.days[1]).toMatchObject({
      condition: "thunderstorm",
      rainy: true,
      precipitationSum: 9,
      windGustsMax: 65,
      warnings: ["thunderstorm", "strong_wind"],
    });
    const now = parseGoogleCurrent(googleCurrentBody)!;
    expect(now.now).toMatchObject({
      temperature: 2.1,
      condition: "cloudy",
      description: "Хмарно",
      isDay: true,
    });
    expect(now.now.iconUrl).toBe("https://maps.gstatic.com/weather/v1/cloudy.svg");
    expect(parseGoogleDays({})).toBeNull();
    // Чужой хост иконки — не отдаём.
    expect(googleIcon({ iconBaseUri: "https://evil.example/x" })).toBeNull();
    expect(googleCondition("HEAVY_SNOW_STORM")).toBe("heavy_snow");
    expect(googleCondition("LIGHT_RAIN_SHOWERS")).toBe("showers");
    expect(googleCondition("RAIN_AND_SNOW")).toBe("sleet");
  });

  it("отпечаток содержимого не зависит от времени замера", () => {
    const f = parseOpenMeteo(openMeteoBody())!;
    const later: Forecast = { ...f, current: { ...f.current!, time: "2026-11-03T11:00" } };
    expect(contentHash(later)).toBe(contentHash(f));
    expect(contentHash({ ...f, days: f.days.slice(1) })).not.toBe(contentHash(f));
  });
});

describe("точки и период обновления", () => {
  it("ближайшая точка не дальше 30 км; для похода — горная точка рядом", () => {
    const yaremche = { key: "locality:y", kind: "settlement" as const, ...YAREMCHE };
    const tatariv = { key: "locality:t", kind: "settlement" as const, lat: 48.34, lng: 24.57 };
    const points = [yaremche, tatariv, ...MOUNTAIN_POINTS];
    expect(nearestPoint(points, { lat: 48.44, lng: 24.56 })?.key).toBe("locality:y");
    expect(nearestPoint(points, { lat: 50.45, lng: 30.52 })).toBeNull();
    const nearKhomiak = { lat: 48.352, lng: 24.49 };
    expect(nearestPoint(points, nearKhomiak, { mountain: true })?.key).toBe("mountain:khomiak");
  });

  it("период по квоте Google: 14 точек, 300/сутки, 5000/мес — 5 ч; мало точек — не чаще часа; без ключа — 2 ч", () => {
    expect(refreshEveryMs(14, { daily: 300, monthly: 5000 })).toBe(5 * 3600_000);
    expect(refreshEveryMs(2, { daily: 300, monthly: 5000 })).toBe(3600_000);
    expect(refreshEveryMs(200, { daily: 300, monthly: 5000 })).toBe(6 * 3600_000);
    expect(refreshEveryMs(14, null)).toBe(2 * 3600_000);
  });

  it("сегодня — в поясе точки", () => {
    expect(todayIn("Europe/Kyiv", new Date("2026-11-03T22:30:00Z"))).toBe("2026-11-04");
    expect(todayIn("Bad/Zone", new Date("2026-11-03T10:00:00Z"))).toBe("2026-11-03");
  });
});

/** Хранилище в памяти вместо weather_forecasts и localities. */
function memoryRepo(settlements = [{ key: "locality:y", kind: "settlement" as const, ...YAREMCHE }]) {
  const rows = new Map<string, WeatherRow>();
  const repo = {
    settlementPoints: vi.fn(() => Promise.resolve(settlements)),
    list: vi.fn(() => Promise.resolve([...rows.values()].map((r) => ({ ...r })))),
    syncPoints: vi.fn(
      (points: { key: string; kind: "settlement" | "mountain"; lat: number; lng: number }[]) => {
        for (const p of points)
          if (!rows.has(p.key))
            rows.set(p.key, {
              ...p,
              source: null,
              forecast: null,
              contentHash: null,
              fetchedAt: null,
              updatedAt: new Date(NOW),
            });
        return Promise.resolve();
      },
    ),
    saveForecast: vi.fn(
      (
        key: string,
        s: { source: "google" | "open-meteo"; forecast: JsonObject; contentHash: string; fetchedAt: Date },
      ) => {
        const r = rows.get(key)!;
        rows.set(key, { ...r, ...s, updatedAt: r.contentHash === s.contentHash ? r.updatedAt : s.fetchedAt });
        return Promise.resolve();
      },
    ),
  };
  return { repo, rows };
}

function service(opts: {
  fetch: typeof fetch;
  google?: boolean;
  quota?: boolean;
  repo?: ReturnType<typeof memoryRepo>["repo"];
}) {
  const repo = opts.repo ?? memoryRepo().repo;
  const quota = { take: vi.fn(() => Promise.resolve(opts.quota ?? true)) };
  const s = new WeatherService(
    {
      googleApiKey: opts.google === false ? undefined : "server-key",
      fetch: opts.fetch,
      quota,
    },
    repo as unknown as WeatherRepository,
  );
  let now = NOW;
  s.now = () => now;
  return { s, repo, quota, advance: (ms: number) => (now += ms) };
}

const isGoogle = (url: string) => url.startsWith("https://weather.googleapis.com/");

describe("WeatherService", () => {
  it("Google: ключ в заголовке (не в адресе), 2 единицы квоты, снимок в хранилище; повтор — из снимка", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      expect(url).not.toContain("server-key");
      expect((init?.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("server-key");
      return Promise.resolve(json(url.includes("currentConditions") ? googleCurrentBody : googleDaysBody));
    });
    const { s, repo, quota } = service({ fetch: fetchMock as unknown as typeof fetch });
    const f = await s.forecastAt({ lat: 48.451, lng: 24.552 });
    expect(f).toMatchObject({ source: "google", current: { temperature: 2.1 } });
    expect(f!.days[0]!.date).toBe("2026-11-03");
    expect(quota.take).toHaveBeenCalledTimes(2);
    expect(quota.take).toHaveBeenCalledWith("weather", { daily: 300, monthly: 5000 });
    expect(repo.syncPoints).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ key: "mountain:hoverla" })]),
    );
    expect(repo.saveForecast).toHaveBeenCalledWith(
      "locality:y",
      expect.objectContaining({ source: "google" }),
    );
    await s.forecastAt(YAREMCHE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Иконки — через наш прокси, не maps.gstatic.com.
    expect(f!.current!.iconUrl).toBe("/weather/icons/cloudy.svg");
    expect(f!.days[0]!.iconUrl).toBe("/weather/icons/clear.svg");
  });

  it("прокси иконки: только SVG с maps.gstatic.com, в памяти; чужое имя и не SVG — null", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith("/cloudy.svg")
          ? new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
          : new Response("<html/>", { headers: { "content-type": "text/html" } }),
      ),
    );
    const { s } = service({ fetch: fetchMock as unknown as typeof fetch });
    expect((await s.icon("cloudy"))?.toString()).toBe("<svg/>");
    await s.icon("cloudy");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://maps.gstatic.com/weather/v1/cloudy.svg",
      expect.anything(),
    );
    expect(await s.icon("other")).toBeNull();
    expect(await s.icon("../x")).toBeNull();
  });

  it("Google 429 — запасной Open-Meteo; Google не спрашивается в паузе", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(isGoogle(url) ? json({ error: {} }, 429) : json(openMeteoBody())),
    );
    const { s, advance } = service({ fetch: fetchMock as unknown as typeof fetch });
    expect(await s.forecastAt(YAREMCHE)).toMatchObject({ source: "open-meteo" });
    advance(6 * 3600_000);
    fetchMock.mockClear();
    // Снимок устарел — обновление, но Google ещё в паузе? Пауза 10 мин прошла — снова Google (и снова 429).
    await s.forecastAt(YAREMCHE);
    expect(fetchMock.mock.calls.some(([u]) => isGoogle(u))).toBe(true);
  });

  it("предел квоты исчерпан — Open-Meteo без запросов к Google; без ключа — тоже", async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(isGoogle(url) ? json({}, 500) : json(openMeteoBody())),
    );
    const exhausted = service({ fetch: fetchMock as unknown as typeof fetch, quota: false });
    expect(await exhausted.s.forecastAt(YAREMCHE)).toMatchObject({ source: "open-meteo" });
    expect(fetchMock.mock.calls.some(([u]) => isGoogle(u))).toBe(false);
    const noKey = service({ fetch: fetchMock as unknown as typeof fetch, google: false });
    expect(await noKey.s.forecastAt(YAREMCHE)).toMatchObject({ source: "open-meteo" });
    expect(noKey.quota.take).not.toHaveBeenCalled();
  });

  it("оба источника недоступны (сеть, таймаут) — null, без исключения; повтор не раньше чем через 5 минут", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new DOMException("timeout", "TimeoutError")));
    const { s, advance } = service({ fetch: fetchMock as unknown as typeof fetch });
    expect(await s.forecastAt(YAREMCHE)).toBeNull();
    const calls = fetchMock.mock.calls.length;
    expect(await s.forecastAt(YAREMCHE)).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(calls);
    advance(6 * 60_000);
    await s.forecastAt(YAREMCHE);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it("точка дальше 30 км — null без запросов к источникам", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(openMeteoBody())));
    const { s } = service({ fetch: fetchMock as unknown as typeof fetch });
    expect(await s.forecastAt({ lat: 50.45, lng: 30.52 })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("параллельные запросы — одно обновление; прошедшие дни снимка отбрасываются; фоновый тик обновляет устаревшие", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(openMeteoBody())));
    const { s, advance } = service({ fetch: fetchMock as unknown as typeof fetch, google: false });
    const [a, b] = await Promise.all([s.forecastAt(YAREMCHE), s.forecastAt(YAREMCHE)]);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Через сутки снимок устарел — обновляется; дни до сегодняшнего (в поясе точки) отбрасываются.
    advance(24 * 3600_000);
    const tomorrow = await s.forecastAt(YAREMCHE);
    expect(tomorrow!.days[0]!.date).toBe("2026-11-04");
    fetchMock.mockClear();
    advance(3 * 3600_000);
    // 1 населённый пункт + 4 горные точки — все устарели.
    expect(await s.refreshDue()).toBe(1 + MOUNTAIN_POINTS.length);
  });
});

describe("HTTP GET /weather", () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(forecast: Forecast | null) {
    const weather = {
      forecastAt: vi.fn(() => Promise.resolve(forecast)),
      icon: vi.fn((name: string) => Promise.resolve(name === "cloudy" ? Buffer.from("<svg/>") : null)),
    };
    const { db } = recordingDb({});
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
        FeatureFlagsModule.forRoot({ appEnv: "local" }),
      ],
      controllers: [WeatherController],
      providers: [{ provide: WeatherService, useValue: weather }],
    })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(PRINCIPAL_SOURCE)
      .useValue({ resolve: () => undefined })
      .overrideProvider(RoleAssignmentsRepository)
      .useValue({ activeGrantsOf: () => Promise.resolve([]) })
      .overrideProvider(FeatureFlagsService)
      .useValue({ isEnabled: () => Promise.resolve(true) })
      .compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
    await app.init();
    return { http: () => request(app!.getHttpServer()), weather };
  }

  it("прогноз — публичный кеш, days ограничен; «прогноза нет» — 200 available:false без кеша; без lat — 400", async () => {
    const f = parseOpenMeteo(openMeteoBody())!;
    const ok = await start(f);
    const res = await ok.http().get("/weather?lat=48.45&lng=24.55&days=2").expect(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=600");
    expect(res.body).toMatchObject({ available: true, source: "open-meteo", point: { elevation: 530 } });
    expect(res.body.days).toHaveLength(2);
    await ok.http().get("/weather?lng=24.55").expect(400);
    await ok.http().get("/weather?lat=91&lng=24.55").expect(400);
    await ok.http().get("/weather?lat=48&lng=24&days=8").expect(400);
    const icon = await ok.http().get("/weather/icons/cloudy.svg").expect(200);
    expect(icon.headers["content-type"]).toContain("image/svg+xml");
    expect(icon.headers["content-security-policy"]).toContain("sandbox");
    await ok.http().get("/weather/icons/rain.svg").expect(404);
    await ok.http().get("/weather/icons/cloudy.png").expect(404);
    await app!.close();
    const none = await start(null);
    const empty = await none.http().get("/weather?lat=48.45&lng=24.55").expect(200);
    expect(empty.headers["cache-control"]).toBe("no-store");
    expect(empty.body).toEqual({
      available: false,
      source: null,
      point: null,
      timezone: null,
      current: null,
      days: [],
    });
  });
});
