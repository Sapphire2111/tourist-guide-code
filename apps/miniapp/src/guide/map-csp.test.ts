// Подписи векторной карты рисует WebAssembly Google: без 'wasm-unsafe-eval' в CSP сайта карта молча остаётся без подписей.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const yaml = readFileSync(resolve(__dirname, "../../../../render.yaml"), "utf8");
const service = yaml.slice(yaml.indexOf("name: tg-miniapp-staging"));
const csp = /name: Content-Security-Policy\s+value: "([^"]+)"/.exec(service)?.[1] ?? "";
const directive = (name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? "";

describe("CSP сайта Mini App и карта", () => {
  it("WebAssembly разрешён только узким 'wasm-unsafe-eval', без 'unsafe-eval'", () => {
    expect(directive("script-src")).toContain("'wasm-unsafe-eval'");
    expect(directive("script-src")).not.toMatch(/'unsafe-eval'/);
  });

  it("обложки в окне маркера: img-src разрешает https: и свой домен", () => {
    expect(directive("img-src")).toContain("https:");
    expect(directive("img-src")).toContain("'self'");
  });
});
