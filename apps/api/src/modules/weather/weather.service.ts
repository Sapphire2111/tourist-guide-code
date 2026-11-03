import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { InjectDb, outsideTenant, type Db, type JsonObject } from "../../db/index.js";
import { GoogleQuota } from "../../places-enrich/quota.js";
import {
  GOOGLE_WEATHER_URL,
  googleCurrentUrl,
  googleDaysUrl,
  googleForecast,
  parseGoogleCurrent,
  parseGoogleDays,
} from "./google-weather.js";
import { MOUNTAIN_POINTS, nearestPoint, type WeatherPoint } from "./weather-points.js";
import { WeatherRepository, type WeatherRow } from "./weather.repository.js";
import { FORECAST_DAYS_MAX, openMeteoUrl, parseOpenMeteo, type Forecast } from "./weather-rules.js";

export const WEATHER_CONFIG = Symbol("WEATHER_CONFIG");

export type WeatherConfig = {
  /** Серверный ключ Google (GOOGLE_MAPS_API_KEY, включён Weather API); нет — только Open-Meteo. */
  googleApiKey?: string | undefined;
  /** Запросов к Google Weather в сутки / месяц (America/Los_Angeles, счётчик google_api_usage). */
  googleDailyLimit?: number | undefined;
  googleMonthlyLimit?: number | undefined;
  /** Фоновое обновление точек в процессе api (тик под advisory lock); без него — только ленивое при запросе. */
  refresh?: boolean | undefined;
  googleBaseUrl?: string;
  openMeteoUrl?: string;
  /** fetch и счётчик квоты (подменяются в тестах). */
  fetch?: typeof fetch;
  quota?: Pick<GoogleQuota, "take">;
  timeoutMs?: number;
};

export const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
export const GOOGLE_WEATHER_DAILY_LIMIT_DEFAULT = 300;
export const GOOGLE_WEATHER_MONTHLY_LIMIT_DEFAULT = 5000;
/** Запросов к Google на одно обновление точки: сейчас + по дням. */
export const GOOGLE_CALLS_PER_REFRESH = 2;
/** Период обновления точки: не чаще раза в час и не реже раза в 6 часов. */
export const REFRESH_MIN_MS = 3600_000;
export const REFRESH_MAX_MS = 6 * 3600_000;
/** Без ключа Google (только Open-Meteo, квоты нет) — раз в 2 часа. */
export const REFRESH_OPEN_METEO_MS = 2 * 3600_000;
/** Снимок старше этого не отдаётся вовсе (лучше без погоды, чем вчерашняя). */
export const SNAPSHOT_MAX_AGE_MS = 12 * 3600_000;
export const WEATHER_TIMEOUT_MS = 4_000;
/** Обновление точки не удалось — следующая попытка не раньше (не долбим источники на каждый запрос). */
const POINT_RETRY_MS = 5 * 60_000;
/** Список точек и снимки перечитываются из БД не реже (несколько экземпляров api, фоновый тик). */
const ROWS_TTL_MS = 5 * 60_000;
/** Точки населённых пунктов сверяются с localities не чаще. */
const SYNC_TTL_MS = 3600_000;
/** Google после 429/403/исчерпанного предела не спрашиваем столько (сразу Open-Meteo). */
const GOOGLE_PAUSE_MS = 10 * 60_000;

export type Point = { lat: number; lng: number };

/**
 * Период обновления по квоте Google: на сутки — min(суточный предел, месячный / 31) запросов, на точку за обновление —
 * GOOGLE_CALLS_PER_REFRESH. Период = 24 ч × точки × 2 / бюджет, округлён вверх до часа, в [1 ч; 6 ч]. Пример: 14 точек,
 * 300/сутки и 5000/мес → бюджет 161/сутки → 24 × 28 / 161 ≈ 4,2 ч → каждые 5 ч (≈ 134 запроса в сутки).
 */
export function refreshEveryMs(points: number, google: { daily: number; monthly: number } | null): number {
  if (!google) return REFRESH_OPEN_METEO_MS;
  const budget = Math.min(google.daily, Math.floor(google.monthly / 31));
  if (budget <= 0) return REFRESH_OPEN_METEO_MS;
  const hours = Math.ceil((24 * Math.max(1, points) * GOOGLE_CALLS_PER_REFRESH) / budget);
  return Math.min(REFRESH_MAX_MS, Math.max(REFRESH_MIN_MS, hours * 3600_000));
}

/** Отпечаток содержимого прогноза без времени замера (updated_at — только при изменении). */
export function contentHash(f: Forecast): string {
  const { current, ...rest } = f;
  const stable = { ...rest, current: current ? { ...current, time: null } : null };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/** Снимок из БД → прогноз (форма — Forecast; иная — null). */
function snapshotOf(row: WeatherRow): Forecast | null {
  const f = row.forecast as unknown as Forecast | null;
  return f && Array.isArray(f.days) && typeof f.latitude === "number" ? f : null;
}

/** Сегодня в поясе точки (YYYY-MM-DD). */
export function todayIn(timezone: string | null, now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone ?? "Europe/Kyiv" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Прогноз погоды на нашем сервере. Точки — центры населённых пунктов (localities) и горные точки (MOUNTAIN_POINTS);
 * снимки — в weather_forecasts. Запрос по координатам отдаётся из ближайшей точки; снимок устарел — обновляется лениво
 * (одно обновление точки на все параллельные запросы). Источник: Google Weather (ключ на сервере, квота в БД как у
 * фото Google), запасной — Open-Meteo (нет ключа, предел, 429, ошибка, таймаут). Ничего нет — null (не 500).
 * Всё — вне транзакции запроса (outsideTenant): «Мій план» зовёт сервис изнутри транзакции региона.
 */
@Injectable()
export class WeatherService {
  private readonly log = new Logger("WeatherService");
  private readonly cfg: {
    googleApiKey: string | undefined;
    googleDailyLimit: number;
    googleMonthlyLimit: number;
    googleBaseUrl: string;
    openMeteoUrl: string;
    fetch: typeof fetch;
    timeoutMs: number;
  };
  private readonly quota: Pick<GoogleQuota, "take"> | null;
  private rows: { at: number; list: WeatherRow[] } | null = null;
  private syncedAt = -Infinity;
  private readonly refreshing = new Map<string, Promise<Forecast | null>>();
  private readonly failedUntil = new Map<string, number>();
  private googlePausedUntil = -Infinity;
  private readonly warnedAt = new Map<string, number>();

  constructor(
    @Optional() @Inject(WEATHER_CONFIG) config?: WeatherConfig,
    @Optional() @Inject(WeatherRepository) private readonly repo?: WeatherRepository,
    @Optional() @InjectDb() db?: Db,
  ) {
    this.cfg = {
      googleApiKey: config?.googleApiKey || undefined,
      googleDailyLimit: config?.googleDailyLimit ?? GOOGLE_WEATHER_DAILY_LIMIT_DEFAULT,
      googleMonthlyLimit: config?.googleMonthlyLimit ?? GOOGLE_WEATHER_MONTHLY_LIMIT_DEFAULT,
      googleBaseUrl: config?.googleBaseUrl ?? GOOGLE_WEATHER_URL,
      openMeteoUrl: config?.openMeteoUrl ?? OPEN_METEO_URL,
      fetch: config?.fetch ?? ((...a) => fetch(...a)),
      timeoutMs: config?.timeoutMs ?? WEATHER_TIMEOUT_MS,
    };
    this.quota = config?.quota ?? (db ? new GoogleQuota(db, () => new Date(this.now())) : null);
  }

  /** Часы, мс (подменяются в тестах). */
  now: () => number = () => Date.now();

  /** Период обновления точки при текущем числе точек и квоте Google. */
  refreshEvery(points: number): number {
    return refreshEveryMs(
      points,
      this.cfg.googleApiKey && this.quota
        ? { daily: this.cfg.googleDailyLimit, monthly: this.cfg.googleMonthlyLimit }
        : null,
    );
  }

  /**
   * Прогноз для координат: ближайшая точка (не дальше 30 км; mountain — горная точка рядом, для похода). Дни — с
   * сегодняшнего в поясе точки. null — точки нет или прогноза нет.
   */
  forecastAt(at: Point, opts: { mountain?: boolean } = {}): Promise<Forecast | null> {
    return outsideTenant(async () => {
      try {
        const rows = await this.loadRows();
        const row = nearestPoint(rows, at, opts);
        if (!row) return null;
        return this.trim(await this.fresh(row, rows.length));
      } catch (e) {
        this.warn("db", `Погода: ошибка хранилища (${errName(e)})`);
        return null;
      }
    });
  }

  /** Фоновый тик: обновить точки, чей снимок старше 90 % периода. Возвращает число обновлённых. */
  refreshDue(): Promise<number> {
    return outsideTenant(async () => {
      const rows = await this.loadRows(true);
      const every = this.refreshEvery(rows.length);
      let n = 0;
      for (const row of rows) {
        const age = row.fetchedAt ? this.now() - row.fetchedAt.getTime() : Infinity;
        if (age < every * 0.9) continue;
        if (await this.refreshPoint(row)) n++;
      }
      if (n) this.rows = null;
      return n;
    });
  }

  /** Строки точек: память ROWS_TTL_MS, иначе БД; раз в час (или когда точек нет) — сверка с localities. */
  private async loadRows(force = false): Promise<WeatherRow[]> {
    if (!this.repo) return [];
    const now = this.now();
    if (!force && this.rows && now - this.rows.at < ROWS_TTL_MS) return this.rows.list;
    let list = await this.repo.list();
    if (now - this.syncedAt >= SYNC_TTL_MS || list.length === 0) {
      this.syncedAt = now;
      const points: WeatherPoint[] = [...(await this.repo.settlementPoints()), ...MOUNTAIN_POINTS];
      await this.repo.syncPoints(points);
      list = await this.repo.list();
    }
    this.rows = { at: now, list };
    return list;
  }

  /** Снимок точки; устарел (старше периода × 1,5) — ленивое обновление, не вышло — прежний, если не старше 12 ч. */
  private async fresh(row: WeatherRow, points: number): Promise<Forecast | null> {
    const age = row.fetchedAt ? this.now() - row.fetchedAt.getTime() : Infinity;
    const snap = snapshotOf(row);
    if (snap && age < this.refreshEvery(points) * 1.5) return snap;
    const updated = await this.refreshPoint(row);
    if (updated) return updated;
    return snap && age < SNAPSHOT_MAX_AGE_MS ? snap : null;
  }

  /** Обновить одну точку (параллельные вызовы — одно обновление); сохранить снимок в БД и в память. */
  private refreshPoint(row: WeatherRow): Promise<Forecast | null> {
    const running = this.refreshing.get(row.key);
    if (running) return running;
    if ((this.failedUntil.get(row.key) ?? -Infinity) > this.now()) return Promise.resolve(null);
    const p = (async () => {
      const f = await this.fetchForecast(row.lat, row.lng);
      if (!f) {
        this.failedUntil.set(row.key, this.now() + POINT_RETRY_MS);
        return null;
      }
      this.failedUntil.delete(row.key);
      const fetchedAt = new Date(this.now());
      try {
        await this.repo?.saveForecast(row.key, {
          source: f.source,
          forecast: f as unknown as JsonObject,
          contentHash: contentHash(f),
          fetchedAt,
        });
      } catch (e) {
        // Снимок не записался — прогноз всё равно отдаётся (и живёт в памяти до перечитывания).
        this.warn("db", `Погода: снимок не записан (${errName(e)})`);
      }
      Object.assign(row, { forecast: f, source: f.source, fetchedAt });
      return f;
    })().finally(() => this.refreshing.delete(row.key));
    this.refreshing.set(row.key, p);
    return p;
  }

  /** Дни с сегодняшнего (снимок мог быть сделан вчера). */
  private trim(f: Forecast | null): Forecast | null {
    if (!f) return null;
    const today = todayIn(f.timezone, new Date(this.now()));
    const days = f.days.filter((d) => d.date >= today);
    return days.length ? { ...f, days } : null;
  }

  /** Прогноз по координатам у источников: Google Weather, затем Open-Meteo. */
  async fetchForecast(lat: number, lng: number): Promise<Forecast | null> {
    return (await this.google(lat, lng)) ?? (await this.openMeteo(lat, lng));
  }

  /** Google Weather: два запроса (сейчас и по дням), каждый — единица квоты. null — уходим на Open-Meteo. */
  private async google(lat: number, lng: number): Promise<Forecast | null> {
    const key = this.cfg.googleApiKey;
    if (!key || !this.quota || this.now() < this.googlePausedUntil) return null;
    const limits = { daily: this.cfg.googleDailyLimit, monthly: this.cfg.googleMonthlyLimit };
    if (!(await this.quota.take("weather", limits)) || !(await this.quota.take("weather", limits))) {
      this.googlePausedUntil = this.now() + GOOGLE_PAUSE_MS;
      this.warn("quota", "Предел запросов Google Weather (сутки/месяц) исчерпан — прогноз Open-Meteo");
      return null;
    }
    const get = async (url: string): Promise<unknown> => {
      const res = await this.cfg.fetch(url, {
        headers: { accept: "application/json", "X-Goog-Api-Key": key },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 429 || res.status === 403) this.googlePausedUntil = this.now() + GOOGLE_PAUSE_MS;
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    };
    try {
      const [current, days] = await Promise.all([
        get(googleCurrentUrl(this.cfg.googleBaseUrl, lat, lng, "uk")),
        get(googleDaysUrl(this.cfg.googleBaseUrl, lat, lng, FORECAST_DAYS_MAX, "uk")),
      ]);
      const d = parseGoogleDays(days);
      if (!d || d.days.length === 0) {
        this.warn("google", "Google Weather: неожиданный формат ответа — прогноз Open-Meteo");
        return null;
      }
      return googleForecast(lat, lng, parseGoogleCurrent(current), d);
    } catch (e) {
      this.warn("google", `Google Weather недоступен (${errName(e)}) — прогноз Open-Meteo`);
      return null;
    }
  }

  private async openMeteo(lat: number, lng: number): Promise<Forecast | null> {
    try {
      const res = await this.cfg.fetch(openMeteoUrl(this.cfg.openMeteoUrl, lat, lng, FORECAST_DAYS_MAX), {
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        await res.body?.cancel();
        this.warn("open-meteo", `Open-Meteo ответил ${res.status}`);
        return null;
      }
      const parsed = parseOpenMeteo(await res.json());
      if (!parsed) this.warn("open-meteo", "Open-Meteo: неожиданный формат ответа");
      return parsed;
    } catch (e) {
      this.warn("open-meteo", `Open-Meteo недоступен: ${errName(e)}`);
      return null;
    }
  }

  /** Не чаще раза в минуту на тему: при недоступном источнике каждый запрос иначе писал бы в лог. */
  private warn(topic: string, msg: string): void {
    const now = this.now();
    if (now - (this.warnedAt.get(topic) ?? -Infinity) < 60_000) return;
    this.warnedAt.set(topic, now);
    this.log.warn(msg);
  }
}

const errName = (e: unknown) => (e instanceof Error ? e.message || e.name : "error");
