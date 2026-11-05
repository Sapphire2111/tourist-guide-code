import { describe, expect, it } from "vitest";
import { ERROR_MESSAGE_KEYS } from "@tg/shared";
import { adminEn, adminUk } from "./admin.js";
import { en } from "./en.js";
import * as enModule from "./en-messages.js";
import * as messagesModule from "./messages.js";
import {
  createTranslator,
  isAllDay,
  DEFAULT_LOCALE,
  ENABLED_LOCALES,
  pickLocalized,
  resolveLocale,
  SUPPORTED_LOCALES,
  uk,
} from "./index.js";

describe("@tg/i18n", () => {
  it("язык по умолчанию — украинский и входит в поддерживаемые", () => {
    expect(DEFAULT_LOCALE).toBe("uk");
    expect(SUPPORTED_LOCALES).toContain("uk");
  });

  it("все ключи ошибок API из @tg/shared есть в uk", () => {
    for (const key of Object.values(ERROR_MESSAGE_KEYS)) expect(uk).toHaveProperty([key]);
  });

  it("en не содержит ключей, которых нет в uk", () => {
    for (const key of Object.keys(en)) expect(uk).toHaveProperty([key]);
    for (const key of Object.keys(adminEn)) expect(adminUk).toHaveProperty([key]);
  });

  it("uk не содержит пустых текстов", () => {
    for (const text of Object.values(uk)) expect(text.trim()).not.toBe("");
  });

  it("resolveLocale: поддерживаемые формы и fallback", () => {
    expect(resolveLocale("en-US", SUPPORTED_LOCALES)).toBe("en");
    expect(resolveLocale("EN", SUPPORTED_LOCALES)).toBe("en");
    expect(resolveLocale("uk-UA")).toBe("uk");
    expect(resolveLocale("uk_UA")).toBe("uk");
    expect(resolveLocale("de")).toBe("uk");
    expect(resolveLocale("")).toBe("uk");
    expect(resolveLocale(undefined)).toBe("uk");
    expect(resolveLocale(null)).toBe("uk");
  });

  it("t: перевод, fallback на uk, подстановка параметров", () => {
    const tEn = createTranslator("en");
    expect(tEn.t("admin.title")).toBe("Admin");
    expect(tEn.t("admin.title")).not.toBe(adminUk["admin.title"]);
    expect(tEn.t("errors.forbidden")).toBe(uk["errors.forbidden"]);
    expect(createTranslator().t("miniapp.greeting", { name: "Олена" })).toBe("Вітаємо, Олена!");
    expect(createTranslator().tDynamic("miniapp.greeting")).toBe("Вітаємо, {name}!");
  });

  it("tDynamic: неизвестный ключ возвращается как есть", () => {
    expect(createTranslator("en").tDynamic("errors.fromFutureServer")).toBe("errors.fromFutureServer");
    expect(createTranslator("en").tDynamic("errors.validation")).toBe(uk["errors.validation"]);
  });

  it("pickLocalized: язык пользователя → uk", () => {
    const text = { uk: "Замок", en: "Castle" };
    expect(pickLocalized(text, "en")).toBe("Castle");
    expect(pickLocalized({ uk: "Замок" }, "en")).toBe("Замок");
    expect(pickLocalized({ uk: "Замок", en: "" }, "en")).toBe("Замок");
    expect(pickLocalized(text, "uk")).toBe("Замок");
  });

  it("tDynamic не смотрит в прототип", () => {
    const t = createTranslator("en");
    expect(t.tDynamic("__proto__")).toBe("__proto__");
    expect(t.tDynamic("constructor", {})).toBe("constructor");
    expect(t.tDynamic("toString")).toBe("toString");
    expect(t.tDynamic("x.constructor")).toBe("x.constructor");
    expect(t.tDynamic("miniapp.greeting", { constructor: "x" })).toBe("Welcome, {name}!");
    expect(createTranslator().tDynamic("app.name", {})).toBe("Гід туриста");
  });

  it("tDynamic: откат по точкам к родителю", () => {
    const t = createTranslator("en");
    expect(t.tDynamic("errors.validation.isEmail")).toBe(uk["errors.validation.isEmail"]);
    expect(t.tDynamic("errors.validation.isFuture")).toBe(uk["errors.validation"]);
    expect(t.tDynamic("errors.validation.isFuture.deep")).toBe(uk["errors.validation"]);
    expect(t.tDynamic("errors.nothing")).toBe("errors.nothing");
  });

  it("resolveLocale: по умолчанию только включённые локали", () => {
    expect(ENABLED_LOCALES).toEqual(["uk"]);
    expect(resolveLocale("en-US")).toBe("uk");
    expect(resolveLocale("en-US", SUPPORTED_LOCALES)).toBe("en");
  });
});

describe("en для Mini App", () => {
  it("все ключи miniapp.* переведены (lang=en соответствует содержимому)", () => {
    const missing = Object.keys(uk).filter((k) => k.startsWith("miniapp.") && !Object.hasOwn(en, k));
    expect(missing).toEqual([]);
  });

  it("подсказка сканера QR — не длиннее 64 символов (лимит Telegram) во всех языках", () => {
    for (const messages of [uk, en]) {
      const text = messages["miniapp.scan.prompt"];
      if (text !== undefined) expect(text.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("isAllDay", () => {
  it("00:00–23:59 и 00:00–24:00 (с секундами и без) — весь день; остальное нет", () => {
    expect(isAllDay("00:00", "23:59")).toBe(true);
    expect(isAllDay("00:00:00", "24:00:00")).toBe(true);
    expect(isAllDay("00:00", "00:00")).toBe(false);
    expect(isAllDay("00:00", "22:00")).toBe(false);
    expect(isAllDay("08:00", "23:59")).toBe(false);
  });

  describe("разбиение словарей (scripts/split-i18n.mjs)", () => {
    it("messages.ts экспортирует только uk; en-messages — только en", () => {
      expect(Object.keys(messagesModule)).toEqual(["uk"]);
      expect(Object.keys(enModule)).toEqual(["en"]);
    });

    it("admin.* только в adminUk/adminEn, без пересечений с uk/en", () => {
      expect(Object.keys(uk).filter((k) => k.startsWith("admin."))).toEqual([]);
      expect(Object.keys(en).filter((k) => k.startsWith("admin."))).toEqual([]);
      expect(Object.keys(adminUk).filter((k) => !k.startsWith("admin."))).toEqual([]);
      expect(Object.keys(adminEn).filter((k) => !k.startsWith("admin."))).toEqual([]);
      expect(Object.keys(adminUk).filter((k) => Object.hasOwn(uk, k))).toEqual([]);
    });

    it("adminUk не содержит пустых текстов", () => {
      expect(Object.keys(adminUk).length).toBeGreaterThan(0);
      for (const v of Object.values(adminUk)) expect(v.trim()).not.toBe("");
    });
  });
});
