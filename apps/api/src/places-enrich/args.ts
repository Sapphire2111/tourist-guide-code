// Аргументы CLI places:enrich (README apps/api, «Обогащение мест»).
import path from "node:path";
import { DEFAULT_CACHE_DIR } from "../places-import/args.js";

export type EnrichArgs = {
  region: string;
  /** Только оценка: без сети и БД — сколько запросов к Google/Вікіпедії/Claude понадобится и сколько это стоит. */
  plan: boolean;
  /** Сбор (с запросами мимо кэша в пределах лимитов) и отчёт, без записи в БД. */
  dryRun: boolean;
  /** Каталог кэша ответов (общий с places:import-google: места берутся из его кэша Text Search). */
  cacheDir: string;
  /** Предел запросов к Google Place Details за прогон (из кэша не считаются). */
  maxRequests: number;
  /** Предел запросов к Вікіпедії / Commons за прогон. */
  maxWikiRequests: number;
  /** Без Вікіпедії. */
  wiki: boolean;
  /** ИИ-текст через Message Batches. */
  ai: boolean;
  /** Не больше стольких новых запросов к Claude в пакете. */
  maxAi: number;
  /** Ждать окончания пакета (опрос раз в 30 с), иначе — дособрать при следующем прогоне. */
  wait: boolean;
  /** Только первые N мест (выборка для проверки). */
  limit: number | undefined;
  /** Только места с этими google_place_id. */
  only: Set<string>;
  /** Только эти категории; пусто — все. */
  categories: Set<string>;
  /** Не обогащать эти категории. */
  skipCategories: Set<string>;
  report: string | undefined;
  /** Бесплатный режим: тип, рейтинг, описание — из кэша Text Search импорта; фото — запросом «id,photos». */
  fromImportCache: boolean;
  /** Платный Place Details (Atmosphere) вовсе не запрашивать. */
  details: boolean;
  /** Месячный предел платных запросов на SKU (google_api_usage; бесплатный объём Google — 1000). */
  monthlyLimit: number;
  /** Скачать обложки (одна на место) в place_cover_photos. */
  covers: boolean;
};

export class EnrichArgsError extends Error {
  override readonly name = "EnrichArgsError";
}

export const DEFAULT_ENRICH_MAX_REQUESTS = 100;
export const DEFAULT_WIKI_MAX_REQUESTS = 1000;
export const DEFAULT_MAX_AI = 0;

const list = (v: string) =>
  new Set(
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

export function parseEnrichArgs(argv: readonly string[]): EnrichArgs {
  const args: EnrichArgs = {
    region: "test-region",
    plan: false,
    dryRun: false,
    cacheDir: DEFAULT_CACHE_DIR,
    maxRequests: DEFAULT_ENRICH_MAX_REQUESTS,
    maxWikiRequests: DEFAULT_WIKI_MAX_REQUESTS,
    wiki: true,
    ai: false,
    maxAi: DEFAULT_MAX_AI,
    wait: false,
    limit: undefined,
    only: new Set(),
    categories: new Set(),
    skipCategories: new Set(),
    report: undefined,
    fromImportCache: false,
    details: true,
    monthlyLimit: 1000,
    covers: false,
  };
  let maxAiSet = false;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--") continue;
    const eq = raw.indexOf("=");
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    const value = (): string => {
      const v = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (v === undefined || v === "" || v.startsWith("--"))
        throw new EnrichArgsError(`places:enrich: у ${name} нет значения`);
      return v;
    };
    const int = (min: number): number => {
      const n = Number(value());
      if (!Number.isSafeInteger(n) || n < min)
        throw new EnrichArgsError(`places:enrich: ${name} — целое число ≥ ${min}`);
      return n;
    };
    switch (name) {
      case "--plan":
        args.plan = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--no-wiki":
        args.wiki = false;
        break;
      case "--from-import-cache":
        args.fromImportCache = true;
        break;
      case "--no-details":
        args.details = false;
        break;
      case "--covers":
        args.covers = true;
        break;
      case "--monthly-limit":
        args.monthlyLimit = int(0);
        break;
      case "--ai":
        args.ai = true;
        break;
      case "--wait":
        args.wait = true;
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
      case "--max-requests":
        args.maxRequests = int(0);
        break;
      case "--max-wiki-requests":
        args.maxWikiRequests = int(0);
        break;
      case "--max-ai":
        args.maxAi = int(0);
        maxAiSet = true;
        break;
      case "--limit":
        args.limit = int(1);
        break;
      case "--only":
        args.only = list(value());
        break;
      case "--categories":
        args.categories = list(value());
        break;
      case "--skip-categories":
        args.skipCategories = list(value());
        break;
      default:
        throw new EnrichArgsError(`places:enrich: неизвестный аргумент ${name}`);
    }
  }
  if (args.plan && args.dryRun)
    throw new EnrichArgsError("places:enrich: --plan уже без записи — --dry-run не нужен");
  if (args.ai && !maxAiSet && !args.plan)
    throw new EnrichArgsError(
      "places:enrich: с --ai укажите --max-ai N (сколько текстов можно сгенерировать)",
    );
  return args;
}
