// CLI обогащения мест для богатой карточки (README apps/api, «Обогащение мест»):
//   pnpm --filter @tg/api places:enrich -- --plan [--cache <каталог>]                — оценка запросов и стоимости
//   pnpm --filter @tg/api places:enrich -- --dry-run --limit 3 [--ai --max-ai 3 --wait] — выборка без записи
//   pnpm --filter @tg/api places:enrich -- --region test-region --max-requests 2200 [--ai --max-ai 2200 --wait]
// Места — из кэша Text Search импорта (places:import-google, тот же --cache): поиск повторно не запрашивается.
// Google Place Details — GOOGLE_MAPS_API_KEY (только для запросов мимо кэша), ИИ — ANTHROPIC_API_KEY (Message
// Batches, модель claude-sonnet-5-5); ключи в вывод не попадают. Запись — под DATABASE_URL (роль приложения,
// контекст региона), иначе DATABASE_MIGRATION_URL. --plan и --dry-run в БД не пишут (--plan и в сеть не ходит).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createDatabase } from "../db/index.js";
import {
  AI_BATCH_USD_PER_MTOK,
  AI_MODEL,
  AiStore,
  buildFacts,
  estimateTokens,
  factsHash,
  runAi,
  type AiItem,
  type AiResult,
} from "../places-enrich/ai.js";
import { EnrichArgsError, parseEnrichArgs } from "../places-enrich/args.js";
import { enrich, GOOGLE_PRICING, googleCostUsd } from "../places-enrich/enrich.js";
import { WikipediaClient } from "../places-enrich/wikipedia.js";
import { writeEnrichment, type EnrichWriteItem } from "../places-enrich/writer.js";
import { IMPORT_LOCALITIES } from "../places-import/config.js";
import { collect } from "../places-import/collect.js";
import { GooglePlacesClient } from "../places-import/google-client.js";
import { CATEGORY_NAMES, findRegionId, ImportWriteError } from "../places-import/writer.js";

const LOCALITY_UK = new Map(IMPORT_LOCALITIES.map((l) => [l.code, l.name.uk]));

try {
  const args = parseEnrichArgs(process.argv.slice(2));
  console.log(
    `Кэш: ${args.cacheDir}; режим: ${args.plan ? "оценка (--plan)" : args.dryRun ? "без записи (--dry-run)" : `запись в ${args.region}`}; ` +
      `лимит Place Details: ${args.maxRequests}`,
  );

  // Места — только из кэша импорта (лимит 0: Text Search мимо кэша не запрашивается).
  const searchCache = new GooglePlacesClient({ apiKey: undefined, cacheDir: args.cacheDir, maxRequests: 0 });
  const found = await collect(searchCache, { categoryNames: CATEGORY_NAMES });
  if (found.stats.limitReached)
    console.log(
      `Внимание: кэш импорта неполный (${found.stats.queriesDone}/${found.stats.queriesTotal} запросов) — ` +
        "сначала places:import-google с тем же --cache.",
    );
  console.log(`Мест в кэше импорта: ${found.places.length}.`);

  const google = new GooglePlacesClient({
    apiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined,
    cacheDir: args.cacheDir,
    maxRequests: args.maxRequests,
    planOnly: args.plan,
  });
  const wikipedia = args.wiki
    ? new WikipediaClient({ cacheDir: args.cacheDir, maxRequests: args.maxWikiRequests, planOnly: args.plan })
    : undefined;
  const { places, stats } = await enrich(found.places, google, wikipedia, {
    categories: args.categories,
    skipCategories: args.skipCategories,
    limit: args.limit,
    only: args.only.size ? args.only : undefined,
    log: console.log,
  });

  // ИИ: факты → хэш → кэш результатов; новые — пакетом (только с --ai, не в --plan).
  const store = new AiStore(args.cacheDir);
  const aiItems = new Map<string, AiItem>();
  for (const p of places) {
    const facts = buildFacts({
      name: p.name,
      category: CATEGORY_NAMES[p.categoryCode] ?? p.categoryCode,
      locality: LOCALITY_UK.get(p.localityCode) ?? null,
      address: p.address,
      google: p.google,
      wiki: p.wiki ?? null,
    });
    if (facts) aiItems.set(p.googlePlaceId, { hash: factsHash(facts), facts });
  }
  const aiMissing: AiItem[] = [];
  for (const it of aiItems.values()) if (!(await store.get(it.hash))) aiMissing.push(it);
  const tokens = estimateTokens(aiMissing);
  const report: Record<string, unknown> = { enrich: stats };
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
      `${stats.googleLimitReached ? " (остановлено лимитом --max-requests)" : ""}.`,
  );
  console.log(
    `Вікіпедія: искали ${stats.wikiSearched}, найдено ${stats.wikiFound}, с фото Commons ${stats.wikiWithImage}` +
      `${stats.wikiLimitReached ? " (остановлено лимитом)" : ""}.`,
  );
  console.log(
    `Google Place Details: ${args.plan ? `понадобится запросов ${google.planned.details}` : `запросов ${google.requests.details}`}, ` +
      `из кэша ${google.cacheHits}; ≈ $${estimate.placeDetails.usdNoFreeTier} без бесплатного лимита ` +
      `($${estimate.placeDetails.usdAfterFreeTier} после ${GOOGLE_PRICING.detailsAtmosphere.freePerMonth} бесплатных в месяц).`,
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
    const result: AiResult | null = it ? await store.get(it.hash) : null;
    items.push({ ...p, ai: it && result ? { hash: it.hash, result } : undefined });
  }

  if (!args.plan && !args.dryRun) {
    const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
    if (!url) throw new ImportWriteError("Не задан DATABASE_URL (или DATABASE_MIGRATION_URL)");
    const db = createDatabase({ connectionString: url, maxConnections: 1 });
    try {
      const regionId = await findRegionId(db, args.region);
      const written = await writeEnrichment(db, regionId, items, new Date());
      report.write = written;
      console.log(
        `\nЗапись в ${args.region}: обогащено мест ${written.written}, ИИ-текстов ${written.aiWritten}; ` +
          `нет в БД (сначала импорт) ${written.notInDb}.`,
      );
    } finally {
      await db.destroy();
    }
  }

  if (args.report) {
    await mkdir(path.dirname(args.report), { recursive: true });
    await writeFile(
      args.report,
      JSON.stringify(
        {
          ...report,
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
}
