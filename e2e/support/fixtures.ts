// Фикстура Playwright: страница Mini App уже «внутри Telegram».
// Свой пользователь: test.use({ telegram: { user: {...} } }); вне Telegram: test.use({ telegram: null }).
import { test as base } from "@playwright/test";
import { installApiMock } from "./api-mock.js";
import { installTelegramWebApp, type TelegramWebAppOptions } from "./telegram-webapp.js";

export const test = base.extend<{ telegram: TelegramWebAppOptions | null }>({
  telegram: [{}, { option: true }],
  page: async ({ page, telegram }, use) => {
    // Настоящий telegram-web-app.js не грузим (CI без сети, и он перезаписал бы мок).
    await page.route("**/telegram.org/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
    );
    // api в E2E не поднят — эффективные фича-флаги (T1-22) отдаём сами: модули, которые проверяют тесты, включены.
    await page.route("**/feature-flags*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { key: "module.partner_cabinet", enabled: true },
            { key: "module.host_requests", enabled: true },
          ],
        }),
      }),
    );
    // Плитки OSM и фото мест — без сети: прозрачный PNG 1×1.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.route(/tile.openstreetmap.org|cdn.example/, (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: png }),
    );
    // Вход, профиль и контекст QR — мок api (support/api-mock.ts) с состоянием на тест.
    await installApiMock(page);
    if (telegram) await installTelegramWebApp(page, telegram);
    await use(page);
  },
});

export { expect } from "@playwright/test";
