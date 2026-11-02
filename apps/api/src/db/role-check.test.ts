// Unit (без БД): решение при старте api по роли БД.
import { describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../test/support/recording-db.js";
import { checkDbRole, readDbRoleStatus, RlsBypassRoleError, type DbRoleStatus } from "./role-check.js";

function logger() {
  return { warn: vi.fn(), log: vi.fn() };
}

const app: DbRoleStatus = { role: "tg_api", bypassesRls: false };
const owner: DbRoleStatus = { role: "postgres", bypassesRls: true };

describe("checkDbRole", () => {
  it("роль без обхода RLS — старт во всех окружениях", async () => {
    for (const appEnv of ["local", "staging", "prod"] as const) {
      const l = logger();
      await expect(checkDbRole({ appEnv, read: async () => app, logger: l })).resolves.toBeUndefined();
      expect(l.warn).not.toHaveBeenCalled();
      expect(l.log).toHaveBeenCalledWith(expect.stringContaining("tg_api"));
    }
  });

  it("SUPERUSER/BYPASSRLS: staging и prod — отказ запуска, local — предупреждение", async () => {
    for (const appEnv of ["staging", "prod"] as const)
      await expect(checkDbRole({ appEnv, read: async () => owner, logger: logger() })).rejects.toBeInstanceOf(
        RlsBypassRoleError,
      );
    const l = logger();
    await checkDbRole({ appEnv: "local", read: async () => owner, logger: l });
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining("BYPASSRLS"));
  });

  it("БД недоступна или не отвечает — предупреждение и старт, как без проверки", async () => {
    const l = logger();
    await checkDbRole({
      appEnv: "prod",
      read: async () => Promise.reject(new Error("connect ECONNREFUSED")),
      logger: l,
    });
    expect(l.warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));

    const slow = logger();
    await checkDbRole({ appEnv: "prod", read: () => new Promise(() => {}), logger: slow, timeoutMs: 10 });
    expect(slow.warn).toHaveBeenCalledWith(expect.stringContaining("нет ответа БД"));
  });
});

describe("readDbRoleStatus", () => {
  it("один запрос к pg_roles по current_user, без tenant-контекста", async () => {
    const { db, queries } = recordingDb();
    // DummyDriver не возвращает строк.
    await expect(readDbRoleStatus(db)).rejects.toThrow(/не найдена/);
    expect(queries[0]?.sql).toContain(
      "(rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user",
    );
  });
});
