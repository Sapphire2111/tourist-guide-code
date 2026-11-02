import { Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown } from "@nestjs/common";
import type { ErrorTracker } from "@tg/server-config";

export const ERROR_TRACKER = Symbol("ERROR_TRACKER");

/** При остановке (SIGTERM → shutdown-хуки) дожидается отправки событий трекера (T1-18, ADR-0010). */
@Injectable()
class ErrorTrackerShutdown implements OnApplicationShutdown {
  constructor(@Inject(ERROR_TRACKER) private readonly tracker: ErrorTracker) {}
  async onApplicationShutdown(): Promise<void> {
    await this.tracker.flush(2000);
  }
}

/** Трекер ошибок как провайдер приложения + flush при остановке. Подключается в main.ts рядом с AppModule. */
@Module({})
export class ErrorTrackerModule {
  static forRoot(tracker: ErrorTracker): DynamicModule {
    return {
      module: ErrorTrackerModule,
      global: true,
      providers: [{ provide: ERROR_TRACKER, useValue: tracker }, ErrorTrackerShutdown],
      exports: [ERROR_TRACKER],
    };
  }
}

/** Корневой модуль процесса api: приложение и трекер ошибок (app.module.ts не меняется). */
@Module({})
export class ApiRootModule {
  static forRoot(app: DynamicModule, tracker: ErrorTracker): DynamicModule {
    return { module: ApiRootModule, imports: [app, ErrorTrackerModule.forRoot(tracker)] };
  }
}
