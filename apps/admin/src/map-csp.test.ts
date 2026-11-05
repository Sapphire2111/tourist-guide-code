// CSP сайта админки и карта выбора места: без источников Google Maps скрипт API и тайлы блокируются браузером.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const yaml = readFileSync(resolve(__dirname, "../../../render.yaml"), "utf8");
const service = yaml.slice(yaml.indexOf("name: tg-admin-staging"));
const csp = /name: Content-Security-Policy\s+value: "([^"]+)"/.exec(service)?.[1] ?? "";
const directive = (name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `)) ?? "";

describe("CSP сайта админки и Google Maps", () => {
  it("скрипт и запросы API карт разрешены; WebAssembly — только 'wasm-unsafe-eval'", () => {
    expect(directive("script-src")).toContain("https://*.googleapis.com");
    expect(directive("script-src")).toContain("'wasm-unsafe-eval'");
    expect(directive("script-src")).not.toMatch(/'unsafe-eval'/);
    expect(directive("connect-src")).toContain("https://*.googleapis.com");
    expect(directive("font-src")).toContain("https://fonts.gstatic.com");
  });

  it("админка по-прежнему не встраивается во фрейм; ключ карты — переменная сборки", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    const env = service.slice(service.indexOf("envVars:"));
    expect(env).toContain("key: VITE_GOOGLE_MAPS_BROWSER_KEY");
    expect(env).toContain("key: VITE_GOOGLE_MAPS_MAP_ID");
  });
});
