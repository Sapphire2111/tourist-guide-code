// Фоновое обновление прогнозов в процессе api (как bookings.process-due при WORKER_IN_PROCESS): тик раз в 15 минут
// обновляет точки, чей снимок старше 90 % периода (период — по квоте Google, refreshEveryMs). Несколько экземпляров
// api не обновляют одновременно: транзакционный advisory lock на отдельном соединении держится, пока идёт тик (как в
// db/in-process-jobs.ts). Таймер unref; Render free засыпает — после пробуждения обновится тиком или лениво при
// запросе.
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { sql } from "kysely";
import { InjectDb, type Db } from "../../db/index.js";
import { WEATHER_CONFIG, WeatherService, type WeatherConfig } from "./weather.service.js";

/** Ключ advisory lock тика погоды (константа проекта; IN_PROCESS_JOBS_LOCK_KEY — 7_340_001). */
export const WEATHER_LOCK_KEY = 7_340_002;
export const WEATHER_TICK_MS = 15 * 60_000;
/** Первый тик — вскоре после старта (снимки появятся без ожидания запроса). */
const FIRST_TICK_MS = 20_000;

@Injectable()
export class WeatherRefresher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger("WeatherRefresher");
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(WeatherService) private readonly weather: WeatherService,
    @InjectDb() private readonly db: Db,
    @Optional() @Inject(WEATHER_CONFIG) private readonly config?: WeatherConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config?.refresh) return;
    const first = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), WEATHER_TICK_MS);
      this.timer.unref();
    }, FIRST_TICK_MS);
    first.unref();
    this.timer = first;
    this.log.log(`Обновление погоды в процессе api: тик каждые ${WEATHER_TICK_MS / 60_000} мин`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
    }
    this.timer = null;
    await this.running;
  }

  /** Один тик под advisory lock; занято другим экземпляром — пропуск. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.db
      .transaction()
      .execute(async (trx) => {
        const { rows } = await sql<{
          ok: boolean;
        }>`SELECT pg_try_advisory_xact_lock(${WEATHER_LOCK_KEY}) AS ok`.execute(trx);
        if (rows[0]?.ok !== true) return;
        const n = await this.weather.refreshDue();
        if (n) this.log.log(`Погода: обновлено точек ${n}`);
      })
      .catch((e: unknown) => this.log.warn(`Погода: тик не выполнен (${e instanceof Error ? e.message : e})`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
