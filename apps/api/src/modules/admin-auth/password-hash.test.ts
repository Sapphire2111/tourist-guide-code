// Unit: хэш пароля админа (scrypt, ADR-0018) — формат строки, соль, проверка, повреждённый хэш, «хэш-бомба».
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRYPT,
  hashPassword,
  isAcceptablePassword,
  verifyDummy,
  verifyPassword,
  warmUpDummy,
} from "./password-hash.js";

// Слабые параметры — только чтобы тест шёл быстро; формат и логика те же.
const FAST = { N: 1024, r: 8, p: 1 };

describe("hashPassword / verifyPassword", () => {
  it("параметры по умолчанию — в строке хэша; формат совпадает с CHECK миграции 0013", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(DEFAULT_SCRYPT).toEqual({ N: 32768, r: 8, p: 1 });
    await expect(verifyPassword("correct horse battery", hash)).resolves.toBe(true);
  });

  it("случайная соль: одинаковый пароль — разные хэши; неверный пароль — false", async () => {
    const a = await hashPassword("пароль-довгий-1", FAST);
    const b = await hashPassword("пароль-довгий-1", FAST);
    expect(a).not.toBe(b);
    await expect(verifyPassword("пароль-довгий-1", b)).resolves.toBe(true);
    await expect(verifyPassword("пароль-довгий-2", a)).resolves.toBe(false);
    await expect(verifyPassword("", a)).resolves.toBe(false);
  });

  it("Unicode нормализуется (NFC): составной и готовый символ — один пароль", async () => {
    const hash = await hashPassword("ї-composed-password", FAST);
    await expect(verifyPassword("ї-composed-password".normalize("NFD"), hash)).resolves.toBe(true);
  });

  it("проверка по параметрам из строки: хэш со старыми параметрами остаётся рабочим", async () => {
    const old = await hashPassword("legacy-password-1", { N: 2048, r: 4, p: 1 });
    expect(old.startsWith("scrypt$2048$4$1$")).toBe(true);
    await expect(verifyPassword("legacy-password-1", old)).resolves.toBe(true);
  });

  it("повреждённый хэш и опасные параметры — false без исключения", async () => {
    const good = await hashPassword("some-password-1", FAST);
    const [, , , , salt, key] = good.split("$");
    for (const bad of [
      "",
      "plain",
      `bcrypt$1024$8$1$${salt}$${key}`,
      `scrypt$1000$8$1$${salt}$${key}`, // N не степень двойки
      `scrypt$${2 ** 24}$8$1$${salt}$${key}`, // «хэш-бомба»: память и время
      `scrypt$1024$64$1$${salt}$${key}`,
      `scrypt$1024$8$1$${salt}$AA`,
      `scrypt$1024$8$1$$${key}`,
    ])
      await expect(verifyPassword("some-password-1", bad), bad).resolves.toBe(false);
  });

  it("verifyDummy всегда false (для несуществующего логина)", async () => {
    await expect(verifyDummy("anything")).resolves.toBe(false);
  });
});

describe("isAcceptablePassword", () => {
  it("12–256 символов без пробелов по краям", () => {
    expect(isAcceptablePassword("a".repeat(12))).toBe(true);
    expect(isAcceptablePassword("a".repeat(11))).toBe(false);
    expect(isAcceptablePassword("a".repeat(256))).toBe(true);
    expect(isAcceptablePassword("a".repeat(257))).toBe(false);
    expect(isAcceptablePassword(" aaaaaaaaaaaaa")).toBe(false);
    expect(isAcceptablePassword("ї".repeat(12))).toBe(true);
  });
});

describe("ограничения разбора хэша (ADR-0018)", () => {
  it("память 128·N·r больше 64 МБ — false; ровно 64 МБ (N = 2^16, r = 8) — допустимо по формату", async () => {
    const good = await hashPassword("some-password-1", FAST);
    const [, , , , salt, key] = good.split("$");
    await expect(verifyPassword("some-password-1", `scrypt$${2 ** 17}$8$1$${salt}$${key}`)).resolves.toBe(
      false,
    );
    await expect(verifyPassword("some-password-1", `scrypt$${2 ** 16}$16$1$${salt}$${key}`)).resolves.toBe(
      false,
    );
  });

  it("длина ключа — из хэша: ключ 64 байта проверяется, больше 64 — отклоняется", async () => {
    const { scrypt } = await import("node:crypto");
    const salt = Buffer.from("0123456789abcdef");
    const derive = (len: number) =>
      new Promise<Buffer>((res, rej) =>
        scrypt("long-key-password", salt, len, { N: 1024, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))),
      );
    const h64 = `scrypt$1024$8$1$${salt.toString("base64url")}$${(await derive(64)).toString("base64url")}`;
    await expect(verifyPassword("long-key-password", h64)).resolves.toBe(true);
    await expect(verifyPassword("other-password-1", h64)).resolves.toBe(false);
    const h65 = `scrypt$1024$8$1$${salt.toString("base64url")}$${(await derive(65)).toString("base64url")}`;
    await expect(verifyPassword("long-key-password", h65)).resolves.toBe(false);
  });

  it("warmUpDummy готовит фиктивный хэш заранее", async () => {
    await expect(warmUpDummy()).resolves.toBeUndefined();
  });
});
