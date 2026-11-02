// Публичный интерфейс контекста rbac (T1-12): права, роли-заглушки, области, проверка доступа.
export { RbacModule } from "./rbac.module.js";
export { decideTenant, findGrant, isGrantActive, type Grant, type TenantDecision } from "./access.js";
export { PermissionGuard, RequirePermission, type RbacRequest } from "./permission.guard.js";
export { isPermissionCode, PERMISSIONS, type PermissionCode } from "./permissions.js";
export {
  AUTHENTICATION_PRINCIPAL_SOURCE,
  NoPrincipalSource,
  PRINCIPAL_SOURCE,
  type Principal,
  type PrincipalSource,
} from "./principal.js";
export { PrincipalGuard, RbacTenantContextSource } from "./principal.guard.js";
export { RbacService, RequestAccess, type Authorization } from "./rbac.service.js";
export { RoleAssignmentsRepository } from "./role-assignments.repository.js";
export { isRoleCode, roleHasPermission, ROLES, type RoleCode, type RoleDefinition } from "./roles.js";
export {
  chainRegionId,
  isUuid,
  PLATFORM_SCOPE,
  regionScope,
  SCOPE_PARENT_LOADERS,
  sameScope,
  scope,
  ScopeHierarchy,
  scopeId,
  scopeLevel,
  type ScopeChain,
  type ScopeParentLoader,
  type ScopeParentLoaders,
  type ScopeRef,
} from "./scope.js";
export { dbScopeParentLoaders, organizationParentLoader, placeParentLoader } from "./scope-loaders.js";
export {
  platformScope,
  scopeFromBody,
  scopeFromParam,
  scopeFromTenant,
  type ScopeResolveArgs,
  type ScopeResolver,
} from "./scope-resolvers.js";
