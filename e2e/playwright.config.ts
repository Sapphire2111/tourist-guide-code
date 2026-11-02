// E2E + a11y для miniapp и admin (T1-05). Приложения собирает turbo (`^build`), здесь только
// `vite preview` на собственных портах: 3000 и 5173 на машине разработчика заняты — не использовать.
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const CI = process.env.CI === "true";
const MINIAPP_PORT = Number(process.env.E2E_MINIAPP_PORT ?? 4310);
const ADMIN_PORT = Number(process.env.E2E_ADMIN_PORT ?? 4311);

function preview(app: "miniapp" | "admin", port: number) {
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    server: {
      // Без pnpm в PATH: vite из node_modules приложения. strictPort — упасть, а не занять чужой порт.
      command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`,
      cwd: fileURLToPath(new URL(`../apps/${app}`, import.meta.url)),
      url,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  };
}

const miniapp = preview("miniapp", MINIAPP_PORT);
const admin = preview("admin", ADMIN_PORT);

export default defineConfig({
  testDir: "tests",
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    // Mini App открывается в Telegram на телефоне — мобильный профиль (движок chromium).
    { name: "miniapp", testDir: "tests/miniapp", use: { ...devices["Pixel 7"], baseURL: miniapp.url } },
    { name: "admin", testDir: "tests/admin", use: { ...devices["Desktop Chrome"], baseURL: admin.url } },
  ],
  webServer: [miniapp.server, admin.server],
});
