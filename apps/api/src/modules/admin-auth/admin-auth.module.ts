import { Module, type DynamicModule } from "@nestjs/common";
import { AuditModule } from "../audit/index.js";
import { AdminAuthController } from "./admin-auth.controller.js";
import { ADMIN_AUTH_OPTIONS, AdminAuthService, DEV_LOGIN_HMAC_SECRET } from "./admin-auth.service.js";
import { AdminCredentialsRepository } from "./admin-credentials.repository.js";

export type AdminAuthModuleOptions = {
  /** ADMIN_LOGIN_HMAC_SECRET (обязателен в staging/prod — проверяет конфиг api); не задан — ключ разработки. */
  loginHmacSecret?: string;
};

/**
 * Вход в веб-админку по логину и паролю (блок 3, ADR-0018). SessionService — из глобального AuthModule.forRoot,
 * Db — из глобального DatabaseModule.
 */
@Module({})
export class AdminAuthModule {
  static forRoot(opts: AdminAuthModuleOptions = {}): DynamicModule {
    return {
      module: AdminAuthModule,
      imports: [AuditModule],
      controllers: [AdminAuthController],
      providers: [
        AdminCredentialsRepository,
        AdminAuthService,
        {
          provide: ADMIN_AUTH_OPTIONS,
          useValue: { loginHmacSecret: opts.loginHmacSecret || DEV_LOGIN_HMAC_SECRET },
        },
      ],
      exports: [AdminCredentialsRepository, AdminAuthService],
    };
  }
}
