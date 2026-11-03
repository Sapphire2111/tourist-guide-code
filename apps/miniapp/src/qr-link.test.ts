import { describe, expect, it, vi } from "vitest";
import { parseQrText } from "./qr-link.js";

const INV = "B".repeat(43);

describe("parseQrText", () => {
  it.each([
    ["https://t.me/tg_gid_bot?startapp=demoHotel01", { kind: "code", code: "demoHotel01" }],
    ["https://t.me/tg_gid_bot/app?startapp=demoHotel01", { kind: "code", code: "demoHotel01" }],
    ["http://t.me/tg_gid_bot?start=demoHotel01", { kind: "code", code: "demoHotel01" }],
    ["https://telegram.me/tg_gid_bot?startapp=abc-DEF_123", { kind: "code", code: "abc-DEF_123" }],
    ["tg://resolve?domain=tg_gid_bot&startapp=demoHotel01", { kind: "code", code: "demoHotel01" }],
    ["  https://t.me/tg_gid_bot?startapp=demoHotel01\n", { kind: "code", code: "demoHotel01" }],
    [`https://t.me/tg_gid_bot?startapp=inv_${INV}`, { kind: "invite", token: INV }],
    ["https://t.me/tg_gid_bot?startapp=inv_short", { kind: "foreign" }],
    ["https://t.me/tg_gid_bot?startapp=short", { kind: "foreign" }],
    ["https://t.me/tg_gid_bot?startapp=1234567890", { kind: "foreign" }],
    ["https://t.me/tg_gid_bot?startapp=bad%20code%20here", { kind: "foreign" }],
    [`https://t.me/tg_gid_bot?startapp=${"a".repeat(65)}`, { kind: "foreign" }],
    ["https://t.me/tg_gid_bot", { kind: "foreign" }],
    ["https://t.me/+AbCdEf?startapp=demoHotel01", { kind: "foreign" }],
    ["https://evil.example/tg_gid_bot?startapp=demoHotel01", { kind: "foreign" }],
    ["https://t.me.evil.example/tg_gid_bot?startapp=demoHotel01", { kind: "foreign" }],
    ["javascript:alert(1)", { kind: "foreign" }],
    ["tg://resolve/?domain=tg_gid_bot&start=demoHotel01", { kind: "code", code: "demoHotel01" }],
    ["tg://resolve?domain=x&startapp=demoHotel01", { kind: "foreign" }],
    ["tg://msg?text=hi&startapp=demoHotel01", { kind: "foreign" }],
    ["https://example.com", { kind: "foreign" }],
    ["demoHotel01", { kind: "foreign" }],
    ["", { kind: "foreign" }],
  ])("%s", (text, expected) => {
    expect(parseQrText(text, "")).toEqual(expected);
  });

  it("с заданным именем бота чужой бот отвергается (без учёта регистра)", () => {
    expect(parseQrText("https://t.me/Other_bot?startapp=demoHotel01", "tg_gid_bot")).toEqual({
      kind: "foreign",
    });
    expect(parseQrText("https://t.me/TG_Gid_Bot?startapp=demoHotel01", "tg_gid_bot")).toEqual({
      kind: "code",
      code: "demoHotel01",
    });
  });

  it("tg: в старых WebView (opaque-разбор: hostname пуст, pathname //resolve)", () => {
    const Real = URL;
    class OpaqueURL extends Real {
      override get hostname() {
        return this.protocol === "tg:" ? "" : super.hostname;
      }
      override get pathname() {
        return this.protocol === "tg:" ? "//resolve" : super.pathname;
      }
    }
    vi.stubGlobal("URL", OpaqueURL);
    try {
      expect(parseQrText("tg://resolve?domain=tg_gid_bot&startapp=demoHotel01", "tg_gid_bot")).toEqual({
        kind: "code",
        code: "demoHotel01",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
