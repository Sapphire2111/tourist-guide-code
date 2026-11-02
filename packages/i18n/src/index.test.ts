import { describe, expect, it } from "vitest";
import { ERROR_MESSAGE_KEYS } from "@tg/shared";
import {
  createTranslator,
  DEFAULT_LOCALE,
  en,
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
    expect(tEn.t("admin.title")).not.toBe(uk["admin.title"]);
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
});
