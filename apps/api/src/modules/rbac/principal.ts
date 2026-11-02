// Принципал запроса — аутентифицированный пользователь (из сессии, T1-26; roles-and-data §1.2, шаги 1–2).
// RBAC берёт из него только id пользователя и выбранный регион; назначения ролей загружает сам из БД — клиентским
// ролям и region_id не доверяет.
import { Injectable, type ExecutionContext } from "@nestjs/common";

export type Principal = {
  readonly userId: string;
  /** Сессия, по которой аутентифицирован запрос (id записи, не токен): в аудит (ПДн-часть) и логи. */
  readonly sessionId?: string;
  /**
   * Регион, выбранный в сессии (режим D-50), — только с сервера, не из параметров запроса. Это регион режима
   * партнёра/админа: если задан, контекст запроса — этот регион при наличии назначения в нём (PLATFORM или любое
   * в регионе), иначе 403; не задан — выводится из назначений. Турист (GUEST/USER) назначений ролей не имеет, и
   * выбранный им регион здесь дал бы 403 — регион публичного каталога туриста берётся из отдельного источника
   * (задел — README apps/api, «Сессии»).
   */
  readonly regionId?: string | null;
};

/**
 * Источник принципала запроса. Вызывается один раз на запрос глобальным PrincipalGuard — до всех интерсепторов
 * (IdempotencyInterceptor, TenantContextInterceptor). undefined — запрос без аутентификации.
 */
export interface PrincipalSource {
  resolve(context: ExecutionContext): Principal | undefined | Promise<Principal | undefined>;
}

/**
 * DI-токен источника принципала, которым пользуется RBAC. Значение — реализация AUTHENTICATION_PRINCIPAL_SOURCE,
 * если она есть в приложении, иначе NoPrincipalSource; тесты — `.overrideProvider(PRINCIPAL_SOURCE)`.
 */
export const PRINCIPAL_SOURCE = Symbol("PRINCIPAL_SOURCE");

/**
 * DI-токен реализации источника принципала от модуля аутентификации (глобальный AuthModule, T1-26: сессия по
 * токену Bearer). RbacModule берёт его необязательной зависимостью: модуль аутентификации зависит от rbac, а не
 * наоборот (без циклического импорта).
 */
export const AUTHENTICATION_PRINCIPAL_SOURCE = Symbol("AUTHENTICATION_PRINCIPAL_SOURCE");

/** Нет модуля аутентификации (тесты RBAC, генерация OpenAPI): у запроса нет принципала, @RequirePermission — 401. */
@Injectable()
export class NoPrincipalSource implements PrincipalSource {
  resolve(): undefined {
    return undefined;
  }
}
