import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { RbacModule } from "../rbac/index.js";
import { RegionsModule } from "../regions/index.js";
import type { AppEnv } from "./catalog.js";
import { FeatureFlagsAdminController, FeatureFlagsController } from "./feature-flags.controller.js";
import { FeatureFlagsRepository } from "./feature-flags.repository.js";
import { FEATURE_FLAGS_APP_ENV, FeatureFlagsService } from "./feature-flags.service.js";
import { FeatureAccess, FeatureGuard } from "./feature.guard.js";

export type FeatureFlagsModuleOptions = {
  /**
   * Окружение — значения флагов по умолчанию. Не задано (генерация OpenAPI, тесты без env) — prod: самые строгие
   * значения, finance.live выключен везде.
   */
  appEnv?: AppEnv;
};

/**
 * Фича-флаги (T1-22, ADR-0011): каталог, переопределения, финансовый гейт, guard @RequireFeature, публичный и
 * админский API. Глобальный: модулю с @RequireFeature импортировать его не нужно (FeatureGuard и FeatureAccess
 * доступны везде). Подключается один раз в AppModule; тесты меняют окружение через forRoot({ appEnv }).
 */
@Module({})
export class FeatureFlagsModule {
  static forRoot(options: FeatureFlagsModuleOptions = {}): DynamicModule {
    return {
      module: FeatureFlagsModule,
      global: true,
      imports: [RbacModule, AuditModule, RegionsModule],
      controllers: [FeatureFlagsController, FeatureFlagsAdminController],
      providers: [
        { provide: FEATURE_FLAGS_APP_ENV, useValue: options.appEnv ?? "prod" },
        FeatureFlagsRepository,
        FeatureFlagsService,
        FeatureAccess,
        FeatureGuard,
      ],
      exports: [FeatureFlagsService, FeatureAccess, FeatureGuard],
    };
  }
}
