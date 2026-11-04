// Кнопка меню чата и команды бота вручную: `pnpm --filter @tg/bot menu:set` (после build). При старте не вызывается.
import { loadEnvOrExit } from "@tg/server-config";
import { botEnvSchema } from "./config.js";
import { BotApiClient } from "./telegram/bot-api.js";
import { menuRequests } from "./telegram/menu.js";

const env = loadEnvOrExit("bot", botEnvSchema);
if (!env.TELEGRAM_BOT_TOKEN || !env.PUBLIC_MINIAPP_URL) {
  console.error("Нужны TELEGRAM_BOT_TOKEN и PUBLIC_MINIAPP_URL (см. .env.example)");
  process.exit(1);
}
const client = new BotApiClient({ token: env.TELEGRAM_BOT_TOKEN });
for (const { method, body } of menuRequests(env.PUBLIC_MINIAPP_URL)) {
  await client.call(method, body);
  console.log(`${method}: ok`);
}
