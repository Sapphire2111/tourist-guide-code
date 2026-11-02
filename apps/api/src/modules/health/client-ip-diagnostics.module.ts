import { type DynamicModule, Module } from "@nestjs/common";
import type { AppEnv } from "@tg/server-config";
import { ClientIpController } from "./client-ip.controller.js";

/**
 * Диагностика адреса клиента (GET /health/client-ip) для подбора TRUST_PROXY_HOPS. Отдельно от HealthModule,
 * чтобы HealthModule оставался одним экземпляром (его импортирует и SystemModule).
 */
@Module({})
export class ClientIpDiagnosticsModule {
  /** Подключает контроллер только вне prod; без appEnv считаем prod. */
  static forRoot(options: { appEnv?: AppEnv }): DynamicModule {
    return {
      module: ClientIpDiagnosticsModule,
      controllers: (options.appEnv ?? "prod") === "prod" ? [] : [ClientIpController],
    };
  }
}
