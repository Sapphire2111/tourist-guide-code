// Unit: аргументы CLI admin:create (ADR-0018) — пароль аргументом не принимается, роль и регион согласованы.
import { describe, expect, it } from "vitest";
import { AdminCreateError, assertPassword, parseAdminCreateArgs } from "./admin-create.js";

describe("parseAdminCreateArgs", () => {
  it("SUPERADMIN без региона; REGION_ADMIN и MODERATOR — с регионом; логин в нижний регистр; `--` и --x=y", () => {
    expect(parseAdminCreateArgs(["--", "--login", "Admin@Example.com", "--role", "SUPERADMIN"])).toEqual({
      login: "admin@example.com",
      role: "SUPERADMIN",
      regionCode: null,
    });
    expect(parseAdminCreateArgs(["--login=ra1", "--role=REGION_ADMIN", "--region=test-region"])).toEqual({
      login: "ra1",
      role: "REGION_ADMIN",
      regionCode: "test-region",
    });
    expect(parseAdminCreateArgs(["--login", "mod", "--role", "MODERATOR", "--region", "r"]).role).toBe(
      "MODERATOR",
    );
  });

  it("ошибки: пароль аргументом, неизвестная роль/флаг, регион не к той роли, плохой логин", () => {
    for (const argv of [
      ["--login", "admin", "--role", "SUPERADMIN", "--password", "secret-secret"],
      ["--login", "admin", "--role", "SUPERADMIN", "--password=secret-secret"],
      ["--login", "admin", "--role", "TECH_SUPERUSER"],
      ["--login", "admin", "--role", "SUPERADMIN", "--region", "test-region"],
      ["--login", "admin", "--role", "REGION_ADMIN"],
      ["--login", "a", "--role", "SUPERADMIN"],
      ["--login", "has space", "--role", "SUPERADMIN"],
      ["--role", "SUPERADMIN"],
      ["--login", "--role", "SUPERADMIN"],
      ["--foo", "x"],
      ["admin"],
    ])
      expect(() => parseAdminCreateArgs(argv), argv.join(" ")).toThrow(AdminCreateError);
  });
});

describe("assertPassword", () => {
  it("короткий пароль или с пробелами по краям — ошибка", () => {
    expect(() => assertPassword("short")).toThrow(AdminCreateError);
    expect(() => assertPassword(" long-enough-password")).toThrow(AdminCreateError);
    expect(() => assertPassword("long-enough-password")).not.toThrow();
  });
});
