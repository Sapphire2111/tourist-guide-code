// Классы kosiv-* и стили: каждый класс из разметки определён в kosiv.css, и в CSS нет классов, которых нет в разметке
// (защита от случайного удаления живых стилей и от мёртвых правил).
// Ограничение: класс считается определённым, если встречается в любом селекторе (в т. ч. вложенном/составном),
// а «используемым» — при любом упоминании строки kosiv-* в исходниках; динамически собранные имена не ловятся.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");
const ROOT = path.resolve(SRC, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|html)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
}

const markup = [...files(SRC), path.join(ROOT, "index.html")].map((f) => readFileSync(f, "utf8")).join("\n");
// Стили заставки — в <style> index.html (до загрузки бандла), остальное — kosiv.css.
const css = [
  readFileSync(path.join(SRC, "design", "kosiv.css"), "utf8"),
  readFileSync(path.join(ROOT, "index.html"), "utf8"),
]
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

// Разметка без <style> index.html — иначе правило само себя «использует».
const used = new Set(markup.replace(/<style[\s\S]*?<\/style>/g, "").match(/kosiv-[a-z0-9-]+/g) ?? []);
const defined = new Set([...[...css.matchAll(/\.(kosiv-[a-z0-9-]+)/g)].map((m) => m[1]!)]);

describe("kosiv.css ↔ разметка", () => {
  it("каждый класс из разметки определён в CSS", () => {
    // Классы-маркеры без собственных стилей (только для тестов/скриптов) — сюда, с причиной.
    const markerOnly = new Set<string>([]);
    const missing = [...used].filter((c) => !defined.has(c) && !markerOnly.has(c));
    expect(missing).toEqual([]);
  });

  it("в CSS нет классов, которых нет в разметке", () => {
    // Заготовки дизайн-системы из main, пока без разметки.
    const reserved = new Set(["kosiv-heading", "kosiv-pill"]);
    const dead = [...defined].filter((c) => !used.has(c) && !reserved.has(c));
    expect(dead).toEqual([]);
  });
});
