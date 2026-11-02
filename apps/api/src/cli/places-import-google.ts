// CLI импорта настоящих мест из Google Maps (Places API (New)) — README apps/api, «Импорт мест из Google»:
//   pnpm --filter @tg/api places:import-google -- --dry-run [--cache <каталог>] [--max-requests 1000] [--report f.json]
//   pnpm --filter @tg/api places:import-google -- --region test-region [--photos]
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
import { importPhotos } from "../places-import/photos.js";
import { CATEGORY_NAMES, googlePlaceIds, ImportWriteError, writePlaces } from "../places-import/writer.js";
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
  });
  console.log(`Кэш ответов Google: ${args.cacheDir}; лимит запросов: ${args.maxRequests}`);
  const { places, stats, closedIds, seenIds } = await collect(client, {
    categoryNames: CATEGORY_NAMES,
    log: console.log,
  });
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

  if (!args.dryRun) {
    const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
    if (!url) throw new ImportWriteError("Не задан DATABASE_URL (или DATABASE_MIGRATION_URL)");
    const db = createDatabase({ connectionString: url, maxConnections: 1 });
    try {
      const written = await writePlaces(db, args.region, places, new Date(), {
        closedIds,
        seenIds,
        complete: !stats.limitReached && stats.pagesFailed === 0,
      });
      report.write = written;
      console.log(
        `\nЗапись в регион ${args.region}: новых мест ${written.inserted}, обновлено ${written.updated}, ` +
          `интервалов графика ${written.schedulesWritten}, новых населённых пунктов ${written.localitiesCreated}, ` +
          `новых категорий ${written.categoriesCreated}; мест не из Google (seed/админка, не тронуты): ${written.manualPlaces}.`,
      );
      console.log(
        `Снято с публикации (закрыты навсегда): ${written.suspendedClosed}; графиков отклонено правилами: ` +
          `${written.schedulesRejected}; пропали из выдачи Google (только отчёт): ${written.missingFromGoogle ?? "не считалось — выгрузка неполная"}.`,
      );
      if (storage) {
        const ids = await googlePlaceIds(db, written.regionId);
        const photos = await importPhotos(db, client, storage, written.regionId, places, ids, console.log);
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
} catch (err) {
  console.error(err instanceof ImportArgsError || err instanceof ImportWriteError ? err.message : err);
  process.exitCode = 1;
}
