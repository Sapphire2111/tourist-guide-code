import { Module } from "@nestjs/common";
import { DATABASE, type Db } from "../../db/index.js";
import { APP_GUARD } from "@nestjs/core";
import { PermissionGuard } from "./permission.guard.js";
import {
  AUTHENTICATION_PRINCIPAL_SOURCE,
  NoPrincipalSource,
  PRINCIPAL_SOURCE,
  type PrincipalSource,
} from "./principal.js";
import { PrincipalGuard, RbacTenantContextSource } from "./principal.guard.js";
import { RbacService, RequestAccess } from "./rbac.service.js";
import { RoleAssignmentsRepository } from "./role-assignments.repository.js";
import { dbScopeParentLoaders } from "./scope-loaders.js";
import { SCOPE_PARENT_LOADERS, ScopeHierarchy, type ScopeParentLoaders } from "./scope.js";

/**
 * Проверка прав (T1-12): принципал запроса (PRINCIPAL_SOURCE — сессия из глобального AuthModule, T1-26; без него —
 * заглушка «нет принципала»), его назначения, иерархия областей, guard @RequirePermission и tenant-контекст из
 * назначений. Глобальный
 * PrincipalGuard регистрируется при первом импорте модуля. Тесты подменяют PRINCIPAL_SOURCE,
 * SCOPE_PARENT_LOADERS, RoleAssignmentsRepository (`overrideProvider`). Нужен DatabaseModule (глобальный).
 */
@Module({
  providers: [
    {
      provide: PRINCIPAL_SOURCE,
      useFactory: (auth?: PrincipalSource): PrincipalSource => auth ?? new NoPrincipalSource(),
      inject: [{ token: AUTHENTICATION_PRINCIPAL_SOURCE, optional: true }],
    },
    // PLACE → ORGANIZATION | REGION, ORGANIZATION → REGION (блоки 5–6, ADR-0020, ADR-0021); RESOURCE — блок 7.
    {
      provide: SCOPE_PARENT_LOADERS,
      useFactory: (db: Db): ScopeParentLoaders => dbScopeParentLoaders(db),
      inject: [DATABASE],
    },
    { provide: APP_GUARD, useClass: PrincipalGuard },
    RoleAssignmentsRepository,
    ScopeHierarchy,
    RbacService,
    RequestAccess,
    PermissionGuard,
    RbacTenantContextSource,
  ],
  exports: [
    PRINCIPAL_SOURCE,
    RoleAssignmentsRepository,
    ScopeHierarchy,
    RbacService,
    RequestAccess,
    PermissionGuard,
    RbacTenantContextSource,
  ],
})
export class RbacModule {}
