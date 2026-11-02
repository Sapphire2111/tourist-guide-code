// Регистрация webhook Telegram вручную: `pnpm --filter @tg/bot webhook:set` (после build). При старте не вызывается.
import { loadEnvOrExit } from "@tg/server-config";
import { botEnvSchema } from "./config.js";
import { BotApiClient } from "./telegram/bot-api.js";
import { WEBHOOK_PATH } from "./webhook.controller.js";

/** Апдейты, которые бот обрабатывает; остальные Telegram не присылает. */
const ALLOWED_UPDATES = ["message"];

const env = loadEnvOrExit("bot", botEnvSchema);
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.BOT_PUBLIC_URL) {
  console.error("Нужны TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET и BOT_PUBLIC_URL (см. .env.example)");
  process.exit(1);
}
const url = new URL(WEBHOOK_PATH, env.BOT_PUBLIC_URL).toString();
await new BotApiClient({ token: env.TELEGRAM_BOT_TOKEN }).setWebhook({
  url,
  secret_token: env.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ALLOWED_UPDATES,
});
console.log(`webhook зарегистрирован: ${url}`);
