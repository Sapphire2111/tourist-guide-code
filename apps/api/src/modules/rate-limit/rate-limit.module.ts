import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { RATE_LIMIT_OPTIONS, RateLimitInterceptor, type RateLimitOptions } from "./rate-limit.interceptor.js";
import {
  MemoryRateLimitStore,
  RATE_LIMIT_STORE,
  RedisRateLimitStore,
  type RateLimitStore,
} from "./rate-limit.store.js";

export type RateLimitModuleOptions = Partial<RateLimitOptions> & {
  /** Есть — счётчики в Redis (общие для инстансов), нет — в памяти процесса. */
  redisUrl?: string;
};

/** Лимиты по умолчанию (каркас ТЗ §14.4; свои значения эндпоинтов — @RateLimit). */
export const DEFAULT_RATE_LIMITS = {
  perIp: { limit: 300, windowSec: 60 },
  perUser: { limit: 600, windowSec: 60 },
  perEndpoint: { limit: 120, windowSec: 60 },
} as const;

@Injectable()
class RateLimitStoreCloser implements OnApplicationShutdown {
  constructor(@Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore) {}
  async onApplicationShutdown(): Promise<void> {
    await this.store.close?.();
  }
}

/**
 * Rate limit (T1-24, ADR-0012). Импортировать в корневой модуль РАНЬШЕ модулей с глобальными интерсепторами
 * (IdempotencyModule, TenancyModule): отказ 429 — до захвата ключа идемпотентности и транзакции запроса.
 */
@Module({})
export class RateLimitModule {
  static forRoot(options: RateLimitModuleOptions = {}): DynamicModule {
    const resolved: RateLimitOptions = {
      enabled: options.enabled ?? true,
      perIp: options.perIp ?? DEFAULT_RATE_LIMITS.perIp,
      perUser: options.perUser ?? DEFAULT_RATE_LIMITS.perUser,
      perEndpoint: options.perEndpoint ?? DEFAULT_RATE_LIMITS.perEndpoint,
    };
    const useRedis = resolved.enabled && options.redisUrl !== undefined;
    return {
      module: RateLimitModule,
      // Хранилище счётчиков — и для суточных пределов модулей (ассистент): Redis общий для инстансов.
      global: true,
      exports: [RATE_LIMIT_STORE],
      providers: [
        { provide: RATE_LIMIT_OPTIONS, useValue: resolved },
        {
          provide: RATE_LIMIT_STORE,
          useFactory: (): RateLimitStore => {
            new Logger("RateLimit").log(
              `Rate limit: ${resolved.enabled ? (useRedis ? "Redis" : "память процесса") : "выкл"}`,
            );
            return useRedis ? RedisRateLimitStore.open(options.redisUrl!) : new MemoryRateLimitStore();
          },
        },
        RateLimitStoreCloser,
        { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
      ],
    };
  }
}
