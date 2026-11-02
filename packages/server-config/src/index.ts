/**
 * Конфигурация backend-процессов (api, worker, bot) из переменных окружения.
 * Схема проверяется при старте; при ошибке процесс не запускается, а сообщение
 * называет только имена переменных и причину — значения (в т.ч. секреты) не выводятся.
 */
import { z } from "zod";

export { z };

export const APP_ENVS = ["local", "staging", "prod"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/** Пустая строка в env считается отсутствующим значением. */
/** Пустая строка и строка из пробелов считаются отсутствующим значением; строки обрезаются. */
const emptyToUndefined = (v: unknown) => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  return t === "" ? undefined : t;
};

/** Обязательная непустая строка (секреты, токены). */
export const requiredString = () => z.preprocess(emptyToUndefined, z.string().min(1));

/**
 * Необязательная строка. В zod 4 `.optional()` пропускает только undefined, поэтому
 * preprocess стоит снаружи: "" и пробелы → undefined → ок.
 */
export const optionalString = () => z.preprocess(emptyToUndefined, z.string().min(1).optional());

/** URL с одним из протоколов. */
const urlCheck = (protocols: string[]) =>
  z.string().refine(
    (v) => {
      try {
        return protocols.includes(new URL(v).protocol.replace(/:$/, ""));
      } catch {
        return false;
      }
    },
    `ожидается URL со схемой ${protocols.join(" | ")}`,
  );

/** Обязательный URL с одним из протоколов. */
export const urlWith = (...protocols: string[]) => z.preprocess(emptyToUndefined, urlCheck(protocols));

/** Необязательный URL ("" и пробелы = не задано). */
export const optionalUrl = (...protocols: string[]) =>
  z.preprocess(emptyToUndefined, urlCheck(protocols).optional());

/** Список через запятую: "a, b" → ["a", "b"]. */
export const commaList = () =>
  z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : (v ?? []),
    z.array(z.string()),
  );

/** Порт TCP. */
export const port = (fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(fallback));

/** Общие переменные всех backend-процессов. */
export const baseEnvShape = {
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["development", "production", "test"]).default("development"),
  ),
  APP_ENV: z.preprocess(emptyToUndefined, z.enum(APP_ENVS).default("local")),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  ),
  // Трекер ошибок (T1-18, ADR-0010): задан — события уходят в Sentry; не задан — только в лог.
  SENTRY_DSN: optionalUrl("http", "https"),
};

const isMissing = (v: string | undefined) => v === undefined || v.trim() === "";

export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(
    readonly service: string,
    readonly issues: readonly string[],
  ) {
    super(
      `[${service}] некорректная конфигурация окружения:\n` +
        issues.map((i) => `  - ${i}`).join("\n") +
        "\nСм. .env.example и раздел «Окружения и конфигурация» в README.",
    );
  }
}

/**
 * Проверяет env по схеме. Бросает ConfigError без значений переменных:
 * в сообщение попадают только путь (имя переменной) и текст причины.
 */
export function parseEnv<S extends z.ZodType>(
  service: string,
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(env, { reportInput: false });
  // В production-сборке окружение должно быть указано явно, а не молча считаться local.
  const appEnvMissing = env.NODE_ENV?.trim() === "production" && isMissing(env.APP_ENV);
  if (result.success && !appEnvMissing) return result.data;
  const issues = (result.success ? [] : result.error.issues).map((issue) => {
    const name = issue.path.join(".") || "(env)";
    const reason =
      issue.code === "invalid_type" && isMissing(env[name])
        ? "обязательная переменная не задана"
        : issue.code === "invalid_value"
          ? `допустимые значения: ${issue.values.map(String).join(", ")}`
          : issue.message;
    return `${name}: ${reason}`;
  });
  if (appEnvMissing && !issues.some((i) => i.startsWith("APP_ENV:"))) {
    issues.unshift("APP_ENV: обязательна при NODE_ENV=production (local | staging | prod)");
  }
  throw new ConfigError(service, issues);
}

/**
 * Для main.ts: парсит env, при ошибке печатает сообщение в stderr и завершает процесс с кодом 1.
 */
export function loadEnvOrExit<S extends z.ZodType>(
  service: string,
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.output<S> {
  try {
    return parseEnv(service, schema, env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Делает перечисленные переменные обязательными для заданных APP_ENV (по умолчанию staging и prod).
 * В local они могут отсутствовать, пока соответствующая функциональность не подключена.
 */
export function requireInEnvs<T extends { APP_ENV: AppEnv }>(
  keys: readonly (keyof T & string)[],
  envs: readonly AppEnv[] = ["staging", "prod"],
) {
  return (cfg: T, ctx: z.RefinementCtx) => {
    if (!envs.includes(cfg.APP_ENV)) return;
    for (const key of keys) {
      const v = cfg[key];
      if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
        ctx.addIssue({ code: "custom", path: [key], message: `обязательна при APP_ENV=${cfg.APP_ENV}` });
      }
    }
  };
}

/** S3-совместимое хранилище (S3Mock в local, R2/B2 и т. п. на сервере); нужно при STORAGE_DRIVER=s3. */
export const s3EnvShape = {
  S3_ENDPOINT: optionalUrl("http", "https"),
  S3_REGION: optionalString(),
  S3_BUCKET: optionalString(),
  S3_ACCESS_KEY_ID: optionalString(),
  S3_SECRET_ACCESS_KEY: optionalString(),
};

export const STORAGE_DRIVERS = ["s3", "local"] as const;

/**
 * Файловое хранилище (T1-20, ADR-0013): драйвер s3 (S3_*) или local (файлы + HMAC-ссылки через api).
 * STORAGE_SIGNING_SECRET — секрет подписи ссылок local (≥ 32 символа; не задан — случайный на время процесса).
 * STORAGE_PUBLIC_BASE_URL — публичный адрес префикса public/ (CDN/домен бакета); не задан — подписанные ссылки.
 */
export const storageEnvShape = {
  ...s3EnvShape,
  STORAGE_DRIVER: z.preprocess(emptyToUndefined, z.enum(STORAGE_DRIVERS).default("local")),
  STORAGE_LOCAL_DIR: optionalString(),
  STORAGE_SIGNING_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(32, "не короче 32 символов").optional(),
  ),
  STORAGE_PUBLIC_BASE_URL: optionalUrl("http", "https"),
};

type StorageCfg = { APP_ENV: AppEnv } & {
  [K in keyof typeof storageEnvShape]?: unknown;
};

/**
 * Согласованность переменных хранилища: s3 — нужны бакет и ключи; local в prod запрещён (файлы на диске
 * одного инстанса, без резервных копий).
 */
export function storageEnvRefine(cfg: StorageCfg, ctx: z.RefinementCtx): void {
  if (cfg.STORAGE_DRIVER === "s3") {
    for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (cfg[key] === undefined)
        ctx.addIssue({ code: "custom", path: [key], message: "обязательна при STORAGE_DRIVER=s3" });
    }
  } else if (cfg.APP_ENV === "prod") {
    ctx.addIssue({
      code: "custom",
      path: ["STORAGE_DRIVER"],
      message: "local запрещён при APP_ENV=prod — нужен s3",
    });
  }
}

// Наблюдаемость (T1-18): JSON-логи без ПДн, трекер ошибок, метрики. ADR-0010.
export * from "./observability/index.js";
