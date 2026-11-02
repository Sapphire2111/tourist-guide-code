import { createConfig } from "@tg/config/eslint";

export default createConfig({
  reactFiles: ["apps/miniapp/**/*.{ts,tsx}", "apps/admin/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
  nodeFiles: [
    "apps/{api,worker,bot}/**/*.ts",
    "**/*.{js,mjs,cjs}",
    "scripts/**",
    "apps/*/*.{js,ts}",
    "e2e/**/*.ts",
  ],
  nodeIgnores: ["apps/{miniapp,admin}/src/**", "packages/ui/src/**"],
  boundaryFiles: ["apps/api/src/**/*.ts"],
  // Сырой SQL и драйвер pg — только в слое БД api (src/db) и в тестах (tg/no-raw-sql, T1-10).
  rawSqlFiles: ["apps/{api,worker}/src/**/*.ts"],
  rawSqlIgnores: ["apps/api/src/db/**", "**/*.test.ts"],
});
