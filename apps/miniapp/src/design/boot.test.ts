// Загрузочные атрибуты и согласованность значений в трёх местах (index.html, season-boot.js, theme.ts / CSS).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DAY_HEADER_COLOR, NIGHT_WINDOW_COLORS } from "./theme.js";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("загрузочные атрибуты", () => {
  it("data-design=modern стоит в самой разметке: правила не зависят от season-boot.js", () => {
    expect(read("index.html")).toMatch(/<html[^>]*\sdata-design="modern"/);
  });

  it("цвета окна Telegram в «Ніч» одинаковы в theme.ts, season-boot.js и --top-bg", () => {
    const boot = read("public", "season-boot.js");
    const m = /theme === "night"\) colors = \["(#[0-9A-Fa-f]{6})", "(#[0-9A-Fa-f]{6})"\]/.exec(boot);
    expect(m).not.toBeNull();
    expect(m![1]!.toLowerCase()).toBe(NIGHT_WINDOW_COLORS.bg.toLowerCase());
    expect(m![2]!.toLowerCase()).toBe(NIGHT_WINDOW_COLORS.surface.toLowerCase());
    const night = read("src", "design", "modern.css").split('html[data-theme="night"] {')[1] ?? "";
    expect(/--top-bg:\s*(#[0-9a-f]{6})/i.exec(night)![1]!.toLowerCase()).toBe(
      NIGHT_WINDOW_COLORS.surface.toLowerCase(),
    );
  });

  it("шапка окна Telegram в «День» — верх неба: одна в theme.ts, season-boot.js и --bar-sky", () => {
    const boot = read("public", "season-boot.js");
    expect(/else colors\[1\] = "(#[0-9A-Fa-f]{6})"/.exec(boot)![1]).toBe(DAY_HEADER_COLOR);
    const css = read("src", "design", "modern.css");
    expect(/--bar-sky:\s*(#[0-9a-f]{6})/i.exec(css)![1]!.toLowerCase()).toBe(DAY_HEADER_COLOR.toLowerCase());
    expect(/\.app-backdrop \{[\s\S]*?180deg,\s*(#[0-9a-f]{6}) 0/i.exec(css)![1]!.toLowerCase()).toBe(
      DAY_HEADER_COLOR.toLowerCase(),
    );
  });
});

describe("стили, которые нельзя ломать", () => {
  const css = read("src", "design", "kosiv.css");
  const color = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    const block = start < 0 ? "" : css.slice(start, css.indexOf("}", start));
    return /(?:^|[\s;])color:\s*(#[0-9a-f]{6})/i.exec(block)?.[1] ?? "";
  };

  it("действия окна маркера: «Маршрут» белым на заливке, «Відкрити картку» на белом — контраст >= 4,5:1", () => {
    const route = ".kosiv-map-popup .kosiv-map-popup-actions a.kosiv-map-popup-route";
    expect(contrast(color(route), "#b83d18")).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/a\.kosiv-map-popup-route \{[^}]*background-color: #b83d18/);
    const open = ".kosiv-map-popup .kosiv-map-popup-actions a.kosiv-map-popup-open";
    expect(contrast(color(open), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("кольцо фокуса в окне маркера: цвет не от темы, контраст >= 3:1 на белом; × и подпись — белое внутри узла", () => {
    const ring =
      /html\[data-season\] \.kosiv-map-popup :focus-visible \{\s*outline: 2\.5px solid (#[0-9a-f]{6})/.exec(
        css,
      );
    expect(contrast(ring![1]!, "#ffffff")).toBeGreaterThanOrEqual(3);
    for (const sel of [".kosiv-map-popup-credit a", ".kosiv-map-popup-close"]) {
      const block = css.slice(css.indexOf(`${sel}:focus-visible`));
      expect(block.slice(0, block.indexOf("}"))).toMatch(/outline-color: #ffffff;\s*outline-offset: -/);
    }
  });

  it("подпись маркера: все цвета заданы явно, контраст на белом InfoWindow >= 4,5:1", () => {
    for (const sel of [
      ".kosiv-map-popup",
      ".kosiv-map-popup strong",
      ".kosiv-map-popup span",
      ".kosiv-map-popup a",
    ]) {
      const c = color(sel);
      expect(c, sel).not.toBe("");
      expect(contrast(c, "#ffffff"), sel).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("«#1» в списке «Поруч»: белый текст на обоих концах градиента >= 4,5:1", () => {
    const modern = read("src", "design", "modern.css");
    const ends = [
      ...modern.matchAll(
        /first-child \.kosiv-place-media \{[^}]*?linear-gradient\(135deg, (#[0-9a-f]{6}), (#[0-9a-f]{6})\)/gi,
      ),
    ].flatMap((m) => [m[1]!, m[2]!]);
    expect(ends).toHaveLength(4);
    for (const c of ends) expect(contrast(c, "#ffffff"), c).toBeGreaterThanOrEqual(4.5);
  });
});
