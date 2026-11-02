import {
  Inject,
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { setLogContext } from "@tg/server-config";
import { from, lastValueFrom, switchMap, type Observable } from "rxjs";
import { InjectDb, withTenant, type Db } from "../../db/index.js";
import { TENANT_CONTEXT_SOURCE, type TenantContextSource } from "./tenant-context.source.js";

const WITHOUT_TENANT_CONTEXT = Symbol("WITHOUT_TENANT_CONTEXT");

/**
 * Обработчик (метод или класс) выполняется без tenant-контекста: источник контекста не вызывается, транзакции
 * запроса нет. Только для эндпоинтов, которые не читают и не пишут данные региона от имени принципала и должны
 * работать, даже когда контекст не выводится (выбранный регион без назначения — 403 на любом другом запросе):
 * сессия и выход (T1-26). Tenant-таблицы такой обработчик трогает только явным withTenant() (например, аудит в
 * SYSTEM).
 */
export const WithoutTenantContext = (): MethodDecorator & ClassDecorator =>
  SetMetadata(WITHOUT_TENANT_CONTEXT, true);

/**
 * Помечен ли обработчик (метод или класс) @WithoutTenantContext. Нужен проверкам конфигурации: @RequirePermission
 * с ним несовместим — право подтверждается в tenant-контексте, а обработчик выполнялся бы вне его транзакции и RLS
 * (PermissionGuard бросает ошибку конфигурации).
 */
export function isWithoutTenantContext(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(WITHOUT_TENANT_CONTEXT, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

/**
 * Глобальный интерсептор: если у запроса есть tenant-контекст (TenantContextSource), обработчик выполняется
 * в withTenant() — одна транзакция на запрос с переменными RLS и контекстом TenantGuardPlugin; репозитории
 * берут её через currentDb(). Исключение обработчика — ROLLBACK. Без контекста — обработчик как есть
 * (health и прочие запросы без tenant-данных; tenant-таблица в них — ошибка).
 * Ответ-поток (SSE) в транзакции не поддерживается: берётся последнее значение.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(TENANT_CONTEXT_SOURCE) private readonly source: TenantContextSource,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (isWithoutTenantContext(this.reflector, context)) return next.handle();
    return from(Promise.resolve(this.source.resolve(context))).pipe(
      switchMap((tenant) => {
        // region_id в логах запроса (T1-18): только id региона, платформа/система — null.
        if (tenant) setLogContext({ regionId: tenant.kind === "region" ? tenant.regionId : null });
        return tenant
          ? from(withTenant(this.db, tenant, () => lastValueFrom(next.handle(), { defaultValue: undefined })))
          : next.handle();
      }),
    );
  }
}
