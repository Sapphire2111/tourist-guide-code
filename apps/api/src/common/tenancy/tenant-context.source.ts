import { Injectable, type ExecutionContext } from "@nestjs/common";
import type { TenantContext } from "../../db/index.js";

/**
 * Источник tenant-контекста запроса (ADR-005): по аутентифицированному принципалу и его назначению роли
 * определяет регион (или PLATFORM). Клиентским параметрам (query/body/заголовок с region_id) не доверяет —
 * регион выводится на сервере из сессии и RoleAssignment (roles-and-data §1.2).
 * undefined — запрос без tenant-контекста: обращение к tenant-таблице в нём — ошибка (TenantGuardPlugin).
 */
export interface TenantContextSource {
  resolve(context: ExecutionContext): TenantContext | undefined | Promise<TenantContext | undefined>;
}

/** DI-токен источника. Реальный источник (сессия + RoleAssignment) подставит T1-12; тесты — свой. */
export const TENANT_CONTEXT_SOURCE = Symbol("TENANT_CONTEXT_SOURCE");

/** Заглушка до аутентификации (T1-12): у запроса нет tenant-контекста. */
@Injectable()
export class NoTenantContextSource implements TenantContextSource {
  resolve(): undefined {
    return undefined;
  }
}
