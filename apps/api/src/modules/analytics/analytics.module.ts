import { Logger, Module, type DynamicModule } from "@nestjs/common";
import { DATABASE, type Db } from "../../db/index.js";
import { AnalyticsEventsRepository } from "./analytics-events.repository.js";
import { AnalyticsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";
import { ANALYTICS_CLIENT_EVENTS_ENABLED } from "./analytics.service.js";
import {
  ANALYTICS_SINK,
  DirectAnalyticsSink,
  QueueAnalyticsSink,
  type AnalyticsSinkMode,
} from "./analytics.sink.js";

export type AnalyticsModuleOptions = {
  /** Явный режим (ANALYTICS_SINK); по умолчанию queue при наличии Redis, иначе direct. */
  mode?: AnalyticsSinkMode;
  redisUrl?: string;
  /**
   * Приём событий фронтенда (POST /analytics/events; ANALYTICS_CLIENT_EVENTS). false — 404 NOT_FOUND, серверная
   * эмиссия (emit) работает. По умолчанию true; в prod конфиг выключает (эндпоинт без аутентификации и rate limit).
   */
  clientEvents?: boolean;
};

/** Итоговый режим записи событий; queue без Redis — ошибка конфигурации. */
export function resolveAnalyticsSinkMode({ mode, redisUrl }: AnalyticsModuleOptions): AnalyticsSinkMode {
  const resolved = mode ?? (redisUrl ? "queue" : "direct");
  if (resolved === "queue" && !redisUrl) throw new Error("ANALYTICS_SINK=queue требует REDIS_URL");
  return resolved;
}

/**
 * Контекст analytics: репозиторий журнала (T1-09); forRoot — эмиссия событий и приём от фронтенда (T1-25).
 * Без forRoot (тесты репозитория) — только репозиторий. forRoot — глобальный (подключается один раз в AppModule).
 */
@Module({ providers: [AnalyticsEventsRepository], exports: [AnalyticsEventsRepository] })
export class AnalyticsModule {
  static forRoot(options: AnalyticsModuleOptions = {}): DynamicModule {
    const mode = resolveAnalyticsSinkMode(options);
    return {
      module: AnalyticsModule,
      // Глобальный: AnalyticsService.emit нужен модулям-эмиттерам (qr-context — qr_scanned, вход — блок 2 и далее)
      // без повторного forRoot (второй экземпляр sink и контроллера).
      global: true,
      controllers: [AnalyticsController],
      providers: [
        AnalyticsEventsRepository,
        AnalyticsService,
        { provide: ANALYTICS_CLIENT_EVENTS_ENABLED, useValue: options.clientEvents ?? true },
        {
          provide: ANALYTICS_SINK,
          inject: [AnalyticsEventsRepository, DATABASE],
          useFactory: (repo: AnalyticsEventsRepository, db: Db) => {
            new Logger("Analytics").log(
              `Запись событий: ${mode}; приём от фронтенда: ${options.clientEvents === false ? "выкл" : "вкл"}`,
            );
            return mode === "queue"
              ? QueueAnalyticsSink.open(options.redisUrl!, repo)
              : new DirectAnalyticsSink(db);
          },
        },
      ],
      exports: [AnalyticsEventsRepository, AnalyticsService],
    };
  }
}
