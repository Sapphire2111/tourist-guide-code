import { defineConfig } from "vitest/config";
import { reactConfig } from "@tg/config/vitest";

export default defineConfig(reactConfig({ test: { setupFiles: ["./src/test-setup.ts"] } }));
