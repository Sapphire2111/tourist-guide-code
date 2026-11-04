// CLI раздела «Вершини» (places-import/peaks-sync.ts):
//   pnpm --filter @tg/api peaks:sync -- --plan                 — без Google и Commons (только кэш): что есть, чего нет
//   pnpm --filter @tg/api peaks:sync -- --dry-run [--import]   — + поиск недостающих в Google, без записи в БД
//   pnpm --filter @tg/api peaks:sync -- --import               — запись: новые места, подкатегория peaks, обложки
// Чтение и запись — под DATABASE_URL (роль приложения, контекст региона), иначе DATABASE_MIGRATION_URL. Google —
// GOOGLE_MAPS_API_KEY, только с --import, не больше --max-requests Text Search (по умолчанию 15).
import path from "node:path";
import { createDatabase } from "../db/index.js";
import { DEFAULT_CACHE_DIR } from "../places-import/args.js";
import { GooglePlacesClient } from "../places-import/google-client.js";
import { peakDifficulty, roundTripKm, totalHours } from "../places-import/peaks.js";
import { searchQueries, syncPeaks } from "../places-import/peaks-sync.js";
import { WikipediaClient } from "../places-enrich/wikipedia.js";

type Args = {
  region: string;
  plan: boolean;
  dryRun: boolean;
  importMissing: boolean;
  covers: boolean;
  maxRequests: number;
  cacheDir: string;
};

function parse(argv: readonly string[]): Args {
  const a: Args = {
    region: "test-region",
    plan: false,
    dryRun: false,
    importMissing: false,
    covers: true,
    maxRequests: 15,
    cacheDir: DEFAULT_CACHE_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--") continue;
    const [name, inline] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`peaks:sync: у ${name} нет значения`);
      return v;
    };
    if (name === "--plan") a.plan = true;
    else if (name === "--dry-run") a.dryRun = true;
    else if (name === "--import") a.importMissing = true;
    else if (name === "--no-covers") a.covers = false;
    else if (name === "--region") a.region = value();
    else if (name === "--cache") a.cacheDir = path.resolve(value());
    else if (name === "--max-requests") {
      const n = Number(value());
      if (!Number.isSafeInteger(n) || n < 0 || n > 100)
        throw new Error("peaks:sync: --max-requests — от 0 до 100");
      a.maxRequests = n;
    } else throw new Error(`peaks:sync: неизвестный аргумент ${name}`);
  }
  return a;
}

try {
  const args = parse(process.argv.slice(2));
  const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
  if (!url) throw new Error("Не задан DATABASE_URL (или DATABASE_MIGRATION_URL)");
  const google = new GooglePlacesClient({
    apiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined,
    cacheDir: args.cacheDir,
    maxRequests: args.maxRequests,
    planOnly: args.plan,
  });
  const wiki = new WikipediaClient({
    cacheDir: args.cacheDir,
    maxRequests: 100,
    planOnly: args.plan,
    retryDelaysMs: [5_000, 20_000],
    minIntervalMs: 500,
    stopOnUnavailable: true,
  });
  const db = createDatabase({ connectionString: url, maxConnections: 1 });
  try {
    const write = !args.plan && !args.dryRun;
    const { plans, stats } = await syncPeaks({
      db,
      regionCode: args.region,
      google,
      wiki,
      write,
      importMissing: args.importMissing && !args.plan,
      covers: args.covers,
      log: console.log,
    });
    console.log(
      `\nРежим: ${args.plan ? "план" : args.dryRun ? "проба (без записи)" : "запись"}; регион ${args.region}`,
    );
    const cover = new Map(stats.covers.map((c) => [c.slug, c]));
    for (const p of plans) {
      const r = p.peak.route;
      const km = roundTripKm(r);
      const h = totalHours(r);
      console.log(
        [
          p.peak.slug.padEnd(16),
          String(p.peak.heightM ?? "—").padStart(6),
          (peakDifficulty(r) ?? "немає даних").padEnd(11),
          `${km ?? "—"} км / ${r?.elevationGainM ?? "—"} м / ${h ?? (r?.upHours ? `↑${r.upHours}` : "—")} год`,
          p.place
            ? `${p.place.name} [${p.place.category_code}, ${p.matchedBy}] ${p.place.google_place_id ?? ""}`
            : "МІСЦЯ НЕМАЄ",
          `обкладинка: ${cover.get(p.peak.slug)?.status ?? "—"} ${cover.get(p.peak.slug)?.detail ?? ""}`,
        ].join(" | "),
      );
    }
    const missing = searchQueries(plans).map((q) => q.peak.slug);
    console.log(
      `\nGoogle Text Search: ${stats.googleQueries} (сеть ${google.totalRequests}, кэш ${google.cacheHits}); ` +
        `Commons/Wikipedia: ${wiki.requests} (кэш ${wiki.cacheHits}).`,
    );
    if (stats.inserted.length)
      console.log(
        `Добавлено (вписать googlePlaceId в peaks.ts): ${stats.inserted.map((i) => `${i.slug}=${i.googlePlaceId} «${i.name}»`).join("; ")}`,
      );
    if (stats.notFound.length) console.log(`Google не нашёл: ${stats.notFound.join(", ")}`);
    if (stats.nameMatched.length)
      console.log(
        `Найдено только по названию — НЕ изменено (проверить и вписать googlePlaceId в peaks.ts): ${stats.nameMatched.map((m) => `${m.slug}=${m.googlePlaceId ?? "—"} «${m.name}» [${m.category}]`).join("; ")}`,
      );
    if (missing.length) console.log(`Без места в регионе: ${missing.join(", ")}`);
    if (write)
      console.log(
        `Подкатегория peaks создана: ${stats.categoryCreated}; перенесено в peaks: ${stats.recategorized.length}; ` +
          `обложек записано: ${stats.covers.filter((c) => c.status === "written").length}.`,
      );
  } finally {
    await db.destroy();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
