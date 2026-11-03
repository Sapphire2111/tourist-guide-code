// E2E + a11y для miniapp и admin (T1-05). Admin собирает turbo (`^build`), здесь только `vite preview`;
// miniapp пересобирается здесь же — без ключа Google Maps (см. ниже). Порты свои: 3000 и 5173 заняты.
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const CI = process.env.CI === "true";
const MINIAPP_PORT = Number(process.env.E2E_MINIAPP_PORT ?? 4310);
const ADMIN_PORT = Number(process.env.E2E_ADMIN_PORT ?? 4311);

const VITE = "node node_modules/vite/bin/vite.js";
/** Сборка miniapp для E2E — вне dist (его публикует Render и меряет check:bundle). */
const MINIAPP_E2E_DIST = "node_modules/.e2e-dist";

function preview(app: "miniapp" | "admin", port: number) {
  const url = `http://127.0.0.1:${port}`;
  // Без pnpm в PATH: vite из node_modules приложения. strictPort — упасть, а не занять чужой порт.
  const serve = `${VITE} preview --host 127.0.0.1 --port ${port} --strictPort`;
  return {
    url,
    server: {
      // Miniapp — своя сборка без ключа Google Maps, что бы ни лежало в apps/miniapp/.env.local: карту даёт фейк API
      // (support/google-maps-fake.ts), а тест «сборка без ключа» видит заглушку. Переменные окружения у Vite важнее
      // .env-файлов; пробел (а не пустая строка — в Windows она удаляет переменную) map-config.ts обрезает до "".
      command:
        app === "miniapp"
          ? `${VITE} build --outDir ${MINIAPP_E2E_DIST} --emptyOutDir --logLevel warn && ${serve} --outDir ${MINIAPP_E2E_DIST}`
          : serve,
      cwd: fileURLToPath(new URL(`../apps/${app}`, import.meta.url)),
      env: (app === "miniapp"
        ? { VITE_GOOGLE_MAPS_BROWSER_KEY: " ", VITE_GOOGLE_MAPS_MAP_ID: " " }
        : {}) as Record<string, string>,
      url,
      reuseExistingServer: false,
      timeout: app === "miniapp" ? 180_000 : 60_000,
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
