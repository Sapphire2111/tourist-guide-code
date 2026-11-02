// Резолверы области из запроса для @RequirePermission: какой объект затрагивает запрос. Резолвер даёт только
// целевую область (тип + id); её предков (регион организации и т. д.) ScopeHierarchy загружает на сервере, не из
// запроса. undefined — область не определить (нет/некорректный id, нет контекста) → 403.
import type { ScopeType, TenantContext } from "../../db/index.js";
import { isUuid, PLATFORM_SCOPE, regionScope, scope, type ScopeRef } from "./scope.js";

/** Что видит резолвер. Guard выполняется до pipes: params/body — ещё не провалидированы DTO. */
export type ScopeResolveArgs = {
  readonly request: {
    readonly params?: Record<string, unknown>;
    readonly body?: unknown;
    readonly query?: Record<string, unknown>;
  };
  /** Tenant-контекст запроса (из назначений принципала, RequestAccess). */
  readonly tenant: TenantContext | undefined;
};

export type ScopeResolver = (args: ScopeResolveArgs) => ScopeRef | undefined | Promise<ScopeRef | undefined>;

/** Область — tenant-контекст запроса: регион → REGION, PLATFORM → PLATFORM (списки и ленты «моего региона»). */
export const scopeFromTenant: ScopeResolver = ({ tenant }) => {
  if (tenant?.kind === "region") return regionScope(tenant.regionId);
  if (tenant?.kind === "platform") return PLATFORM_SCOPE;
  return undefined;
};

/** Действие уровня платформы (справочники, флаги): право нужно на PLATFORM. */
export const platformScope: ScopeResolver = () => PLATFORM_SCOPE;

/** Объект из параметра пути: `@RequirePermission("place.edit", scopeFromParam("PLACE", "placeId"))`. */
export function scopeFromParam(type: Exclude<ScopeType, "PLATFORM">, param = "id"): ScopeResolver {
  return ({ request }) => {
    const v = request.params?.[param];
    return isUuid(v) ? scope(type, v) : undefined;
  };
}

/** Объект из поля тела (например, organizationId при создании заведения). */
export function scopeFromBody(type: Exclude<ScopeType, "PLATFORM">, field: string): ScopeResolver {
  return ({ request }) => {
    const body = request.body;
    const v = body && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined;
    return isUuid(v) ? scope(type, v) : undefined;
  };
}
