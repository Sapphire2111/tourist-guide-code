import {
  baseEnvShape,
  storageEnvRefine,
  adminAuthEnvShape,
  storageEnvShape,
  commaList,
  port,
  requireInEnvs,
  optionalString,
  optionalUrl,
  urlWith,
  z,
} from "@tg/server-config";

/** "" и пробелы — не задано. */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** Переменные окружения api. Описание и источники значений — .env.example. */
export const apiEnvSchema = z
  .object({
    ...baseEnvShape,
    ...storageEnvShape,
    ...adminAuthEnvShape,
    PORT: port(4300),
    // Браузер шлёт Origin без пути и слэша, в нижнем регистре; cors сравнивает строки точно — иначе молча блок.
    CORS_ORIGINS: commaList().refine((list) => list.every(isOrigin), {
      message: "каждый элемент — origin вида https://host[:port], без пути и завершающего /",
    }),
    PUBLIC_API_URL: optionalUrl("http", "https"),
    PUBLIC_MINIAPP_URL: optionalUrl("http", "https"),
    PUBLIC_ADMIN_URL: optionalUrl("http", "https"),
    // Обязателен во всех окружениях: без него api не стартует (пул ленивый — соединение при первом запросе).
    DATABASE_URL: urlWith("postgres", "postgresql"),
    REDIS_URL: optionalUrl("redis", "rediss"),
    // Запись аналитических событий (T1-25): queue — через очередь в worker, direct — сразу в БД из api.
    // Не задан — queue при REDIS_URL, иначе direct. Staging (Render free, без отдельного worker) — direct.
    ANALYTICS_SINK: z.enum(["queue", "direct"]).optional(),
    // Приём событий фронтенда POST /analytics/events: off — 404. Не задан — off в prod, on в local/staging
    // (эндпоинт без аутентификации и rate limit до T1-26/T1-24 — принятый риск только тестового режима).
    ANALYTICS_CLIENT_EVENTS: z.enum(["on", "off"]).optional(),
    // Ресайз фото (T1-20, ADR-0013): queue — задача в очередь media, ресайз делает worker; inline — api сам при
    // подтверждении загрузки (фоном, по одному). Не задан — queue только при APP_ENV=prod, STORAGE_DRIVER=s3 и
    // REDIS_URL, иначе inline. Staging (Render free, без отдельного worker) — inline.
    MEDIA_PROCESSING: z.enum(["queue", "inline"]).optional(),
    TELEGRAM_BOT_TOKEN: optionalString(),
    // Имя бота без @ (блок 3, ADR-0018): ссылка печати QR https://t.me/<бот>?startapp=<код>. Не задано — печать 409.
    TELEGRAM_BOT_USERNAME: z.preprocess(
      (v) => (typeof v === "string" ? blankToUndefined(v.trim().replace(/^@/, "")) : v),
      z
        .string()
        .regex(/^[A-Za-z0-9_]{5,32}$/, "имя бота — 5–32 символа: латиница, цифры, _")
        .optional(),
    ),
    // Вход через Telegram (блок 2, ADR-0015): максимальный возраст initData (auth_date), часов. Старше — 401.
    TELEGRAM_INIT_DATA_MAX_AGE_HOURS: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(168).default(24),
    ),
    // Сессии (T1-26, ADR-0009): срок жизни в часах; Mini App перевыпускает сессию по initData при запуске.
    AUTH_SESSION_TTL_HOURS: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(720).default(24),
    ),
    // Фоновые задачи воркера в процессе api (staging, Render free — без отдельного worker): true — bookings.process-due
    // раз в минуту под advisory lock (src/db/in-process-jobs.ts). Не задан — false (задачи выполняет apps/worker).
    WORKER_IN_PROCESS: z.preprocess(
      (v) =>
        typeof v === "string" ? (v.trim().toLowerCase() === "" ? undefined : v.trim().toLowerCase()) : v,
      z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    ),
    // Dev-вход POST /auth/dev/sessions без проверки личности — только APP_ENV=local (ниже: иначе api не стартует).
    AUTH_DEV_LOGIN: z.preprocess(
      (v) =>
        typeof v === "string" ? (v.trim().toLowerCase() === "" ? undefined : v.trim().toLowerCase()) : v,
      z
        .enum(["true", "false"])
        .default("false")
        .transform((v) => v === "true"),
    ),
    // Rate limit (T1-24, ADR-0012): on — счётчики в Redis при REDIS_URL, иначе в памяти; memory — всегда в памяти
    // процесса (staging: один инстанс, экономим команды Upstash); off — выключен (нагрузочный тест).
    RATE_LIMIT: z.preprocess(
      (v) => (typeof v === "string" ? blankToUndefined(v.trim().toLowerCase()) : v),
      z.enum(["on", "off", "memory"]).default("on"),
    ),
    // Сколько прокси перед api добавляют X-Forwarded-For (trust proxy Express). Не задан — 1 в staging/prod
    // (балансировщик Render), 0 в local. Неверное значение: больше — IP можно подделать, меньше — все клиенты
    // делят лимит одного адреса прокси.
    TRUST_PROXY_HOPS: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(5).optional()),
    // Фото Google в картке місця (прокси GET /places/{id}/google-photos/{n}): серверный ключ Places API (New);
    // не задан — фото Google не показываются. В браузер не отдаётся (в адресе файла его нет).
    GOOGLE_MAPS_API_KEY: optionalString(),
    // Предел запросов к Google Place Photos в сутки (страховка бюджета; адреса кэшируются). По умолчанию 300 (худший случай ≈ $65/мес).
    GOOGLE_PHOTO_DAILY_LIMIT: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).max(100_000).default(300),
    ),
    // И в месяц (общий счётчик с CLI places:enrich --covers): по умолчанию бесплатный объём Google — 1000.
    GOOGLE_PHOTO_MONTHLY_LIMIT: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).max(1_000_000).default(1000),
    ),
    // Ассистент на главной (POST /assistant/query): ключ Claude API для разбора запроса туриста. Не задан — ассистент
    // отвечает 503 errors.assistant.unavailable (не 500). Голос (POST /assistant/transcribe) — Google Speech-to-Text
    // по GOOGLE_MAPS_API_KEY (в проекте Google должен быть включён Speech-to-Text API).
    ANTHROPIC_API_KEY: optionalString(),
    // Суточный бюджет ассистента в единицах (запрос к Claude — 1, голос — 2) на всё api: счётчик в Redis rate limit
    // (без Redis — в памяти процесса). По умолчанию 500.
    ASSISTANT_DAILY_LIMIT: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).max(100_000).default(500),
    ),
    // И на пользователя в сутки (те же единицы). По умолчанию 40.
    ASSISTANT_USER_DAILY_LIMIT: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).max(10_000).default(40),
    ),
    // GET /metrics (T1-18): задан — только с Authorization: Bearer; в prod без него /metrics не подключается.
    METRICS_TOKEN: optionalString(),
  })
  .superRefine(
    requireInEnvs([
      "PUBLIC_API_URL",
      "CORS_ORIGINS",
      "REDIS_URL",
      "TELEGRAM_BOT_TOKEN",
      "ADMIN_LOGIN_HMAC_SECRET",
    ]),
  )
  .superRefine(storageEnvRefine)
  .superRefine((cfg, ctx) => {
    if (cfg.MEDIA_PROCESSING === "queue" && !cfg.REDIS_URL)
      ctx.addIssue({ code: "custom", path: ["MEDIA_PROCESSING"], message: "queue требует REDIS_URL" });
  })
  .superRefine((cfg, ctx) => {
    if (cfg.AUTH_DEV_LOGIN && cfg.APP_ENV !== "local")
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_DEV_LOGIN"],
        message: `dev-вход разрешён только при APP_ENV=local, сейчас ${cfg.APP_ENV}`,
      });
  });

export type ApiEnv = z.output<typeof apiEnvSchema>;

/** Включён ли приём событий фронтенда: явный ANALYTICS_CLIENT_EVENTS, иначе выключен только в prod. */
export function analyticsClientEventsEnabled(
  env: Partial<Pick<ApiEnv, "APP_ENV" | "ANALYTICS_CLIENT_EVENTS">>,
): boolean {
  return (env.ANALYTICS_CLIENT_EVENTS ?? (env.APP_ENV === "prod" ? "off" : "on")) === "on";
}

/**
 * Итоговый режим ресайза: явный MEDIA_PROCESSING, иначе queue только в prod при s3 и Redis (там есть отдельный worker);
 * local/staging — inline (worker может не быть запущен или не видеть файлы local).
 */
export function mediaProcessingMode(
  env: Partial<Pick<ApiEnv, "MEDIA_PROCESSING" | "STORAGE_DRIVER" | "REDIS_URL" | "APP_ENV">>,
): "queue" | "inline" {
  return (
    env.MEDIA_PROCESSING ??
    (env.APP_ENV === "prod" && env.STORAGE_DRIVER === "s3" && env.REDIS_URL ? "queue" : "inline")
  );
}

/** Число доверенных прокси: явный TRUST_PROXY_HOPS, иначе 1 вне local (Render), 0 в local. */
export function trustProxyHops(env: Partial<Pick<ApiEnv, "APP_ENV" | "TRUST_PROXY_HOPS">>): number {
  return env.TRUST_PROXY_HOPS ?? (env.APP_ENV === undefined || env.APP_ENV === "local" ? 0 : 1);
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}
