import { defineConfig } from "vitest/config";
import { nestConfig } from "@tg/config/vitest";

// Unit: тесты рядом с кодом в src + unit-тесты тестовых фабрик (test/factories, без БД).
export default defineConfig(
  nestConfig({ test: { include: ["src/**/*.test.ts", "test/factories/**/*.test.ts"] } }),
);
