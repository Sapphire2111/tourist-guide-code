// Unit: бизнес-роли админки (блок 3) — права по матрице roles-and-data §1.4 и допустимые области.
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "./permissions.js";
import { roleHasPermission, ROLES } from "./roles.js";

describe("бизнес-роли админки", () => {
  it("области: SUPERADMIN — PLATFORM, REGION_ADMIN и MODERATOR — REGION", () => {
    expect([...ROLES.SUPERADMIN.scopes]).toEqual(["PLATFORM"]);
    expect([...ROLES.REGION_ADMIN.scopes]).toEqual(["REGION"]);
    expect([...ROLES.MODERATOR.scopes]).toEqual(["REGION"]);
  });

  it("REGION_ADMIN: QR, экстренные контакты, аудит, контент; без платформенных прав", () => {
    for (const p of [
      "qr_point.manage",
      "qr_point.deactivate",
      "emergency_contact.manage",
      "audit.read",
      "place.edit",
      "media.upload",
      "promotion.manage",
    ] as const)
      expect(roleHasPermission("REGION_ADMIN", p), p).toBe(true);
    for (const p of [
      "feature_flag.manage",
      "region.create",
      "category.manage.global",
      "role.assign.superadmin",
      "audit.read.platform",
      "ledger.adjust",
    ] as const)
      expect(roleHasPermission("REGION_ADMIN", p), p).toBe(false);
  });

  it("MODERATOR: модерация и аудит, без QR, контактов и правки мест", () => {
    expect(roleHasPermission("MODERATOR", "place.moderate")).toBe(true);
    expect(roleHasPermission("MODERATOR", "audit.read")).toBe(true);
    for (const p of [
      "qr_point.manage",
      "emergency_contact.manage",
      "place.edit",
      "role.assign.admin",
    ] as const)
      expect(roleHasPermission("MODERATOR", p), p).toBe(false);
  });

  it("SUPERADMIN: всё платформенное, кроме операций партнёра и SYSTEM", () => {
    for (const p of [
      "feature_flag.manage",
      "region.create",
      "qr_point.manage",
      "audit.read.platform",
    ] as const)
      expect(roleHasPermission("SUPERADMIN", p), p).toBe(true);
    for (const p of [
      "booking.confirm",
      "transaction.quote",
      "review.respond",
      "notification.send.system",
    ] as const)
      expect(roleHasPermission("SUPERADMIN", p), p).toBe(false);
    expect(ROLES.SUPERADMIN.permissions.size).toBeLessThan(PERMISSIONS.length);
  });

  it("catalog.read.admin (админка каталога, ADR-0017): у REGION_ADMIN, MODERATOR и SUPERADMIN", () => {
    for (const r of ["REGION_ADMIN", "MODERATOR", "SUPERADMIN"] as const)
      expect(roleHasPermission(r, "catalog.read.admin"), r).toBe(true);
  });

  it("брони (блок 7): кассир — урезанные P04/P05, менеджер — ещё ресурсы, отказ, альтернатива, телефон", () => {
    for (const p of [
      "booking.read",
      "booking.confirm",
      "booking.manual.create",
      "booking.complete",
      "booking.no_show",
      "availability.status.manual",
    ] as const) {
      expect(roleHasPermission("ORG_STAFF", p), p).toBe(true);
      expect(roleHasPermission("ORG_MANAGER", p), p).toBe(true);
    }
    for (const p of [
      "resource.manage",
      "availability.edit",
      "booking.reject",
      "booking.propose_alternative",
      "booking.admin.read",
    ] as const) {
      expect(roleHasPermission("ORG_STAFF", p), p).toBe(false);
      expect(roleHasPermission("ORG_MANAGER", p), p).toBe(true);
      expect(roleHasPermission("ORG_OWNER", p), p).toBe(true);
    }
    expect(roleHasPermission("ORG_MANAGER", "booking.expire")).toBe(false);
  });

  it("каждое право бизнес-роли — из каталога", () => {
    for (const r of ["SUPERADMIN", "REGION_ADMIN", "MODERATOR"] as const)
      for (const p of ROLES[r].permissions) expect(PERMISSIONS, `${r}: ${p}`).toContain(p);
  });
});
