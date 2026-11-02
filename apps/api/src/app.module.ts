import { Module, type DynamicModule } from "@nestjs/common";
import { analyticsClientEventsEnabled, mediaProcessingMode, type ApiEnv } from "./config.js";
import { TenancyModule } from "./common/tenancy/index.js";
import { DatabaseModule } from "./db/index.js";
import { AdminAuthModule } from "./modules/admin-auth/index.js";
import { AnalyticsModule } from "./modules/analytics/index.js";
import { AuditModule } from "./modules/audit/index.js";
import { AuthModule } from "./modules/auth/index.js";
import { EmergencyContactsModule } from "./modules/emergency-contacts/index.js";
import { CatalogModule } from "./modules/catalog/index.js";
import { FeatureFlagsModule } from "./modules/feature-flags/index.js";
import { GuideModule } from "./modules/guide/index.js";
import { HostRequestsModule } from "./modules/host/index.js";
import { PartnerModule } from "./modules/partner/index.js";
import { PlannerModule } from "./modules/planner/index.js";
import { ClientIpDiagnosticsModule, HealthModule } from "./modules/health/index.js";
import { IdempotencyModule } from "./modules/idempotency/index.js";
import { MediaModule } from "./modules/media/index.js";
import { ProfileModule } from "./modules/profile/index.js";
import { QrContextModule } from "./modules/qr-context/index.js";
import { QrPointsModule } from "./modules/qr-points/index.js";
import { RateLimitModule } from "./modules/rate-limit/index.js";
import { RbacModule, RbacTenantContextSource } from "./modules/rbac/index.js";
import { RoleAssignmentsModule } from "./modules/role-assignments/index.js";
import { SystemModule } from "./modules/system/index.js";

@Module({})
export class AppModule {
  /**
   * Корневой модуль из проверенного env (loadEnvOrExit в main.ts). Без APP_ENV/AUTH_* (генерация OpenAPI) —
   * local без dev-входа.
   */
  static forRoot(
    env: Pick<ApiEnv, "DATABASE_URL"> &
      Partial<
        Pick<
          ApiEnv,
          | "APP_ENV"
          | "AUTH_DEV_LOGIN"
          | "AUTH_SESSION_TTL_HOURS"
          | "REDIS_URL"
          | "ANALYTICS_SINK"
          | "ANALYTICS_CLIENT_EVENTS"
          | "PORT"
          | "PUBLIC_API_URL"
          | "MEDIA_PROCESSING"
          | "STORAGE_DRIVER"
          | "STORAGE_LOCAL_DIR"
          | "STORAGE_SIGNING_SECRET"
          | "STORAGE_PUBLIC_BASE_URL"
          | "S3_ENDPOINT"
          | "S3_REGION"
          | "S3_BUCKET"
          | "S3_ACCESS_KEY_ID"
          | "S3_SECRET_ACCESS_KEY"
          | "RATE_LIMIT"
          | "TELEGRAM_BOT_TOKEN"
          | "TELEGRAM_BOT_USERNAME"
          | "ADMIN_LOGIN_HMAC_SECRET"
          | "TELEGRAM_INIT_DATA_MAX_AGE_HOURS"
          | "GOOGLE_MAPS_API_KEY"
          | "GOOGLE_PHOTO_DAILY_LIMIT"
        >
      >,
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot({ connectionString: env.DATABASE_URL }),
        // Rate limit (T1-24) — первым из модулей с глобальными интерсепторами: 429 до идемпотентности и транзакции.
        RateLimitModule.forRoot({
          enabled: env.RATE_LIMIT !== "off",
          redisUrl: env.RATE_LIMIT === "memory" ? undefined : env.REDIS_URL,
        }),
        // До TenancyModule: IdempotencyInterceptor должен быть снаружи транзакции запроса (T1-14).
        IdempotencyModule,
        // Контекст региона — из назначений ролей принципала (T1-12).
        TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
        RbacModule,
        // Сессии и источник принципала для RBAC (T1-26), вход через Telegram (блок 2).
        AuthModule.forRoot({
          appEnv: env.APP_ENV,
          devLogin: env.AUTH_DEV_LOGIN,
          sessionTtlHours: env.AUTH_SESSION_TTL_HOURS,
          telegramBotToken: env.TELEGRAM_BOT_TOKEN,
          initDataMaxAgeHours: env.TELEGRAM_INIT_DATA_MAX_AGE_HOURS,
        }),
        // Профиль: GET/PATCH /me, согласия, разрешение боту писать, запросы данных (блок 2).
        ProfileModule,
        RoleAssignmentsModule,
        HealthModule,
        ClientIpDiagnosticsModule.forRoot({ appEnv: env.APP_ENV }),
        SystemModule,
        AuditModule,
        AnalyticsModule.forRoot({
          mode: env.ANALYTICS_SINK,
          redisUrl: env.REDIS_URL,
          clientEvents: analyticsClientEventsEnabled(env),
        }),
        // QR-контекст входа (блок 2, ADR-0016): после AnalyticsModule — эмиссия qr_scanned.
        QrContextModule,
        // Ядро админки (блок 3, ADR-0018): вход по логину и паролю, QR-менеджмент, экстренные контакты.
        AdminAuthModule.forRoot({ loginHmacSecret: env.ADMIN_LOGIN_HMAC_SECRET }),
        QrPointsModule.forRoot({ botUsername: env.TELEGRAM_BOT_USERNAME }),
        EmergencyContactsModule,
        // Каталог региона для админки (блок 3, ADR-0017).
        CatalogModule,
        // Публичный каталог туриста (блок 4, ADR-0019): категории, поиск, картка місця, избранное, «Халепа?»;
        // фото Google в карточке — через прокси api (ключ только на сервере).
        GuideModule.forRoot({
          apiKey: env.GOOGLE_MAPS_API_KEY,
          dailyLimit: env.GOOGLE_PHOTO_DAILY_LIMIT,
          apiBaseUrl: env.PUBLIC_API_URL ?? `http://localhost:${env.PORT ?? 4300}`,
        }),
        // Заявки гостиницы, «Про заклад», персонал и планировщик (блок 5, ADR-0020).
        HostRequestsModule.forRoot({ botToken: env.TELEGRAM_BOT_TOKEN }),
        PlannerModule,
        // Кабинет партнёра и модерация (блок 6, ADR-0021).
        PartnerModule.forRoot({ botToken: env.TELEGRAM_BOT_TOKEN, botUsername: env.TELEGRAM_BOT_USERNAME }),
        // Фича-флаги (T1-22): без APP_ENV (генерация OpenAPI) — значения prod.
        FeatureFlagsModule.forRoot({ appEnv: env.APP_ENV }),
        // Файлы и изображения (T1-20, ADR-0013): без STORAGE_* (генерация OpenAPI) — local, ресайз inline.
        MediaModule.forRoot({
          storage: {
            STORAGE_DRIVER: env.STORAGE_DRIVER ?? "local",
            STORAGE_LOCAL_DIR: env.STORAGE_LOCAL_DIR,
            STORAGE_SIGNING_SECRET: env.STORAGE_SIGNING_SECRET,
            STORAGE_PUBLIC_BASE_URL: env.STORAGE_PUBLIC_BASE_URL,
            S3_ENDPOINT: env.S3_ENDPOINT,
            S3_REGION: env.S3_REGION,
            S3_BUCKET: env.S3_BUCKET,
            S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
            S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
          },
          apiBaseUrl: env.PUBLIC_API_URL ?? `http://localhost:${env.PORT ?? 4300}`,
          processing: mediaProcessingMode(env),
          redisUrl: env.REDIS_URL,
        }),
      ],
    };
  }
}
