// CLI импорта настоящих мест из Google Maps (Places API (New)) — README apps/api, «Импорт мест из Google»:
//   pnpm --filter @tg/api places:import-google -- --dry-run [--cache <каталог>] [--max-requests 1000] [--report f.json]
//   pnpm --filter @tg/api places:import-google -- --region test-region [--photos]
//   … --queries-file landmarks.json | --query "Говерла=nature" — точечный импорт (targeted.ts): один Text Search на
//   запрос, категория из запроса, без снятия с публикации/архива остальных мест.
//   … --zones-only — только зоны поиска (SEARCH_ZONES) и только новые места; --search "текст" — свои запросы вместо
//   IMPORT_QUERIES; --insert-only — существующие места не трогать; --fields enterprise|pro — дешевле SKU Text Search
//   (без описания / без телефона, часов, рейтинга); --plan — оценка запросов мимо кэша без Google и без записи.
// Ключ — GOOGLE_MAPS_API_KEY (нужен только для запросов мимо кэша; в вывод не попадает). Запись — под DATABASE_URL
// (роль приложения, контекст региона: TenantGuardPlugin + RLS), иначе DATABASE_MIGRATION_URL. --dry-run к БД не
// подключается. --photos — ещё и хранилище медиа из env (STORAGE_DRIVER, STORAGE_LOCAL_DIR, S3_*).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createStorage } from "@tg/media";
import { createDatabase } from "../db/index.js";
import { ImportArgsError, parseImportArgs, photoStorageEnv } from "../places-import/args.js";
import { collect } from "../places-import/collect.js";
import { GooglePlacesClient } from "../places-import/google-client.js";
import { importPhotos, photoCandidates } from "../places-import/photos.js";
import {
  CATEGORY_NAMES,
  googlePlaceIds,
  ImportWriteError,
  regionGoogleIds,
  writePlaces,
} from "../places-import/writer.js";
import {
  ALL_LOCALITIES,
  collectTargeted,
  parseQueryFlag,
  parseTargetedQueries,
  readTargetedQueries,
  TargetedQueryError,
  type TargetedQuery,
} from "../places-import/targeted.js";
import { SEED_PLACES } from "../seed/seed-catalog.js";

const sortedEntries = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]);

try {
  const args = parseImportArgs(process.argv.slice(2));
  // Хранилище фото — до выгрузки и записи: несовместимую настройку видно сразу.
  const storage = args.photos ? createStorage(photoStorageEnv(process.env), "http://localhost") : undefined;
  const client = new GooglePlacesClient({
    apiKey: process.env.GOOGLE_MAPS_API_KEY?.trim() || undefined,
    cacheDir: args.cacheDir,
    maxRequests: args.maxRequests,
    searchFields: args.fields,
    planOnly: args.plan,
  });
  console.log(
    `Кэш ответов Google: ${args.cacheDir}; лимит запросов: ${args.maxRequests}; поля Text Search: ${args.fields}` +
      `${args.plan ? "; оценка (--plan): в Google не ходим" : ""}`,
  );
  if (args.queriesFile || args.queries.length) {
    await runTargeted(args, client, storage);
  } else {
    // Места региона (и при --dry-run, если задана БД): при свёртке дублей остаётся опубликованная, затем уже известная
    // запись — тот же выбор, что при записи.
    let known: { published: Set<string>; existing: Set<string> } | undefined;
    const dbUrl = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
    if (!args.plan && dbUrl) {
      const db = createDatabase({ connectionString: dbUrl, maxConnections: 1 });
      try {
        known = await regionGoogleIds(db, args.region);
      } finally {
        await db.destroy();
      }
    } else if (!args.plan) console.log("ВНИМАНИЕ: БД не задана — дубли сворачиваются без учёта мест в БД.");
    const { places, stats, closedIds, rejectedIds, seenIds } = await collect(client, {
      ...(known ? { publishedIds: known.published, existingIds: known.existing } : {}),
      categoryNames: CATEGORY_NAMES,
      log: console.log,
      zonesOnly: args.zonesOnly,
      ...(args.searches.length ? { queries: args.searches } : {}),
    });
    // --plan (всегда без записи): ниже — статистика только по ответам из кэша.
    if (args.plan)
      console.log(
        `\nОценка: запросов Text Search мимо кэша (первые страницы) ${client.planned.search}, из кэша ${client.cacheHits}; ` +
          "вторые-третьи страницы — сверх (до ×3 на запрос).",
      );
    console.log(
      `Из них зоны поиска (SEARCH_ZONES): запросов ${stats.zones.queries}, к Google ${stats.zones.googleRequests}` +
        `${args.plan ? `, мимо кэша (оценка) ${stats.zones.planned}` : ""}, из кэша ${stats.zones.cacheHits}.`,
    );
    const report: Record<string, unknown> = { collect: stats };

    console.log(
      `\nВыгрузка: запросов выполнено ${stats.queriesDone}/${stats.queriesTotal}${stats.limitReached ? " (остановлено лимитом — данные неполные)" : ""}; ` +
        `мест получено ${stats.fetched}, уникальных ${stats.unique}, к импорту ${stats.imported}.`,
    );
    console.log(`Пропущено: ${JSON.stringify(stats.skipped)}`);
    console.log(
      `По населённым пунктам: ${JSON.stringify(Object.fromEntries(sortedEntries(stats.byLocality)))}`,
    );
    console.log(`По категориям: ${JSON.stringify(Object.fromEntries(sortedEntries(stats.byCategory)))}`);
    console.log(
      `С телефоном ${stats.withPhone}, с сайтом (https) ${stats.withWebsite}, с графиком ${stats.withSchedule}, ` +
        `график не разобран ${stats.scheduleDropped}, с фото у Google ${stats.withPhotos}; ` +
        `закрытых навсегда в радиусе ${closedIds.length}, страниц пропущено (устаревший токен) ${stats.pagesFailed}.`,
    );
    console.log(
      `Типы Google без категории: ${JSON.stringify(Object.fromEntries(sortedEntries(stats.unmappedTypes)))}`,
    );
    console.log(`Демо-мест в seed (не трогаются импортом): ${SEED_PLACES.length}.`);
    if (stats.withoutAddressComponents)
      console.log(
        `ВНИМАНИЕ: у ${stats.withoutAddressComponents} мест нет addressComponents (ответы кэша до 04.11.2026) — пункт ` +
          "по расстоянию до центра. Для пункта по адресу Google — прогон с новым каталогом кэша (--cache).",
      );

    if (!args.dryRun) {
      const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
      if (!url) throw new ImportWriteError("Не задан DATABASE_URL (или DATABASE_MIGRATION_URL)");
      const db = createDatabase({ connectionString: url, maxConnections: 1 });
      try {
        const written = await writePlaces(db, args.region, places, new Date(), {
          closedIds,
          rejectedIds,
          seenIds,
          complete: !stats.limitReached && stats.pagesFailed === 0 && !args.searches.length,
          insertOnly: args.insertOnly,
        });
        report.write = written;
        console.log(
          `\nЗапись в регион ${args.region}: новых мест ${written.inserted}, обновлено ${written.updated}, ` +
            `интервалов графика ${written.schedulesWritten}, новых населённых пунктов ${written.localitiesCreated}, ` +
            `новых категорий ${written.categoriesCreated}; мест не из Google (seed/админка, не тронуты): ${written.manualPlaces}.`,
        );
        console.log(
          `Снято с публикации (закрыты навсегда): ${written.suspendedClosed}; графиков отклонено правилами: ` +
            `${written.schedulesRejected}; переразмечено ${written.recategorized}, в архив (не наши по новым правилам) ` +
            `${written.archivedRejected}; пропали из выдачи Google (только отчёт): ${written.missingFromGoogle ?? "не считалось — выгрузка неполная"}.`,
        );
        console.log(
          `Тегов добавлено (категория и удобства Google): ${written.tagsWritten}; кандидатов в архив (номера Booking): ` +
            `${stats.skipped.duplicate}, прочих дублей не записано: ${stats.duplicatesSkipped}.`,
        );
        if (storage) {
          const ids = await googlePlaceIds(db, written.regionId);
          const photos = await importPhotos(
            db,
            client,
            storage,
            written.regionId,
            photoCandidates(places, written.insertedIds, args.insertOnly),
            ids,
            console.log,
          );
          report.photos = photos;
          console.log(
            `Фото (${storage.driver.driver}): добавлено ${photos.added}, отклонено ${photos.rejected}, ошибок ${photos.failed}` +
              `${photos.limitReached ? " (остановлено лимитом запросов)" : ""}.`,
          );
        }
      } finally {
        await db.destroy();
      }
    }

    report.requests = { ...client.requests, total: client.totalRequests, cacheHits: client.cacheHits };
    console.log(
      `\nЗапросов к Google: ${client.totalRequests} (${JSON.stringify(client.requests)}), из кэша: ${client.cacheHits}.`,
    );
    if (args.report) {
      await mkdir(path.dirname(args.report), { recursive: true });
      await writeFile(
        args.report,
        JSON.stringify(
          {
            ...report,
            places: places.map((p) => ({ name: p.name, category: p.categoryCode, locality: p.localityCode })),
          },
          null,
          2,
        ),
      );
      console.log(`Отчёт: ${args.report}`);
    }
  }
} catch (err) {
  console.error(
    err instanceof ImportArgsError || err instanceof ImportWriteError || err instanceof TargetedQueryError
      ? err.message
      : err,
  );
  process.exitCode = 1;
}

/** Точечный импорт по списку запросов: выгрузка, план (что найдено/не найдено), запись без --dry-run. */
async function runTargeted(
  args: ReturnType<typeof parseImportArgs>,
  client: GooglePlacesClient,
  storage: ReturnType<typeof createStorage> | undefined,
): Promise<void> {
  const known = {
    categories: new Set(Object.keys(CATEGORY_NAMES)),
    localities: new Set(ALL_LOCALITIES.map((l) => l.code)),
  };
  const queries: TargetedQuery[] = [
    ...(args.queriesFile ? await readTargetedQueries(args.queriesFile, known) : []),
    ...(args.queries.length ? parseTargetedQueries(args.queries.map(parseQueryFlag), known) : []),
  ];
  const { places, outcomes, queriesDone, limitReached } = await collectTargeted(
    client,
    queries,
    CATEGORY_NAMES,
    console.log,
  );
  const missing = outcomes.filter((o) => !o.found.length);
  console.log(
    `
Точечный импорт: запросов ${queriesDone}/${queries.length}${limitReached ? " (остановлено лимитом)" : ""}; ` +
      `мест к импорту ${places.length}; без результата: ${missing.map((o) => `«${o.query}»`).join(", ") || "нет"}.`,
  );
  const report: Record<string, unknown> = { outcomes };
  if (!args.dryRun) {
    const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
    if (!url) throw new ImportWriteError("Не задан DATABASE_URL (или DATABASE_MIGRATION_URL)");
    const db = createDatabase({ connectionString: url, maxConnections: 1 });
    try {
      // Без closedIds/rejectedIds/seenIds: точечный прогон не снимает с публикации и не архивирует другие места.
      const written = await writePlaces(db, args.region, places, new Date(), {
        localities: ALL_LOCALITIES,
        pinCategory: true,
        insertOnly: args.insertOnly,
      });
      report.write = written;
      console.log(
        `Запись в регион ${args.region}: новых мест ${written.inserted}, обновлено (уже были по google place id) ` +
          `${written.updated}, новых населённых пунктов ${written.localitiesCreated}, новых категорий ${written.categoriesCreated}.`,
      );
      // Реальный статус: место уже было и его скрыла/архивировала админка или прошлый прогон — «обновлено» мало.
      for (const n of written.notPublished)
        console.log(`  не опубликовано: ${n.name} (${n.googlePlaceId}) — статус ${n.status}`);
      if (storage) {
        const ids = await googlePlaceIds(db, written.regionId);
        const photos = await importPhotos(
          db,
          client,
          storage,
          written.regionId,
          photoCandidates(places, written.insertedIds, args.insertOnly),
          ids,
          console.log,
        );
        report.photos = photos;
        console.log(
          `Фото: добавлено ${photos.added}, отклонено ${photos.rejected}, ошибок ${photos.failed}.`,
        );
      }
    } finally {
      await db.destroy();
    }
  }
  report.requests = { ...client.requests, total: client.totalRequests, cacheHits: client.cacheHits };
  console.log(`Запросов к Google: ${client.totalRequests}, из кэша: ${client.cacheHits}.`);
  if (args.report) {
    await mkdir(path.dirname(args.report), { recursive: true });
    await writeFile(args.report, JSON.stringify(report, null, 2));
    console.log(`Отчёт: ${args.report}`);
  }
}
