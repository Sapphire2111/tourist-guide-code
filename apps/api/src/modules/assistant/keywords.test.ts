// Unit: ключевые слова блюда или кухни → синонимы и написания → регулярное выражение Postgres по целым словам.
import { describe, expect, it } from "vitest";
import { expandKeywords, isKnownKeyword, keywordPattern } from "./keywords.js";

/** Проверка выражения в JS: \m \M Postgres ≈ границы слова (буквы любых алфавитов), \w — буква или цифра. */
function jsRegex(pattern: string): RegExp {
  const body = pattern
    .replace(/\\m/g, "(?<![\\p{L}\\p{N}_])")
    .replace(/\\M/g, "(?![\\p{L}\\p{N}_])")
    .replace(/\\w/g, "[\\p{L}\\p{N}_]");
  return new RegExp(body, "iu");
}

describe("expandKeywords", () => {
  it("суші → вся группа (суши, sushi, роли…); слово модели тоже остаётся", () => {
    const terms = expandKeywords(["Суші"]);
    expect(terms).toEqual(expect.arrayContaining(["суші", "суши", "sushi", "роли", "японськ*"]));
    expect(expandKeywords(["sushi"])).toContain("суші");
    expect(expandKeywords(["роллы"])).toContain("суші");
  });

  it("основа «піц*» ловит формы; фраза — по словам; неизвестное слово — как есть", () => {
    expect(expandKeywords(["піцу"])).toEqual(expect.arrayContaining(["піц*", "pizz*", "піцу"]));
    expect(expandKeywords(["суші бар"])).toEqual(expect.arrayContaining(["суші бар", "sushi"]));
    expect(expandKeywords(["палачінки"])).toEqual(["палачінки"]);
    expect(expandKeywords(["x", "  "])).toEqual([]);
  });

  it("кава, банош, вареники, шаурма, бургер — свои группы", () => {
    expect(expandKeywords(["кава"])).toEqual(expect.arrayContaining(["coffee*", "кав'ярн*"]));
    expect(expandKeywords(["банош"])).toEqual(expect.arrayContaining(["бануш*"]));
    expect(expandKeywords(["вареники"])).toEqual(expect.arrayContaining(["вареник*"]));
    expect(expandKeywords(["шаурма"])).toEqual(expect.arrayContaining(["шаверм*", "shawarma"]));
    expect(expandKeywords(["burger"])).toEqual(expect.arrayContaining(["бургер*"]));
  });
});

describe("isKnownKeyword", () => {
  it("блюдо из словаря — да; название заведения — нет", () => {
    expect(isKnownKeyword("Суші")).toBe(true);
    expect(isKnownKeyword("піцу")).toBe(true);
    expect(isKnownKeyword("суші роли")).toBe(true);
    expect(isKnownKeyword("Суші Барберрі")).toBe(false);
    expect(isKnownKeyword("Смерека")).toBe(false);
    expect(isKnownKeyword("  ")).toBe(false);
  });
});

describe("keywordPattern", () => {
  it("целые слова: суші/Суши/sushi — да, «сушити» и «сушилки» — нет", () => {
    const re = jsRegex(keywordPattern(expandKeywords(["суші"]))!);
    expect(re.test("Суши Кафе Барберрі")).toBe(true);
    expect(re.test("KitsuneSushi")).toBe(false);
    expect(re.test("Teppan sushi & grill")).toBe(true);
    expect(re.test("Відвідувачі хвалять роли та піцу")).toBe(true);
    expect(re.test("ресторан японської кухні")).toBe(true);
    expect(re.test("рушники не було де сушити")).toBe(false);
    expect(re.test("нема навіть сушилки для рук")).toBe(false);
  });

  it("основа с окончанием: піца/піцерія/Pizza; апостроф — любой", () => {
    const pizza = jsRegex(keywordPattern(["піц*", "pizz*"])!);
    expect(pizza.test("Піцерія Дон Япон")).toBe(true);
    expect(pizza.test("Food Market Sushi & Pizza")).toBe(true);
    const coffee = jsRegex(keywordPattern(["кав'ярн*"])!);
    expect(coffee.test("Затишна кавʼярня")).toBe(true);
    expect(coffee.test("кав’ярня")).toBe(true);
  });

  it("для названий — подстрока: «KitsuneSushi» слитно", () => {
    const name = jsRegex(keywordPattern(expandKeywords(["суші"]), false)!);
    expect(name.source).toContain("sushi");
    expect(name.test("KitsuneSushi")).toBe(true);
    // Короткие — целым словом и в названии: «рол» не в «Королівська».
    expect(keywordPattern(["рол", "піц*", "pizz*"], false)).toBe(
      "(?:\\mрол\\M|\\mпіц\\w*\\M|\\mpizz\\w*\\M)",
    );
    expect(keywordPattern(["шаверм*"], false)).toBe("(?:шаверм)");
  });

  it("спецсимволы экранируются; пусто — null", () => {
    expect(keywordPattern(["a.b|c"])).toBe("\\m(?:a\\.b\\|c)\\M");
    expect(keywordPattern([])).toBeNull();
    expect(keywordPattern(["*"])).toBeNull();
  });
});
