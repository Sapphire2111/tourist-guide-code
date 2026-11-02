// Общая база Vitest для пакетов и приложений монорепо (T1-05).
// Пакет/приложение подключает её в своём vitest.config.js:
//   import { defineConfig } from "vitest/config";
//   import { nodeConfig } from "@tg/config/vitest";
//   export default defineConfig(nodeConfig());
// Глобалей нет: тесты явно импортируют describe/it/expect из "vitest".
import swc from "unplugin-swc";

/** Общие настройки: юнит-тесты лежат рядом с кодом в src, coverage — v8, без порогов. */
const base = {
  include: ["src/**/*.test.{ts,tsx}"],
  globals: false,
  restoreMocks: true,
  coverage: {
    provider: "v8",
    include: ["src/**/*.{ts,tsx}"],
    exclude: ["src/**/*.test.{ts,tsx}", "src/main.{ts,tsx}"],
    reporter: ["text", "html", "lcov"],
    reportsDirectory: "coverage",
  },
};

function merge(test, extra = {}) {
  const { test: extraTest = {}, ...rest } = extra;
  return { ...rest, test: { ...base, ...test, ...extraTest } };
}

/** Изоморфные пакеты (shared, i18n, api-client): среда node. */
export function nodeConfig(extra) {
  return merge({ environment: "node" }, extra);
}

/** React-пакеты и приложения: jsdom + @testing-library/react. */
export function reactConfig(extra) {
  // testTimeout 20 с: холодный старт jsdom на слабой машине/под нагрузкой не укладывается в 5 с по умолчанию.
  return merge({ environment: "jsdom", testTimeout: 20000 }, extra);
}

/**
 * NestJS-приложения. esbuild (транспилятор Vitest по умолчанию) не эмитит decorator metadata,
 * без неё DI Nest не знает типов параметров конструктора. Поэтому TS транспилирует SWC
 * (unplugin-swc) с legacy-декораторами и decoratorMetadata — как tsc с emitDecoratorMetadata.
 */
export function nestConfig(extra) {
  const { plugins = [], test = {}, ...rest } = extra ?? {};
  const setupFiles = ["reflect-metadata", ...[test.setupFiles ?? []].flat()];
  return merge(
    { environment: "node" },
    {
      ...rest,
      test: { ...test, setupFiles },
      plugins: [
        swc.vite({
          module: { type: "es6" },
          jsc: {
            target: "es2022",
            parser: { syntax: "typescript", decorators: true },
            transform: { legacyDecorator: true, decoratorMetadata: true },
          },
        }),
        ...plugins,
      ],
    },
  );
}
