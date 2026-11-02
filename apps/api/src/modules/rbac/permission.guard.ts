import {
  applyDecorators,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiError, SESSION_SECURITY } from "../../common/http/index.js";
import { isWithoutTenantContext } from "../../common/tenancy/index.js";
import type { PermissionCode } from "./permissions.js";
import type { Principal } from "./principal.js";
import { RbacService, RequestAccess, type Authorization } from "./rbac.service.js";
import type { ScopeResolver } from "./scope-resolvers.js";

const REQUIRE_PERMISSION = Symbol("REQUIRE_PERMISSION");

type Requirement = { readonly permission: PermissionCode; readonly resolver: ScopeResolver };

/** Поля, которые RBAC выставляет запросу. */
export type RbacRequest = {
  params?: Record<string, unknown>;
  body?: unknown;
  query?: Record<string, unknown>;
  /** Принципал (PrincipalGuard). */
  principal?: Principal;
  /** Актор для IdempotencyInterceptor (T1-14): `{ id }` пользователя-принципала. */
  user?: unknown;
  /** Итог проверки @RequirePermission: назначение — в аудит (AuditEntry.roleAssignmentId). */
  authorization?: Authorization;
};

/**
 * «Требуется право X на область Y»: область вычисляет resolver из запроса (scope-resolvers.ts). Без принципала —
 * 401 UNAUTHENTICATED; нет назначения с правом на область или её предка, область не определена, объект в другом
 * регионе, чем tenant-контекст запроса (или в регионе, а контекста нет), — 403 FORBIDDEN. Ставить на метод или на
 * класс, не на оба, и не вместе с @WithoutTenantContext (ошибки конфигурации, 500). В `@ApiErrors(…)` эндпоинта — "UNAUTHENTICATED", "FORBIDDEN".
 */
export function RequirePermission(
  permission: PermissionCode,
  resolver: ScopeResolver,
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(REQUIRE_PERMISSION, { permission, resolver } satisfies Requirement),
    UseGuards(PermissionGuard),
    // В OpenAPI — требование токена сессии (T1-26).
    ApiBearerAuth(SESSION_SECURITY),
  );
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RequestAccess) private readonly access: RequestAccess,
    @Inject(RbacService) private readonly rbac: RbacService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const onMethod = this.reflector.get<Requirement | undefined>(REQUIRE_PERMISSION, context.getHandler());
    const onClass = this.reflector.get<Requirement | undefined>(REQUIRE_PERMISSION, context.getClass());
    // На обоих уровнях — ошибка конфигурации: метод молча переопределил бы (ослабил) требование класса.
    if (onMethod && onClass)
      throw new Error(
        `@RequirePermission и на классе ${context.getClass().name}, и на методе ${context.getHandler().name}: оставьте один`,
      );
    const req = onMethod ?? onClass;
    if (!req) throw new Error("PermissionGuard без @RequirePermission: используйте декоратор");
    // С @WithoutTenantContext право подтвердилось бы в tenant-контексте, а обработчик выполнялся бы вне его
    // транзакции и RLS — ошибка конфигурации (500), до проверки доступа.
    if (isWithoutTenantContext(this.reflector, context))
      throw new Error(
        `@RequirePermission вместе с @WithoutTenantContext (${context.getClass().name}.${context.getHandler().name}): ` +
          "право проверяется в tenant-контексте — уберите @WithoutTenantContext или используйте @RequireAuth()",
      );
    const state = await this.access.state(context);
    if (!state.principal) throw new ApiError("UNAUTHENTICATED");
    // Выбранный регион без назначения в нём — 403 (как в TenantContextSource).
    const tenant = await this.access.tenant(context);
    const request = context.switchToHttp().getRequest<RbacRequest>();
    const target = await req.resolver({ request, tenant });
    if (!target) throw new ApiError("FORBIDDEN");
    // Объект другого региона, чем транзакция запроса, или объект региона без tenant-контекста (несколько регионов,
    // регион не выбран): его данные всё равно не видны (ADR-005), право в чужом контексте не подтверждается.
    const auth = await this.rbac.authorizeInTenant(state.grants, req.permission, target, tenant);
    if (!auth) throw new ApiError("FORBIDDEN");
    request.authorization = auth;
    return true;
  }
}
