import { describe, expect, it } from "vitest";
import { bearerToken, generateSessionToken, hashSessionToken, isSessionToken } from "./session-token.js";

describe("токен сессии", () => {
  it("формат tgs_ + 43 символа base64url, токены не повторяются", () => {
    const tokens = new Set(Array.from({ length: 100 }, generateSessionToken));
    expect(tokens.size).toBe(100);
    for (const t of tokens) expect(isSessionToken(t), t).toBe(true);
  });

  it("хэш — sha256 (32 байта), детерминирован и различает токены", () => {
    const a = generateSessionToken();
    expect(hashSessionToken(a)).toHaveLength(32);
    expect(hashSessionToken(a).equals(hashSessionToken(a))).toBe(true);
    expect(hashSessionToken(a).equals(hashSessionToken(generateSessionToken()))).toBe(false);
  });

  it("Bearer: регистр схемы не важен; чужая схема, массив, мусор и не наш формат — undefined", () => {
    const t = generateSessionToken();
    expect(bearerToken(`Bearer ${t}`)).toBe(t);
    expect(bearerToken(`bearer  ${t} `)).toBe(t);
    for (const bad of [
      undefined,
      [`Bearer ${t}`],
      t,
      `Basic ${t}`,
      `Bearer ${t} extra`,
      "Bearer tgs_short",
      `Bearer ${t.slice(0, -1)}!`,
      "Bearer ",
    ])
      expect(bearerToken(bad), String(bad)).toBeUndefined();
  });
});
