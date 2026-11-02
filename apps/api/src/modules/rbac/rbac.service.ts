import { Inject, Injectable, type ExecutionContext } from "@nestjs/common";
import { ApiError } from "../../common/http/index.js";
import type { TenantContext } from "../../db/index.js";
import { chainInTenant, decideTenant, findGrant, type Grant, type TenantDecision } from "./access.js";
import type { PermissionCode } from "./permissions.js";
import { PRINCIPAL_SOURCE, type Principal, type PrincipalSource } from "./principal.js";
import { RoleAssignmentsRepository } from "./role-assignments.repository.js";
import { ScopeHierarchy, type ScopeChain, type ScopeRef } from "./scope.js";

/** Итог успешной проверки права: какое назначение его дало (в аудит — role_assignment_id). */
export type Authorization = {
  readonly permission: PermissionCode;
  readonly scope: ScopeRef;
  readonly chain: ScopeChain;
  readonly grant: Grant;
};

/** Проверка прав (roles-and-data §1.2, шаг 4): есть ли назначение с permission на область или её предка. */
@Injectable()
export class RbacService {
  constructor(
    @Inject(RoleAssignmentsRepository) private readonly assignments: RoleAssignmentsRepository,
    @Inject(ScopeHierarchy) private readonly hierarchy: ScopeHierarchy,
  ) {}

  /** Действующие назначения пользователя (все регионы). */
  grantsOf(userId: string): Promise<Grant[]> {
    return this.assignments.activeGrantsOf(userId);
  }

  /** Назначение, дающее permission на область, или undefined (нет назначения, объект не найден). */
  async authorize(
    grants: readonly Grant[],
    permission: PermissionCode,
    target: ScopeRef,
    now = new Date(),
  ): Promise<Authorization | undefined> {
    const chain = await this.hierarchy.chain(target);
    if (!chain) return undefined;
    const grant = findGrant(grants, permission, chain, now);
    return grant && { permission, scope: target, chain, grant };
  }

  /**
   * authorize() плюс сверка региона объекта с tenant-контекстом (chainInTenant): объект другого региона, чем
   * контекст, или объект региона без контекста — undefined. Общая проверка PermissionGuard и can().
   */
  async authorizeInTenant(
    grants: readonly Grant[],
    permission: PermissionCode,
    target: ScopeRef,
    tenant: TenantContext | undefined,
    now = new Date(),
  ): Promise<Authorization | undefined> {
    const auth = await this.authorize(grants, permission, target, now);
    return auth && chainInTenant(auth.chain, tenant) ? auth : undefined;
  }

  /**
   * Есть ли у принципала право на область (назначения загружаются из БД). Как PermissionGuard: tenant-контекст —
   * из назначений и выбранного региона (decideTenant); выбранный регион без назначения или объект вне контекста —
   * false.
   */
  async can(principal: Principal, permission: PermissionCode, target: ScopeRef): Promise<boolean> {
    const now = new Date();
    const grants = await this.grantsOf(principal.userId);
    const decision = decideTenant(grants, principal.regionId, now);
    if ("denied" in decision) return false;
    return (await this.authorizeInTenant(grants, permission, target, decision.tenant, now)) !== undefined;
  }
}

type AccessState = {
  readonly principal: Principal | undefined;
  readonly grants: readonly Grant[];
  readonly tenant: TenantDecision;
};

/**
 * Доступ текущего запроса, вычисляется один раз на запрос (кэш по объекту запроса): принципал (PRINCIPAL_SOURCE),
 * его назначения и tenant-контекст. Общий для PermissionGuard и RbacTenantContextSource — проверка права и
 * регион транзакции запроса выводятся из одних и тех же назначений.
 */
@Injectable()
export class RequestAccess {
  private readonly principals = new WeakMap<object, Promise<Principal | undefined>>();
  private readonly states = new WeakMap<object, Promise<AccessState>>();

  constructor(
    @Inject(PRINCIPAL_SOURCE) private readonly source: PrincipalSource,
    @Inject(RbacService) private readonly rbac: RbacService,
  ) {}

  principal(context: ExecutionContext): Promise<Principal | undefined> {
    return memo(this.principals, requestOf(context), async () => this.source.resolve(context));
  }

  state(context: ExecutionContext): Promise<AccessState> {
    return memo(this.states, requestOf(context), async () => {
      const principal = await this.principal(context);
      const grants = principal ? await this.rbac.grantsOf(principal.userId) : [];
      return { principal, grants, tenant: decideTenant(grants, principal?.regionId, new Date()) };
    });
  }

  /** Tenant-контекст запроса; выбранный регион без назначения в нём — 403 FORBIDDEN. */
  async tenant(context: ExecutionContext): Promise<TenantContext | undefined> {
    const { tenant } = await this.state(context);
    if ("denied" in tenant) throw new ApiError("FORBIDDEN");
    return tenant.tenant;
  }
}

function requestOf(context: ExecutionContext): object {
  return context.switchToHttp().getRequest<object>();
}

function memo<T>(cache: WeakMap<object, Promise<T>>, key: object, compute: () => Promise<T>): Promise<T> {
  let value = cache.get(key);
  if (!value) {
    value = compute();
    cache.set(key, value);
  }
  return value;
}
