import { baseEnvShape, requireInEnvs, optionalString, optionalUrl, z } from "@tg/server-config";

/** Необязательный порт TCP ("" = не задан). */
const optionalPort = () =>
  optionalString()
    .transform((v) => (v === undefined ? undefined : Number(v)))
    .refine(
      (v) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= 65535),
      "ожидается порт 1–65535",
    );

/** В staging/prod адреса для Telegram (web_app, webhook) должны быть https. */
const HTTPS_IN_DEPLOY = ["PUBLIC_MINIAPP_URL", "BOT_PUBLIC_URL"] as const;

/** Переменные окружения bot. Описание и источники значений — .env.example. */
export const botEnvSchema = z
  .object({
    ...baseEnvShape,
    // HTTP-порт приёма webhook: BOT_PORT, иначе PORT (Render), иначе 4306.
    BOT_PORT: optionalPort(),
    PORT: optionalPort(),
    TELEGRAM_BOT_TOKEN: optionalString(),
    TELEGRAM_WEBHOOK_SECRET: optionalString(),
    PUBLIC_API_URL: optionalUrl("http", "https"),
    PUBLIC_MINIAPP_URL: optionalUrl("https", "http"),
    // Прямая ссылка Mini App https://t.me/<bot>/<app>: кнопка с подписанным start_param.
    TELEGRAM_MINIAPP_LINK: optionalUrl("https"),
    // Публичный адрес бота, на него регистрируется webhook: <BOT_PUBLIC_URL>/telegram/webhook.
    BOT_PUBLIC_URL: optionalUrl("https", "http"),
    // Очередь исходящих сообщений. В local без Redis — очередь в памяти процесса.
    REDIS_URL: optionalUrl("redis", "rediss"),
  })
  .superRefine(
    requireInEnvs([
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
      "PUBLIC_API_URL",
      "PUBLIC_MINIAPP_URL",
      "REDIS_URL",
    ]),
  )
  .superRefine((cfg, ctx) => {
    if (cfg.APP_ENV === "local") return;
    for (const key of HTTPS_IN_DEPLOY) {
      const v = cfg[key];
      if (v !== undefined && !v.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: [key], message: `при APP_ENV=${cfg.APP_ENV} нужен https` });
      }
    }
  });

export type BotEnv = z.output<typeof botEnvSchema>;

export const DEFAULT_BOT_PORT = 4306;

/** Порт HTTP-сервера бота. */
export function listenPort(env: BotEnv): number {
  return env.BOT_PORT ?? env.PORT ?? DEFAULT_BOT_PORT;
}
