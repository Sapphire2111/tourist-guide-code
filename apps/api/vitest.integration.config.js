// Интеграционные тесты: реальные PostgreSQL/PostGIS и Redis через Testcontainers (нужен Docker).
// Не входят в `pnpm check`; запуск — `pnpm test:integration`.
import { defineConfig } from "vitest/config";
import { nestConfig } from "@tg/config/vitest";

export default defineConfig(
  nestConfig({
    test: {
      include: ["test/integration/**/*.test.ts"],
      globalSetup: ["test/integration/global-setup.ts"],
      testTimeout: 60_000,
      hookTimeout: 300_000, // первый запуск скачивает образы
      fileParallelism: false,
    },
  }),
);
