// CLI обогащения мест для богатой карточки (README apps/api, «Обогащение мест»):
//   pnpm --filter @tg/api places:enrich -- --plan [--cache <каталог>]                — оценка запросов и стоимости
//   pnpm --filter @tg/api places:enrich -- --dry-run --limit 3 [--ai --max-ai 3 --wait] — выборка без записи
//   pnpm --filter @tg/api places:enrich -- --region test-region --max-requests 2200 [--ai --max-ai 2200 --wait]
// Бесплатный режим (в пределах бесплатного объёма Google, учёт в google_api_usage):
//   … places:enrich -- --region test-region --from-import-cache --monthly-limit 1000 --max-requests 1000 --covers
// Места — из кэша Text Search импорта (places:import-google, тот же --cache): поиск повторно не запрашивается.
// Google Place Details — GOOGLE_MAPS_API_KEY (только для запросов мимо кэша), ИИ — ANTHROPIC_API_KEY (Message
// Batches, модель claude-sonnet-5-5); ключи в вывод не попадают. Запись — под DATABASE_URL (роль приложения,
// контекст региона), иначе DATABASE_MIGRATION_URL. --plan и --dry-run в БД не пишут (--plan и в сеть не ходит).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createDatabase, type Db } from "../db/index.js";
import { existingCovers, runCovers } from "../places-enrich/covers.js";
import { loadDbPlaces } from "../places-enrich/db-places.js";
import { GoogleQuota } from "../places-enrich/quota.js";
import {
  AI_BATCH_USD_PER_MTOK,
  AI_MODEL,
  AiStore,
  aiEligible,
  buildFacts,
  cachedTextAllowed,
  estimateTokens,
  factsHash,
  runAi,
  type AiItem,
  type AiResult,
} from "../places-enrich/ai.js";
import { EnrichArgsError, parseEnrichArgs } from "../places-enrich/args.js";
import { DEFAULT_SKIP_DETAILS, enrich, GOOGLE_PRICING, googleCostUsd } from "../places-enrich/enrich.js";
import { WikipediaClient } from "../places-enrich/wikipedia.js";
import { withSavedGoogle, writeEnrichment, type EnrichWriteItem } from "../places-enrich/writer.js";
import { IMPORT_LOCALITIES } from "../places-import/config.js";
import { collect } from "../places-import/collect.js";
import { GooglePlacesClient } from "../places-import/google-client.js";
import { CATEGORY_NAMES, findRegionId, ImportWriteError } from "../places-import/writer.js";

/** Режим Wikimedia: паузы перед повторами запросов при 429/5xx (Retry-After — если дольше); не снято — стоп. */
const WIKI_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

const LOCALITY_UK = new Map(IMPORT_LOCALITIES.map((l) => [l.code, l.name.uk]));

let db: Db | undefined;
try {
  const args = parseEnrichArgs(process.argv.slice(2));
  console.log(
    `Кэш: ${args.cacheDir}; режим: ${args.plan ? "оценка (--plan)" : args.dryRun ? "без записи (--dry-run)" : `запись в ${args.region}`}; ` +
      `лимит Place Details: ${args.maxRequests}`,
  );

  // Только Wikimedia (--covers-source wikimedia): Google не вызывается вовсе — места из БД, клиент Google без ключа
  // и с лимитом 0, Place Details и фото Google не запрашиваются.
  const noGoogle = args.coversSource === "wikimedia";
  // Места — только из кэша импорта (лимит 0: Text Search мимо кэша не запрашивается).
  const searchCache = new GooglePlacesClient({ apiKey: undefined, cacheDir: args.cacheDir, maxRequests: 0 });
  const found = noGoogle
    ? { places: [], rawById: new Map(), stats: { limitReached: false, queriesDone: 0, queriesTotal: 0 } }
    : await collect(searchCache, { categoryNames: CATEGORY_NAMES });
  if (found.stats.limitReached)
    console.log(
      `Внимание: кэш импорта неполный (${found.stats.queriesDone}/${found.stats.queriesTotal} запросов) — ` +
        "сначала places:import-google с тем же --cache.",
    );
  if (!noGoogle) console.log(`Мест в кэше импорта: ${found.places.length}.`);

  // БД — учёт месячного предела (google_api_usage), уже сохранённые обложки и запись. Без БД платные запросы к
  // Google не делаются (расход нельзя учесть), только кэш.
  const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
  db = url ? createDatabase({ connectionString: url, maxConnections: 1 }) : undefined;
  const regionId = db ? await findRegionId(db, args.region) : undefined;
  const quota = db ? new GoogleQuota(db) : undefined;
  let warnedNoDb = false;
  const dbPlaces = noGoogle && db && regionId ? await loadDbPlaces(db, regionId) : [];
  if (noGoogle) {
    if (!db || !regionId) throw new ImportWriteError("Не задан DATABASE_URL (или DATABASE_MIGRATION_URL)");
    console.log(
      `Только Wikimedia: опубликованных мест импорта в БД ${dbPlaces.length}; запросов к Google не будет.`,
    );
  }
  const google = new GooglePlacesClient({
    apiKey: noGoogle ? undefined : process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined,
    cacheDir: args.cacheDir,
    maxRequests: noGoogle ? 0 : args.maxRequests,
    planOnly: args.plan,
    rpm: args.rpm,
    log: console.log,
    quota: async (sku) => {
      if (noGoogle) return false;
      if (quota) return quota.take(sku, { monthly: args.monthlyLimit });
      if (!warnedNoDb)
        console.log("Нет DATABASE_URL: платные запросы Google не делаются (нечем учесть месячный предел).");
      warnedNoDb = true;
      return false;
    },
  });
  const wikipedia = args.wiki
    ? new WikipediaClient({
        cacheDir: args.cacheDir,
        maxRequests: args.maxWikiRequests,
        planOnly: args.plan,
        ...(noGoogle
          ? { retryDelaysMs: WIKI_RETRY_DELAYS_MS, minIntervalMs: 250, stopOnUnavailable: true }
          : {}),
      })
    : undefined;
  const enriched = await enrich(noGoogle ? dbPlaces : found.places, google, wikipedia, {
    categories: args.categories,
    skipCategories: args.skipCategories,
    limit: args.limit,
    only: args.only.size ? args.only : undefined,
    rawById: args.fromImportCache ? found.rawById : undefined,
    details: noGoogle ? false : args.details,
    freePhotos: !noGoogle,
    skipDetails: DEFAULT_SKIP_DETAILS,
    prioritize: true,
    wikimediaOnly: noGoogle,
    log: console.log,
  });
  const stats = enriched.stats;
  if (noGoogle) {
    // Сохранённые данные Google — только к фактам ИИ; запись режима колонки Google не трогает.
    const saved = new Map(dbPlaces.map((p) => [p.googlePlaceId, p.savedGoogle]));
    for (const p of enriched.places) p.google = saved.get(p.googlePlaceId) ?? null;
  }
  // Из кэша импорта (беднее Details): слить с сохранённым до фактов ИИ; места с готовым текстом ИИ — без пакета.
  // Режим Wikimedia: готовый текст учитывается у всех мест, не только с сохранённым Google.
  const { places, withAi } = noGoogle
    ? {
        places: enriched.places,
        withAi: new Set(dbPlaces.filter((p) => p.hasAi).map((p) => p.googlePlaceId)),
      }
    : db && regionId
      ? await withSavedGoogle(db, regionId, enriched.places)
      : { places: enriched.places, withAi: new Set<string>() };
  const report: Record<string, unknown> = { enrich: stats };

  // Месячный предел: сколько Place Details и фото уйдёт в этом месяце, сколько останется на следующие.
  const used = quota
    ? { details: await quota.used("place_details"), photos: await quota.used("place_photos") }
    : { details: { month: 0, today: 0 }, photos: { month: 0, today: 0 } };
  const remainingDetails = Math.max(0, args.monthlyLimit - used.details.month);
  const detailsNeeded = args.plan ? google.planned.details : stats.detailsDeferred;
  const detailsThisMonth = args.plan ? Math.min(detailsNeeded, remainingDetails) : google.requests.details;
  const detailsLater = args.plan ? detailsNeeded - detailsThisMonth : stats.detailsDeferred;
  const monthly = {
    limit: args.monthlyLimit,
    details: {
      usedThisMonth: used.details.month,
      thisMonth: detailsThisMonth,
      later: detailsLater,
      months: args.monthlyLimit ? Math.ceil(detailsLater / args.monthlyLimit) : null,
    },
    photosUsedThisMonth: used.photos.month,
  };
  report.monthly = monthly;
  console.log(
    `\nМесячный предел Google ${args.monthlyLimit} на SKU${quota ? "" : " (БД нет — учёт неизвестен, считаю 0)"}: ` +
      `Place Details использовано ${used.details.month}, в этом месяце ${args.plan ? "получат" : "получили"} ` +
      `${detailsThisMonth} мест, на следующие месяцы — ${detailsLater}` +
      (monthly.details.months ? ` (≈ ${monthly.details.months} мес.)` : "") +
      `; Place Photos использовано ${used.photos.month}.`,
  );

  // Обложки: одна на место, Wikimedia — бесплатно, Google — в пределе place_photos; уже сохранённые — пропуск.
  if (args.covers) {
    const existing = db && regionId ? await existingCovers(db, regionId) : new Set<string>();
    const write = !args.plan && !args.dryRun;
    const coverStats = await runCovers(places, {
      google,
      db,
      regionId,
      existing,
      write,
      log: console.log,
      ...(noGoogle ? { wikimediaOnly: true, retryDelaysMs: WIKI_RETRY_DELAYS_MS } : {}),
    });
    // В --plan Details/фото ещё нет: источник обложки — фото в кэше поиска импорта.
    const planCovers = args.plan
      ? places.filter(
          (p) =>
            !existing.has(p.googlePlaceId) &&
            !p.wiki?.image &&
            !p.google?.photos.length &&
            (found.rawById.get(p.googlePlaceId)?.photos?.length ?? 0) > 0,
        ).length
      : 0;
    const wikiCovers = places.filter((p) => p.wiki?.image && !existing.has(p.googlePlaceId)).length;
    const googleCovers = coverStats.needed - wikiCovers + planCovers;
    const remainingPhotos = Math.max(0, args.monthlyLimit - used.photos.month);
    console.log(
      `Обложки: есть ${coverStats.existing}, нужно ${coverStats.needed + planCovers} (Wikimedia ${wikiCovers} — бесплатно; ` +
        `Google ${googleCovers}: в этом месяце до ${Math.min(googleCovers, remainingPhotos)}); записано ${coverStats.written} ` +
        `(Wikimedia ${coverStats.wikimedia}, Google ${coverStats.google}), отложено пределом Google ${coverStats.deferred}, ` +
        `Wikimedia недоступна (повторить позже) ${coverStats.wikiUnavailable}, ` +
        `отложено поминутной квотой Google ${coverStats.rateLimited}, ошибок ${coverStats.failed}` +
        (noGoogle ? `; без надёжного фото Commons (P18) ${coverStats.noWikiImage}.` : "."),
    );
    report.covers = {
      ...coverStats,
      wikiCovers,
      googleCovers,
      googleCoversThisMonth: Math.min(googleCovers, remainingPhotos),
    };
  }

  // ИИ: факты → хэш → кэш результатов; новые — пакетом (только с --ai, не в --plan).
  const store = new AiStore(args.cacheDir);
  const aiItems = new Map<string, AiItem>();
  for (const p of places) {
    if (!aiEligible(p, withAi, noGoogle)) continue;
    const facts = buildFacts({
      name: p.name,
      category: CATEGORY_NAMES[p.categoryCode] ?? p.categoryCode,
      locality: LOCALITY_UK.get(p.localityCode) ?? null,
      address: p.address,
      google: p.google,
      wiki: p.wiki ?? null,
    });
    if (facts)
      aiItems.set(p.googlePlaceId, { hash: factsHash(facts, noGoogle), facts, paraphrase: noGoogle });
  }
  const aiMissing: AiItem[] = [];
  for (const it of aiItems.values()) if (!(await store.get(it.hash))) aiMissing.push(it);
  const tokens = estimateTokens(aiMissing);
  let aiStats: Awaited<ReturnType<typeof runAi>> | undefined;
  if (args.ai && !args.plan) {
    if (!process.env.ANTHROPIC_API_KEY?.trim())
      throw new EnrichArgsError("places:enrich: для --ai нужен ANTHROPIC_API_KEY");
    const client = new Anthropic();
    aiStats = await runAi(client.messages.batches, store, [...aiItems.values()], {
      maxNew: args.maxAi,
      wait: args.wait,
      log: console.log,
    });
    report.ai = aiStats;
  }

  // В --plan Details ещё нет: верхняя граница — до 5 фото на место; ИИ — все места с ~1300 вх. токенов.
  const planPlaces = args.plan ? google.planned.details : 0;
  const photoViews = places.reduce((n, p) => n + (p.google?.photos.length ?? 0), 0) + planPlaces * 5;
  if (args.plan) {
    tokens.input += planPlaces * 1300;
    tokens.output += planPlaces * 400;
  }
  const estimate = {
    placeDetails: googleCostUsd(
      args.plan ? google.planned.details : google.requests.details,
      GOOGLE_PRICING.detailsAtmosphere,
    ),
    // Фото запрашиваются лениво (при просмотре карточки) и кэшируются: верхняя граница — каждое фото в 2 ширинах.
    photosUpperBound: googleCostUsd(photoViews * 2, GOOGLE_PRICING.photos),
    wikipediaRequests: args.plan ? `≥ ${wikipedia?.planned ?? 0} (бесплатно)` : (wikipedia?.requests ?? 0),
    ai: {
      model: AI_MODEL,
      placesWithFacts: aiItems.size,
      toGenerate: aiMissing.length + planPlaces,
      estTokens: tokens,
      estUsd:
        Math.round(
          ((tokens.input * AI_BATCH_USD_PER_MTOK.input + tokens.output * AI_BATCH_USD_PER_MTOK.output) /
            1e6) *
            100,
        ) / 100,
    },
  };
  report.estimate = estimate;

  console.log(
    `\nМест обработано ${stats.places} (пропущено по категориям ${stats.skippedByCategory}); Place Details получено ` +
      `${stats.details}, с данными ${stats.withData}: фото ${stats.withPhotos}, отзывы ${stats.withReviews}, ` +
      `удобства ${stats.withAmenities}, описание ${stats.withSummary}, рейтинг ${stats.withRating}` +
      `${stats.googleLimitReached ? " (Google остановлен: лимит или суточная/месячная квота)" : ""}` +
      `${stats.rateLimited ? `; отложено поминутной квотой Google: ${stats.rateLimited}` : ""}.`,
  );
  console.log(
    `Вікіпедія: искали ${stats.wikiSearched}, найдено ${stats.wikiFound}, с фото Commons ${stats.wikiWithImage}, ` +
      `запросов ${wikipedia?.requests ?? 0} (из кэша ${wikipedia?.cacheHits ?? 0}, повторов после 429/5xx ${wikipedia?.retries ?? 0}), ` +
      `недоступна (429/5xx — повторить позже) ${stats.wikiUnavailable}` +
      `${stats.wikiLimitReached ? " (остановлено лимитом)" : ""}.`,
  );
  console.log(
    `Google Place Details: ${args.plan ? `понадобится запросов ${google.planned.details}` : `запросов ${google.requests.details}`}, ` +
      `из кэша ${google.cacheHits}; бесплатных «id,photos» ${args.plan ? google.planned.detailsIds : google.requests.detailsIds}; ≈ $${estimate.placeDetails.usdNoFreeTier} без бесплатного лимита ` +
      `($${estimate.placeDetails.usdAfterFreeTier} после ${GOOGLE_PRICING.detailsAtmosphere.freePerMonth} бесплатных в месяц).`,
  );
  console.log(
    `Темп Google: --rpm ${args.rpm || "без ограничения"}; ожидание ${Math.round(google.waitedMs / 1000)} с, ` +
      `429 по поминутной квоте ${google.rateLimitHits}, отложено после повторов ${google.rateLimitedGiveUps}.`,
  );
  console.log(
    `Фото Google (лениво, при просмотре, с кэшем): не больше ${photoViews * 2} запросов ≈ $${estimate.photosUpperBound.usdNoFreeTier}.`,
  );
  console.log(
    `ИИ (${AI_MODEL}, Batches): мест с фактами ${aiItems.size}, новых текстов ${aiMissing.length + planPlaces}${args.plan ? " (верхняя граница)" : ""}, ` +
      `≈ ${tokens.input} вх. / ${tokens.output} вых. токенов ≈ $${estimate.ai.estUsd}` +
      (aiStats
        ? `; пакет ${aiStats.batchId ?? "—"}: отправлено ${aiStats.submitted}, принято ${aiStats.accepted}, ` +
          `отклонено ${aiStats.rejected}, ошибок ${aiStats.errored}${aiStats.stillProcessing ? " (ещё обрабатывается — повторить позже)" : ""}`
        : args.ai
          ? ""
          : " (без --ai не генерируются)"),
  );

  // Результаты ИИ из кэша — к записи и отчёту.
  const items: EnrichWriteItem[] = [];
  for (const p of places) {
    const it = aiItems.get(p.googlePlaceId);
    const cached: AiResult | null = it ? await store.get(it.hash) : null;
    // Режим Wikimedia: копия статьи не пишется, даже если попала в кэш результатов.
    const result = noGoogle ? cachedTextAllowed(cached, p.wiki?.extract) : cached;
    // Хэш фактов передаётся всегда: устаревший текст (другие факты, нового ещё нет) запись снимает. Фактов нет при
    // свежих данных Google — текст тоже снимается (hash null). Режим Wikimedia ничего не снимает: данные Google в нём
    // не свежие, а ранее сохранённые.
    items.push({
      ...p,
      ai: it ? { hash: it.hash, result } : p.google && !noGoogle ? { hash: null, result: null } : undefined,
    });
  }

  if (!args.plan && !args.dryRun) {
    if (!db || !regionId) throw new ImportWriteError("Не задан DATABASE_URL (или DATABASE_MIGRATION_URL)");
    const written = await writeEnrichment(db, regionId, items, new Date(), { wikimediaOnly: noGoogle });
    report.write = written;
    console.log(
      `\nЗапись в ${args.region}: обогащено мест ${written.written}, ИИ-текстов ${written.aiWritten}, ` +
        `снято устаревших ${written.aiCleared}; нет в БД (сначала импорт) ${written.notInDb}.`,
    );
  }

  // Проверка режима «только Wikimedia»: к Google — ни одного запроса.
  const googleTotal = Object.values(google.requests).reduce((a, b) => a + b, 0);
  report.googleRequests = { ...google.requests, total: googleTotal };
  console.log(`Запросов к Google за прогон: ${googleTotal}.`);

  if (args.report) {
    await mkdir(path.dirname(args.report), { recursive: true });
    await writeFile(
      args.report,
      JSON.stringify(
        {
          ...report,
          // Режим Wikimedia: статьи, отклонённые по типу P31 (проверка таблицы типов).
          wikiTypeRejects: wikipedia?.typeRejects ?? [],
          places: items.map((p) => ({
            googlePlaceId: p.googlePlaceId,
            name: p.name,
            category: p.categoryCode,
            typeLabel: p.google?.typeLabel ?? null,
            rating: p.google?.rating ?? null,
            ratingCount: p.google?.ratingCount ?? null,
            photos: p.google?.photos.length ?? 0,
            reviews: p.google?.reviews.length ?? 0,
            amenities: p.google?.amenities ?? [],
            wiki: p.wiki ? `${p.wiki.lang}: ${p.wiki.title}` : p.wiki === null ? "нет совпадения" : null,
            ai: p.ai?.result?.text ?? null,
          })),
        },
        null,
        2,
      ),
    );
    console.log(`Отчёт: ${args.report}`);
  }
} catch (err) {
  console.error(
    err instanceof EnrichArgsError || err instanceof ImportWriteError
      ? err.message
      : err instanceof Error
        ? err.message
        : err,
  );
  process.exitCode = 1;
} finally {
  await db?.destroy();
}
