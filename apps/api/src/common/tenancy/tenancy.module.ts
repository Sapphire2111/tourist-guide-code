import { Global, Module, type DynamicModule, type ModuleMetadata, type Type } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { TenantContextInterceptor } from "./tenant-context.interceptor.js";
import {
  NoTenantContextSource,
  TENANT_CONTEXT_SOURCE,
  type TenantContextSource,
} from "./tenant-context.source.js";

/** Модуль-носитель TenancyModule.forRoot() (метаданные только динамические). */
@Module({})
class TenancyRootModule {}

/**
 * Tenant-контекст запросов (T1-10): глобальный TenantContextInterceptor и источник контекста
 * (`TENANT_CONTEXT_SOURCE`). Статический импорт — заглушка NoTenantContextSource (тесты подменяют
 * `.overrideProvider(TENANT_CONTEXT_SOURCE)`); приложение — `forRoot({ source, imports })` с источником из
 * назначений ролей (RbacTenantContextSource, T1-12). Нужен DatabaseModule (глобальный).
 */
@Global()
@Module({
  providers: [
    { provide: TENANT_CONTEXT_SOURCE, useClass: NoTenantContextSource },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [TENANT_CONTEXT_SOURCE],
})
export class TenancyModule {
  /**
   * Источник контекста — провайдер `source` из `imports` (модуль, который его экспортирует). Отдельный класс
   * модуля: метаданные @Module у TenancyModule слились бы с динамическими (второй интерсептор).
   */
  static forRoot(opts: {
    source: Type<TenantContextSource>;
    imports?: ModuleMetadata["imports"];
  }): DynamicModule {
    return {
      module: TenancyRootModule,
      global: true,
      imports: opts.imports ?? [],
      providers: [
        { provide: TENANT_CONTEXT_SOURCE, useExisting: opts.source },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
      exports: [TENANT_CONTEXT_SOURCE],
    };
  }
}
