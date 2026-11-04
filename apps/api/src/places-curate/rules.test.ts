import { describe, expect, it } from "vitest";
import {
  bookingBaseName,
  classifyFix,
  CurateInputError,
  localityFromAddress,
  normalizeName,
  parseCsv,
  parseDecisions,
  parseFindings,
} from "./rules.js";

const ID = "01a19d02-d6a8-7510-84f5-62ca6c6f5c87";
const ID2 = "01a19d02-df6d-7234-a558-72a606de41b7";

describe("parseCsv", () => {
  it("BOM, «;», кавычки с удвоением, перевод строки в кавычках, CRLF, пустые строки", () => {
    const text = '\uFEFFa;b;c\r\n1;"x;y";"say ""hi"""\r\n\r\n2;"multi\nline";\r\n';
    expect(parseCsv(text)).toEqual([
      { a: "1", b: "x;y", c: 'say "hi"' },
      { a: "2", b: "multi\nline", c: "" },
    ]);
  });

  it("последняя строка без перевода строки; пустой файл", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([{ a: "1", b: "2" }]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("parseFindings", () => {
  const head = "раздел;место;id;пункт;тип_google;проблема;исправление;уверенность";
  it("колонки разметки и номер строки файла", () => {
    const [f] = parseFindings(
      `\uFEFF${head}\nnature;Гора;${ID.toUpperCase()};tatariv;;Вершина;→ peaks;Высокая\n`,
    );
    expect(f).toEqual({
      line: 2,
      section: "nature",
      name: "Гора",
      id: ID,
      locality: "tatariv",
      problem: "Вершина",
      fix: "→ peaks",
      confidence: "высокая",
    });
  });

  it("нет колонки или id не uuid — ошибка", () => {
    expect(() => parseFindings("раздел;место\nx;y\n")).toThrow(CurateInputError);
    expect(() => parseFindings(`${head}\nnature;Гора;123;;;;архив;высокая\n`)).toThrow(/не uuid/);
  });
});

describe("parseDecisions", () => {
  it("все действия", () => {
    const text = [
      "id;action;value;note",
      `${ID};move;markets+souvenirs;ринок`,
      `${ID};archive;;метка`,
      `${ID};merge;${ID2};дубль`,
      `${ID};rename;Гора Синяк;`,
      `${ID};describe;Опис;`,
      `${ID};locality;tatariv;`,
      `${ID};skip;;проверить`,
    ].join("\n");
    expect(parseDecisions(text).map((d) => d.kind)).toEqual([
      "move",
      "archive",
      "merge",
      "rename",
      "describe",
      "locality",
      "skip",
    ]);
    expect(parseDecisions(text)[0]).toEqual({
      kind: "move",
      id: ID,
      category: "markets",
      extras: ["souvenirs"],
      note: "ринок",
    });
  });

  it("ошибки: неизвестное действие, merge сам в себя, rename без текста", () => {
    expect(() => parseDecisions(`id;action;value;note\n${ID};drop;;`)).toThrow(/неизвестное/);
    expect(() => parseDecisions(`id;action;value;note\n${ID};merge;${ID};`)).toThrow(/сам в себя/);
    expect(() => parseDecisions(`id;action;value;note\n${ID};rename;;`)).toThrow(/без текста/);
  });
});

describe("classifyFix", () => {
  const f = (fix: string, confidence = "высокая", name = "Місце") => classifyFix({ fix, confidence, name });

  it("низкая уверенность — не применяется", () => {
    expect(f("архив", "низкая")).toEqual({ kind: "todo", reason: "уверенность «низкая»" });
  });

  it("архив — первый вариант", () => {
    for (const fix of [
      "архив",
      "архив (вне региона)",
      "архив (или дать название, если объект реальный)",
      "архив/переименовать: x",
    ])
      expect(f(fix, "средняя").kind).toBe("archive");
  });

  it("переименовать/уточнить или архив — архив только при высокой", () => {
    expect(f("переименовать или архив").kind).toBe("archive");
    expect(f("уточнить/архив").kind).toBe("archive");
    expect(f("переименовать/архив", "средняя").kind).toBe("todo");
    expect(f("уточнить или архив", "средняя").kind).toBe("todo");
  });

  it("переносы категории", () => {
    expect(f("→ peaks")).toEqual({ kind: "move", category: "peaks", extras: [] });
    expect(f("→ taxi (excursions — доп. категория)")).toEqual({
      kind: "move",
      category: "taxi",
      extras: ["excursions"],
    });
    expect(f("→ ski-lifts (+entertainment)")).toEqual({
      kind: "move",
      category: "ski-lifts",
      extras: ["entertainment"],
    });
    expect(f("→ gear-rental / active")).toEqual({
      kind: "move",
      category: "gear-rental",
      extras: ["active"],
    });
  });

  it("«(+gear-rental для прокатов)» — доп. категория только у проката", () => {
    const fix = "→ active (+gear-rental для прокатов)";
    expect(f(fix, "высокая", "Прокат Квадроциклів")).toEqual({
      kind: "move",
      category: "active",
      extras: ["gear-rental"],
    });
    expect(f(fix, "высокая", "Джип Тури")).toEqual({ kind: "move", category: "active", extras: [] });
  });

  it("Booking и неоднозначные", () => {
    expect(f("слить в одно место на объект, суффикс убрать").kind).toBe("booking");
    for (const fix of [
      "→ kids или архив",
      "проверить",
      "слить",
      "→ nature (хребет/гора → peaks)",
      "уточнить",
      "→ peaks, слить",
    ])
      expect(f(fix, "средняя").kind).toBe("todo");
  });
});

describe("bookingBaseName", () => {
  it("убирает суффикс типа номера после последнего « - »", () => {
    expect(bookingBaseName('Садиба "Градний Узвіз" - Superior Double Room')).toBe('Садиба "Градний Узвіз"');
    expect(bookingBaseName("Котедж Аквамарин - Two-Bedroom House")).toBe("Котедж Аквамарин");
    expect(bookingBaseName("Котедж Краєвид - Vacation Home")).toBe("Котедж Краєвид");
    expect(bookingBaseName("Садиба На Перевалі - Chalet")).toBe("Садиба На Перевалі");
    expect(bookingBaseName("A - B - Double or Twin Room with Balcony")).toBe("A - B");
  });

  it("без суффикса номера — null", () => {
    expect(bookingBaseName("ОСНОВА реабілітація - центр реабілітації та оздоровлення в Буковелі")).toBeNull();
    expect(bookingBaseName("Rope Jumping - Роуп Джампінг")).toBeNull();
    expect(bookingBaseName("Two-Bedroom House")).toBeNull();
  });
});

describe("normalizeName", () => {
  it("регистр, кавычки, апострофы, пунктуация", () => {
    expect(normalizeName("Садиба  «Дем‘янів Двір»")).toBe(normalizeName('садиба "Дем’янів двір"'));
    expect(normalizeName('Котедж "Казка"')).toBe("котедж казка");
  });
});

describe("localityFromAddress", () => {
  it("последний сегмент адреса — пункт региона", () => {
    expect(localityFromAddress("вулиця Грушевського, 194, Микуличин")).toBe("mykulychyn");
    expect(localityFromAddress("Grushevskogo Street 190B, Mykulychyn, 78590")).toBe("mykulychyn");
    expect(localityFromAddress("9GC4+J2, Поляниця")).toBe("polianytsia");
    expect(localityFromAddress("Витяг, 7, Буковель")).toBe("polianytsia");
    expect(localityFromAddress("вул. Косило, 6, Татарів")).toBe("tatariv");
    expect(localityFromAddress("8G9X+53, Яблуниця")).toBe("yablunytsia");
  });

  it("Яремче (громада), чужой текст, пусто — null", () => {
    expect(localityFromAddress("вулиця Карпатська, Яремче")).toBeNull();
    expect(
      localityFromAddress("8C6V+W7, Яблоница, Ивано-Франковская область, Украина, 78592 Яремче"),
    ).toBeNull();
    expect(localityFromAddress("Zarechye، ايفانو-فرانكيفسكا،")).toBeNull();
    expect(localityFromAddress(null)).toBeNull();
    expect(localityFromAddress("")).toBeNull();
  });
});
