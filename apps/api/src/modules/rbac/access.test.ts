// Unit: иерархия областей и проверка права (T1-12) — назначение на REGION даёт доступ к ORGANIZATION внутри
// региона и не даёт в другом; нет назначения, отозванное, истёкшее — нет доступа; PLATFORM — всё. Плюс выбор
// tenant-контекста по назначениям (принципал региона A не получает контекст региона B).
import { describe, expect, it } from "vitest";
import { PLATFORM_CONTEXT, regionContext, SYSTEM_CONTEXT } from "../../db/index.js";
import { chainInTenant, decideTenant, findGrant, isGrantActive, type Grant } from "./access.js";
import { PERMISSIONS } from "./permissions.js";
import { ROLES, roleHasPermission } from "./roles.js";
import { PLATFORM_SCOPE, regionScope, scope, ScopeHierarchy, type ScopeRef } from "./scope.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const ORG_A = "0190f5c2-7d3e-7000-8000-0000000000a1";
const ORG_B = "0190f5c2-7d3e-7000-8000-0000000000b1";
const PLACE_A = "0190f5c2-7d3e-7000-8000-0000000000a2";
const RES_A = "0190f5c2-7d3e-7000-8000-0000000000a3";
const NOW = new Date("2026-11-01T12:00:00Z");

let seq = 0;
function grant(role: string, s: ScopeRef, regionId: string | null, extra: Partial<Grant> = {}): Grant {
  seq += 1;
  return {
    id: `0190f5c2-7d3e-7000-8000-${String(seq).padStart(12, "0")}`,
    role,
    scopeType: s.type,
    scopeId: s.type === "PLATFORM" ? null : s.id,
    regionId,
    validUntil: null,
    ...extra,
  };
}

// Тестовая иерархия: ORG_A, PLACE_A, RES_A — в регионе A; ORG_B — в регионе B.
const hierarchy = new ScopeHierarchy({
  ORGANIZATION: (id) => ({ [ORG_A]: regionScope(A), [ORG_B]: regionScope(B) })[id],
  PLACE: (id) => (id === PLACE_A ? scope("ORGANIZATION", ORG_A) : undefined),
  RESOURCE: (id) => (id === RES_A ? scope("PLACE", PLACE_A) : undefined),
});

async function chainOf(s: ScopeRef) {
  const chain = await hierarchy.chain(s);
  if (!chain) throw new Error("цепочка не найдена");
  return chain;
}

const orgA = scope("ORGANIZATION", ORG_A);
const orgB = scope("ORGANIZATION", ORG_B);
const regionAdminA = grant("TECH_REGION_ADMIN", regionScope(A), A);

describe("ScopeHierarchy", () => {
  it("цепочка от области до PLATFORM: RESOURCE → PLACE → ORGANIZATION → REGION → PLATFORM", async () => {
    expect(await chainOf(scope("RESOURCE", RES_A))).toEqual([
      scope("RESOURCE", RES_A),
      scope("PLACE", PLACE_A),
      orgA,
      regionScope(A),
      PLATFORM_SCOPE,
    ]);
    expect(await chainOf(PLATFORM_SCOPE)).toEqual([PLATFORM_SCOPE]);
  });

  it("объект не найден — undefined; нет загрузчика уровня или родитель не выше — ошибка конфигурации", async () => {
    expect(
      await hierarchy.chain(scope("ORGANIZATION", "0190f5c2-7d3e-7000-8000-0000000000ff")),
    ).toBeUndefined();
    await expect(new ScopeHierarchy().chain(orgA)).rejects.toThrow(/Нет загрузчика/);
    const cyclic = new ScopeHierarchy({ ORGANIZATION: () => scope("PLACE", PLACE_A) });
    await expect(cyclic.chain(orgA)).rejects.toThrow(/не выше/);
  });

  it("id области — только uuid (в нижнем регистре)", () => {
    expect(() => scope("REGION", "A")).toThrow(/не uuid/);
    expect(regionScope(A.toUpperCase())).toEqual(regionScope(A));
  });
});

describe("findGrant: право на область через иерархию", () => {
  it("назначение на REGION A даёт доступ к ORGANIZATION в регионе A", async () => {
    expect(findGrant([regionAdminA], "organization.edit", await chainOf(orgA), NOW)).toBe(regionAdminA);
  });

  it("назначение на REGION A не даёт доступа к ORGANIZATION в регионе B", async () => {
    expect(findGrant([regionAdminA], "organization.edit", await chainOf(orgB), NOW)).toBeUndefined();
  });

  it("нет назначений — нет доступа", async () => {
    expect(findGrant([], "organization.edit", await chainOf(orgA), NOW)).toBeUndefined();
  });

  it("отозванное и истёкшее назначение — нет доступа; срок в будущем — есть", async () => {
    const chain = await chainOf(orgA);
    const revoked = grant("TECH_REGION_ADMIN", regionScope(A), A, {
      revokedAt: new Date("2026-10-01T00:00:00Z"),
    });
    const expired = grant("TECH_REGION_ADMIN", regionScope(A), A, { validUntil: NOW });
    const future = grant("TECH_REGION_ADMIN", regionScope(A), A, {
      validUntil: new Date("2026-12-01T00:00:00Z"),
    });
    expect(isGrantActive(expired, NOW)).toBe(false);
    expect(findGrant([revoked, expired], "organization.edit", chain, NOW)).toBeUndefined();
    expect(findGrant([revoked, future], "organization.edit", chain, NOW)).toBe(future);
  });

  it("PLATFORM даёт право на всё: любой регион и любой уровень", async () => {
    const superuser = grant("TECH_SUPERUSER", PLATFORM_SCOPE, null);
    for (const target of [PLATFORM_SCOPE, regionScope(B), orgB, scope("RESOURCE", RES_A)])
      expect(findGrant([superuser], "feature_flag.manage", await chainOf(target), NOW)).toBe(superuser);
    expect(PERMISSIONS.every((p) => roleHasPermission("TECH_SUPERUSER", p))).toBe(true);
  });

  it("наследование только вниз: назначение на ORGANIZATION не даёт права на её REGION и на другие организации", async () => {
    const editor = grant("TECH_ORG_EDITOR", orgA, A);
    expect(findGrant([editor], "place.edit", await chainOf(scope("PLACE", PLACE_A)), NOW)).toBe(editor);
    expect(findGrant([editor], "organization.edit", await chainOf(regionScope(A)), NOW)).toBeUndefined();
    expect(findGrant([editor], "organization.edit", await chainOf(orgB), NOW)).toBeUndefined();
  });

  it("роль без permission или неизвестная роль прав не даёт; выбирается назначение ближе к объекту", async () => {
    const chain = await chainOf(orgA);
    expect(
      findGrant([grant("TECH_AUDITOR", regionScope(A), A)], "organization.edit", chain, NOW),
    ).toBeUndefined();
    expect(
      findGrant([grant("NO_SUCH_ROLE", regionScope(A), A)], "organization.edit", chain, NOW),
    ).toBeUndefined();
    const editor = grant("TECH_ORG_EDITOR", orgA, A);
    expect(findGrant([regionAdminA, editor], "organization.edit", chain, NOW)).toBe(editor);
  });

  it("реестр: технические роли ссылаются только на коды каталога и на допустимые области", () => {
    for (const def of Object.values(ROLES)) {
      for (const p of def.permissions) expect(PERMISSIONS).toContain(p);
      expect(def.scopes.size).toBeGreaterThan(0);
    }
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });
});

describe("decideTenant: tenant-контекст по назначениям", () => {
  it("назначение в регионе A: контекст A; выбран регион B — отказ", () => {
    expect(decideTenant([regionAdminA], undefined, NOW)).toEqual({ tenant: regionContext(A) });
    expect(decideTenant([regionAdminA], A, NOW)).toEqual({ tenant: regionContext(A) });
    expect(decideTenant([regionAdminA], B, NOW)).toEqual({ denied: true });
    expect(decideTenant([regionAdminA], "не-uuid", NOW)).toEqual({ denied: true });
  });

  it("назначение на организацию даёт контекст её региона", () => {
    expect(decideTenant([grant("TECH_ORG_EDITOR", orgB, B)], undefined, NOW)).toEqual({
      tenant: regionContext(B),
    });
  });

  it("PLATFORM: без выбора — PLATFORM, с выбором — любой регион", () => {
    const superuser = grant("TECH_SUPERUSER", PLATFORM_SCOPE, null);
    expect(decideTenant([superuser], undefined, NOW)).toEqual({ tenant: PLATFORM_CONTEXT });
    expect(decideTenant([superuser], B, NOW)).toEqual({ tenant: regionContext(B) });
  });

  it("нет действующих назначений или несколько регионов без выбора — без контекста; отозванное не в счёт", () => {
    const revokedB = grant("TECH_AUDITOR", regionScope(B), B, { revokedAt: NOW });
    expect(decideTenant([], undefined, NOW)).toEqual({ tenant: undefined });
    expect(decideTenant([revokedB], B, NOW)).toEqual({ denied: true });
    const auditorB = grant("TECH_AUDITOR", regionScope(B), B);
    expect(decideTenant([regionAdminA, auditorB], undefined, NOW)).toEqual({ tenant: undefined });
    expect(decideTenant([regionAdminA, auditorB], B, NOW)).toEqual({ tenant: regionContext(B) });
  });

  it("PLATFORM и региональное назначение без выбора — PLATFORM", () => {
    const superuser = grant("TECH_SUPERUSER", PLATFORM_SCOPE, null);
    expect(decideTenant([regionAdminA, superuser], undefined, NOW)).toEqual({ tenant: PLATFORM_CONTEXT });
  });

  it("роль не из реестра (удалённая) контекста не даёт: ни PLATFORM, ни регион", () => {
    const ghostPlatform = grant("REMOVED_ROLE", PLATFORM_SCOPE, null);
    expect(decideTenant([ghostPlatform], undefined, NOW)).toEqual({ tenant: undefined });
    expect(decideTenant([ghostPlatform], B, NOW)).toEqual({ denied: true });
    expect(decideTenant([ghostPlatform, regionAdminA], undefined, NOW)).toEqual({ tenant: regionContext(A) });
    const ghostB = grant("REMOVED_ROLE", regionScope(B), B);
    expect(decideTenant([ghostB], B, NOW)).toEqual({ denied: true });
    expect(decideTenant([regionAdminA, ghostB], undefined, NOW)).toEqual({ tenant: regionContext(A) });
  });
});

describe("chainInTenant: объект и tenant-контекст", () => {
  it("объект региона — только в контексте этого региона, PLATFORM или SYSTEM; без контекста — нет", async () => {
    const chain = await chainOf(orgA);
    expect(chainInTenant(chain, regionContext(A))).toBe(true);
    expect(chainInTenant(chain, regionContext(B))).toBe(false);
    expect(chainInTenant(chain, PLATFORM_CONTEXT)).toBe(true);
    expect(chainInTenant(chain, SYSTEM_CONTEXT)).toBe(true);
    expect(chainInTenant(chain, undefined)).toBe(false);
  });

  it("объект без региона (PLATFORM) — в любом контексте", async () => {
    const chain = await chainOf(PLATFORM_SCOPE);
    for (const t of [regionContext(A), PLATFORM_CONTEXT, undefined])
      expect(chainInTenant(chain, t)).toBe(true);
  });
});
