import {
  applyDecorators,
  Injectable,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiError, SESSION_SECURITY } from "../../common/http/index.js";
import type { RbacRequest } from "../rbac/index.js";

/** Требуется только аутентификация (любая действующая сессия); без принципала — 401 UNAUTHENTICATED. */
@Injectable()
export class RequireAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // Принципала выставляет глобальный PrincipalGuard — он выполняется раньше guard'ов контроллера.
    if (!context.switchToHttp().getRequest<RbacRequest>().principal) throw new ApiError("UNAUTHENTICATED");
    return true;
  }
}

/**
 * Эндпоинт только для аутентифицированных (сессия), без проверки права. Для действий с правом — @RequirePermission
 * (он тоже отвечает 401 без сессии). В `@ApiErrors(…)` — "UNAUTHENTICATED".
 */
export function RequireAuth(): MethodDecorator & ClassDecorator {
  return applyDecorators(UseGuards(RequireAuthGuard), ApiBearerAuth(SESSION_SECURITY));
}
