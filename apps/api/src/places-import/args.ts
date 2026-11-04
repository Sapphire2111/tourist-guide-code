// Аргументы CLI places:import-google (README apps/api, «Импорт мест из Google»).
import { tmpdir } from "node:os";
import path from "node:path";
import type { StorageEnv } from "@tg/media";
import { databaseHost } from "../seed/guard.js";
import type { SearchFields } from "./google-client.js";

export type ImportArgs = {
  /** Код региона (regions.code), куда писать. */
  region: string;
  /** Только выгрузка и отчёт, без подключения к БД. */
  dryRun: boolean;
  /** Этап фото (после записи мест). */
  photos: boolean;
  /** Каталог кэша ответов Google (вне репозитория). */
  cacheDir: string;
  /** Предел запросов к Google за прогон (ответы из кэша не считаются). */
  maxRequests: number;
  /** Файл JSON с итоговой статистикой (необязательно). */
  report: string | undefined;
  /** Точечный импорт: JSON-файл со списком запросов (targeted.ts). */
  queriesFile: string | undefined;
  /** Точечный импорт: `--query "текст=категория"` (можно несколько). */
  queries: string[];
  /** Набор полей Text Search (SKU Google): full | enterprise | pro. */
  fields: SearchFields;
  /** Широкий импорт только по зонам поиска (SEARCH_ZONES), без кругов пунктов; пишет только новые места. */
  zonesOnly: boolean;
  /** Писать только новые места: существующие (тот же google place id) не трогать, не скрывать и не архивировать. */
  insertOnly: boolean;
  /** Широкий импорт: свои запросы вместо IMPORT_QUERIES (`--search "Нова пошта відділення"`, можно несколько). */
  searches: string[];
  /** Оценка без запросов к Google и без записи: сколько Text Search мимо кэша понадобится (первые страницы). */
  plan: boolean;
};

export class ImportArgsError extends Error {
  override readonly name = "ImportArgsError";
}

/** Кэш по умолчанию — во временном каталоге ОС, не в репозитории. */
export const DEFAULT_CACHE_DIR = path.join(tmpdir(), "tourist-guide-google-cache");
export const DEFAULT_MAX_REQUESTS = 1000;

/** `--key value` и `--key=value`; флаги без значения — --dry-run, --photos. */
export function parseImportArgs(argv: readonly string[]): ImportArgs {
  const args: ImportArgs = {
    region: "test-region",
    dryRun: false,
    photos: false,
    cacheDir: DEFAULT_CACHE_DIR,
    maxRequests: DEFAULT_MAX_REQUESTS,
    report: undefined,
    queriesFile: undefined,
    queries: [],
    fields: "full",
    zonesOnly: false,
    insertOnly: false,
    searches: [],
    plan: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--") continue;
    const eq = raw.indexOf("=");
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const value = (): string => {
      const v = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (v === undefined || v === "" || v.startsWith("--"))
        throw new ImportArgsError(`places:import-google: у ${name} нет значения`);
      return v;
    };
    switch (name) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--photos":
        args.photos = true;
        break;
      case "--region":
        args.region = value();
        break;
      case "--cache":
        args.cacheDir = path.resolve(value());
        break;
      case "--report":
        args.report = path.resolve(value());
        break;
      case "--queries-file":
        args.queriesFile = path.resolve(value());
        break;
      case "--query":
        args.queries.push(value());
        break;
      case "--search":
        args.searches.push(value());
        break;
      case "--fields": {
        const v = value();
        if (v !== "full" && v !== "enterprise" && v !== "pro")
          throw new ImportArgsError("places:import-google: --fields — full, enterprise или pro");
        args.fields = v;
        break;
      }
      case "--plan":
        args.plan = true;
        args.dryRun = true;
        break;
      case "--zones-only":
        args.zonesOnly = true;
        args.insertOnly = true;
        break;
      case "--insert-only":
        args.insertOnly = true;
        break;
      case "--max-requests": {
        const n = Number(value());
        if (!Number.isSafeInteger(n) || n < 0)
          throw new ImportArgsError("places:import-google: --max-requests — целое число ≥ 0");
        args.maxRequests = n;
        break;
      }
      default:
        throw new ImportArgsError(`places:import-google: неизвестный аргумент ${name}`);
    }
  }
  if ((args.zonesOnly || args.searches.length) && (args.queriesFile || args.queries.length))
    throw new ImportArgsError(
      "places:import-google: --zones-only/--search — широкий импорт, несовместимы с --queries-file/--query",
    );
  if (args.dryRun && args.photos)
    throw new ImportArgsError(
      "places:import-google: --photos пишет в БД и хранилище — несовместим с --dry-run",
    );
  return args;
}

/** Хосты БД, при которых local-хранилище фото допустимо: БД на этой же машине, где лежат файлы. */
const LOCAL_DB_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/**
 * Хранилище этапа --photos из env. STORAGE_DRIVER=local допустим только с локальной БД (хост DATABASE_URL, иначе
 * DATABASE_MIGRATION_URL — localhost/127.0.0.1/::1) и APP_ENV=local: CLI запускается не на сервере api, файлы легли бы
 * на диск этой машины, а записи media_assets — в общую БД (у туриста — битые ссылки). Иначе нужен s3, общий с api.
 */
export function photoStorageEnv(env: Record<string, string | undefined>): StorageEnv {
  const driver = env.STORAGE_DRIVER?.trim() || "local";
  if (driver !== "local" && driver !== "s3")
    throw new ImportArgsError(`STORAGE_DRIVER=${driver}: нужен local или s3`);
  if (driver === "local") {
    const url = env.DATABASE_URL?.trim() || env.DATABASE_MIGRATION_URL?.trim();
    const host = url ? databaseHost(url) : undefined;
    const appEnv = env.APP_ENV?.trim() || "local";
    if (!host || !LOCAL_DB_HOSTS.includes(host) || appEnv !== "local")
      throw new ImportArgsError(
        `--photos со STORAGE_DRIVER=local только для локальной БД (хост ${host ?? "не разобран"}, APP_ENV=${appEnv}): ` +
          "файлы не попадут на сервер api — нужен STORAGE_DRIVER=s3 (бакет, общий с api)",
      );
  }
  const opt = (k: string) => env[k]?.trim() || undefined;
  return {
    STORAGE_DRIVER: driver,
    STORAGE_LOCAL_DIR: opt("STORAGE_LOCAL_DIR"),
    STORAGE_SIGNING_SECRET: opt("STORAGE_SIGNING_SECRET"),
    STORAGE_PUBLIC_BASE_URL: opt("STORAGE_PUBLIC_BASE_URL"),
    S3_ENDPOINT: opt("S3_ENDPOINT"),
    S3_REGION: opt("S3_REGION"),
    S3_BUCKET: opt("S3_BUCKET"),
    S3_ACCESS_KEY_ID: opt("S3_ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: opt("S3_SECRET_ACCESS_KEY"),
  };
}
