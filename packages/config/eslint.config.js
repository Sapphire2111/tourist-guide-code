// Общий ESLint 9 flat config монорепо. Используется корневым eslint.config.js.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tg from "./module-boundaries.js";

export const ignores = {
  ignores: [
    "**/dist/**",
    "**/node_modules/**",
    "**/.turbo/**",
    "**/coverage/**",
    "**/test-results/**",
    "**/playwright-report/**",
    ".claude/**",
    "docs/**",
  ],
};

export const base = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];

/** React-приложения и пакеты. */
export const react = (files) => [
  {
    files,
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];

/** Node-код (NestJS-приложения, конфиги). */
export const node = (files, ignores = []) => [{ files, ignores, languageOptions: { globals: globals.node } }];

/** Границы контекстов модульного монолита: modules/<context>/ — только через index. */
export const moduleBoundaries = (files) => [
  { files, plugins: { tg }, rules: { "tg/module-boundaries": "error" } },
];

/** Запросы к БД вне слоя БД — только через Kysely с TenantGuardPlugin (ADR-005, T1-10). */
export const noRawSql = (files, ignores = []) =>
  files.length ? [{ files, ignores, plugins: { tg }, rules: { "tg/no-raw-sql": "error" } }] : [];

/** Фабрика полного конфига. */
export function createConfig({
  reactFiles = [],
  nodeFiles = [],
  nodeIgnores = [],
  boundaryFiles = [],
  rawSqlFiles = [],
  rawSqlIgnores = [],
} = {}) {
  return [
    ignores,
    ...base,
    ...react(reactFiles),
    ...node(nodeFiles, nodeIgnores),
    ...moduleBoundaries(boundaryFiles),
    ...noRawSql(rawSqlFiles, rawSqlIgnores),
    prettier, // последним: отключает стилистические правила, конфликтующие с Prettier
  ];
}
