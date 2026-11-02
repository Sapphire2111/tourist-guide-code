// Аргументы CLI places:import-google (README apps/api, «Импорт мест из Google»).
import { tmpdir } from "node:os";
import path from "node:path";

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
  if (args.dryRun && args.photos)
    throw new ImportArgsError(
      "places:import-google: --photos пишет в БД и хранилище — несовместим с --dry-run",
    );
  return args;
}
