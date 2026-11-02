import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageDriver } from "./local.js";
import { S3StorageDriver } from "./s3.js";
import type { StorageDriver } from "./types.js";

/** Переменные хранилища после проверки схемой (@tg/server-config storageEnvShape + проверка в config.ts). */
export interface StorageEnv {
  STORAGE_DRIVER: "s3" | "local";
  STORAGE_LOCAL_DIR?: string;
  STORAGE_SIGNING_SECRET?: string;
  STORAGE_PUBLIC_BASE_URL?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
}

/**
 * Каталог local-драйвера по умолчанию: во временном каталоге ОС — общий для api и worker на одной машине
 * (`pnpm dev`), не зависит от рабочего каталога процесса. Временный: может очищаться ОС/платформой.
 */
export const DEFAULT_LOCAL_STORAGE_DIR = join(tmpdir(), "tourist-guide-storage");

export interface Storage {
  driver: StorageDriver;
  /** Публичный адрес префикса public/ (CDN/домен бакета), без «/» в конце; нет — варианты по подписанным ссылкам. */
  publicBaseUrl: string | undefined;
  /** Секрет подписи local сгенерирован на время процесса (не задан STORAGE_SIGNING_SECRET в local). */
  ephemeralSecret: boolean;
}

/**
 * Хранилище из env. `apiBaseUrl` — внешний адрес api для ссылок local-драйвера (worker ссылок не выдаёт —
 * любое значение). Обязательность переменных проверяет схема env; здесь — только сборка.
 */
export function createStorage(env: StorageEnv, apiBaseUrl: string): Storage {
  const publicBaseUrl = env.STORAGE_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (env.STORAGE_DRIVER === "s3") {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)
      throw new Error("STORAGE_DRIVER=s3 требует S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
    return {
      driver: new S3StorageDriver({
        bucket: env.S3_BUCKET,
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION ?? "auto",
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      }),
      publicBaseUrl,
      ephemeralSecret: false,
    };
  }
  const secret = env.STORAGE_SIGNING_SECRET ?? randomBytes(32).toString("base64url");
  return {
    driver: new LocalStorageDriver({
      dir: env.STORAGE_LOCAL_DIR ?? DEFAULT_LOCAL_STORAGE_DIR,
      baseUrl: apiBaseUrl,
      secret,
    }),
    publicBaseUrl,
    ephemeralSecret: env.STORAGE_SIGNING_SECRET === undefined,
  };
}
