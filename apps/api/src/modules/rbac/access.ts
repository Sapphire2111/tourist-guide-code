// Чистая логика доступа (без Nest и БД): действует ли назначение, даёт ли оно право на область, какой
// tenant-контекст положен принципалу. Проверка права — roles-and-data §1.2, шаг 4.
import { PLATFORM_CONTEXT, regionContext, type ScopeType, type TenantContext } from "../../db/index.js";
import type { PermissionCode } from "./permissions.js";
import { isRoleCode, roleHasPermission } from "./roles.js";
import { chainRegionId, isUuid, type ScopeChain } from "./scope.js";

/** Назначение роли в виде, нужном для проверки (строка role_assignments без служебных полей). */
export type Grant = {
  readonly id: string;
  readonly role: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
  readonly regionId: string | null;
  readonly validUntil: Date | null;
  readonly revokedAt?: Date | null;
};

/** Действует ли назначение в момент now: не отозвано и не истекло. */
export function isGrantActive(g: Grant, now: Date): boolean {
  return !g.revokedAt && (g.validUntil === null || g.validUntil.getTime() > now.getTime());
}

/**
 * Назначение, дающее permission на область цепочки (сама область или предок), или undefined. Порядок — от
 * самой узкой области: в аудит попадает назначение, ближайшее к объекту.
 */
export function findGrant(
  grants: readonly Grant[],
  permission: PermissionCode,
  chain: ScopeChain,
  now: Date,
): Grant | undefined {
  const usable = grants.filter((g) => isGrantActive(g, now) && roleHasPermission(g.role, permission));
  for (const s of chain) {
    const id = s.type === "PLATFORM" ? null : s.id;
    const hit = usable.find((g) => g.scopeType === s.type && g.scopeId?.toLowerCase() === id?.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Tenant-контекст запроса по назначениям принципала:
 * - выбран регион (`requested`, из сессии — режим D-50): он, если есть назначение PLATFORM или любое назначение в
 *   этом регионе; иначе отказ (`denied`) — принципал региона A не получает контекст региона B;
 * - не выбран: назначение PLATFORM → PLATFORM (даже если есть и региональные назначения); назначения ровно в
 *   одном регионе → этот регион; иначе (нет назначений или несколько регионов) — без контекста.
 * Учитываются только действующие назначения ролей из реестра: роль не из реестра (например, удалённая) прав не
 * даёт и контекста не открывает — иначе такое назначение на PLATFORM открыло бы RLS всех регионов.
 */
export type TenantDecision = { readonly tenant: TenantContext | undefined } | { readonly denied: true };

export function decideTenant(
  grants: readonly Grant[],
  requested: string | null | undefined,
  now: Date,
): TenantDecision {
  const active = grants.filter((g) => isGrantActive(g, now) && isRoleCode(g.role));
  const platform = active.some((g) => g.scopeType === "PLATFORM");
  if (requested !== undefined && requested !== null) {
    if (!isUuid(requested)) return { denied: true };
    const region = requested.toLowerCase();
    return platform || active.some((g) => g.regionId?.toLowerCase() === region)
      ? { tenant: regionContext(region) }
      : { denied: true };
  }
  if (platform) return { tenant: PLATFORM_CONTEXT };
  const regions = new Set(active.flatMap((g) => (g.regionId ? [g.regionId.toLowerCase()] : [])));
  return regions.size === 1 ? { tenant: regionContext([...regions][0]!) } : { tenant: undefined };
}

/**
 * Подтверждается ли право на объект цепочки в tenant-контексте запроса: объект без региона (PLATFORM) — да; объект
 * в регионе — только в контексте PLATFORM/SYSTEM или этого же региона. Без контекста (несколько регионов, регион
 * не выбран) объект региона — нет: его данные в транзакции запроса всё равно недоступны (ADR-005).
 */
export function chainInTenant(chain: ScopeChain, tenant: TenantContext | undefined): boolean {
  const region = chainRegionId(chain);
  if (region === null) return true;
  if (!tenant) return false;
  return tenant.kind !== "region" || tenant.regionId === region;
}
