import {
  baseEnvShape,
  optionalUrl,
  requireInEnvs,
  storageEnvRefine,
  storageEnvShape,
  urlWith,
  z,
} from "@tg/server-config";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** Переменные окружения worker. Описание и источники значений — .env.example. */
export const workerEnvSchema = z
  .object({
    ...baseEnvShape,
    // Хранилище (T1-20): ресайз фото читает оригинал и пишет варианты; local — только при общем с api каталоге.
    ...storageEnvShape,
    DATABASE_URL: optionalUrl("postgres", "postgresql"),
    // Очередь BullMQ живёт в Redis: без него worker бесполезен, поэтому обязателен во всех окружениях.
    REDIS_URL: urlWith("redis", "rediss"),
    // Срок хранения заявок гостиницы, дней (D-49, ADR-0020): после него комната, комментарий и автор обезличиваются.
    SERVICE_REQUEST_RETENTION_DAYS: z.preprocess(blank, z.coerce.number().int().min(1).max(3650).default(90)),
    // Снимок длины очередей в метрики и лог (T1-18), мс; 0 — выключено. По умолчанию 10 мин:
    // каждый снимок — несколько команд Redis, а у Upstash free лимит команд.
    QUEUE_METRICS_INTERVAL_MS: z.preprocess(
      blank,
      z.coerce
        .number()
        .int()
        .min(0)
        .max(2_147_483_647) // предел setInterval
        .refine((v) => v === 0 || v >= 10_000, "0 (выкл.) или не меньше 10000 мс")
        .default(600_000),
    ),
  })
  .superRefine(requireInEnvs(["DATABASE_URL"]))
  .superRefine(storageEnvRefine);

export type WorkerEnv = z.output<typeof workerEnvSchema>;
