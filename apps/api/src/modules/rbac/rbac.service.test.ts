// Unit (без БД): RbacService.can() — та же проверка, что у PermissionGuard: право по назначениям плюс регион объекта
// против tenant-контекста (выбранный регион или выведенный из назначений).
import { describe, expect, it } from "vitest";
import type { Grant } from "./access.js";
import type { Principal } from "./principal.js";
import { RbacService } from "./rbac.service.js";
import type { RoleAssignmentsRepository } from "./role-assignments.repository.js";
import { PLATFORM_SCOPE, regionScope, scope, ScopeHierarchy, type ScopeRef } from "./scope.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const ORG_A = "0190f5c2-7d3e-7000-8000-0000000000a1";
const ORG_B = "0190f5c2-7d3e-7000-8000-0000000000b1";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";

function grant(id: string, role: string, s: ScopeRef, regionId: string | null): Grant {
  return {
    id,
    role,
    scopeType: s.type,
    scopeId: s.type === "PLATFORM" ? null : s.id,
    regionId,
    validUntil: null,
  };
}

const REGION_ADMIN_A = grant("0190f5c2-7d3e-7000-8000-000000000101", "TECH_REGION_ADMIN", regionScope(A), A);
const SUPERUSER = grant("0190f5c2-7d3e-7000-8000-000000000102", "TECH_SUPERUSER", PLATFORM_SCOPE, null);
const AUDITOR_B = grant("0190f5c2-7d3e-7000-8000-000000000103", "TECH_AUDITOR", regionScope(B), B);

function rbac(grants: Grant[]): RbacService {
  const repo = { activeGrantsOf: () => Promise.resolve(grants) } as unknown as RoleAssignmentsRepository;
  const hierarchy = new ScopeHierarchy({
    ORGANIZATION: (id) => ({ [ORG_A]: regionScope(A), [ORG_B]: regionScope(B) })[id],
  });
  return new RbacService(repo, hierarchy);
}

const orgA = scope("ORGANIZATION", ORG_A);
const orgB = scope("ORGANIZATION", ORG_B);
const user = (regionId?: string): Principal => ({ userId: USER, regionId });

describe("RbacService.can", () => {
  it("назначение в регионе A: объект A — да, объект B — нет, неизвестный объект — нет", async () => {
    const svc = rbac([REGION_ADMIN_A]);
    expect(await svc.can(user(), "organization.edit", orgA)).toBe(true);
    expect(await svc.can(user(), "organization.edit", orgB)).toBe(false);
    expect(
      await svc.can(
        user(),
        "organization.edit",
        scope("ORGANIZATION", "0190f5c2-7d3e-7000-8000-0000000000ff"),
      ),
    ).toBe(false);
  });

  it("PLATFORM: без выбора региона — любой объект; выбран регион A — объект B не подтверждается", async () => {
    const svc = rbac([SUPERUSER]);
    expect(await svc.can(user(), "organization.edit", orgB)).toBe(true);
    expect(await svc.can(user(A), "organization.edit", orgA)).toBe(true);
    expect(await svc.can(user(A), "organization.edit", orgB)).toBe(false);
  });

  it("выбран регион без назначения в нём — false даже для объекта с правом", async () => {
    expect(await rbac([REGION_ADMIN_A]).can(user(B), "organization.edit", orgA)).toBe(false);
  });

  it("несколько регионов, регион не выбран — объект региона не подтверждается; выбран A — подтверждается", async () => {
    const svc = rbac([REGION_ADMIN_A, AUDITOR_B]);
    expect(await svc.can(user(), "organization.edit", orgA)).toBe(false);
    expect(await svc.can(user(A), "organization.edit", orgA)).toBe(true);
  });
});
