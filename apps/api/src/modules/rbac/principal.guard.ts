import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { TenantContextSource } from "../../common/tenancy/index.js";
import type { TenantContext } from "../../db/index.js";
import type { RbacRequest } from "./permission.guard.js";
import { RequestAccess } from "./rbac.service.js";

/**
 * Глобальный guard (APP_GUARD): выставляет принципала запроса (`req.principal`) и актора для идемпотентности
 * (`req.user = { id }`, T1-14) до всех интерсепторов. Сам не отказывает — отказ решают @RequirePermission и
 * обработчики (health и т. п. доступны без аутентификации).
 */
@Injectable()
export class PrincipalGuard implements CanActivate {
  constructor(@Inject(RequestAccess) private readonly access: RequestAccess) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    const principal = await this.access.principal(context);
    if (principal) {
      const req = context.switchToHttp().getRequest<RbacRequest>();
      req.principal = principal;
      req.user ??= { id: principal.userId };
    }
    return true;
  }
}

/**
 * TenantContextSource (ADR-005) из назначений принципала: выбранный регион — если есть назначение в нём (иначе
 * 403), иначе PLATFORM / единственный регион назначений / без контекста (access.ts, decideTenant). Подключается в
 * AppModule: `TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] })`.
 */
@Injectable()
export class RbacTenantContextSource implements TenantContextSource {
  constructor(@Inject(RequestAccess) private readonly access: RequestAccess) {}

  resolve(context: ExecutionContext): Promise<TenantContext | undefined> {
    return this.access.tenant(context);
  }
}
