// CLI удобств мест проживания «Де жити» (фильтр удобств в Mini App):
//   pnpm --filter @tg/api places:amenities -- --plan                                       — оценка без запросов
//   pnpm --filter @tg/api places:amenities -- --out amenities.jsonl --limit 10             — проба без записи в БД
//   pnpm --filter @tg/api places:amenities -- --out amenities.jsonl --max-usd 3 --write    — запись
// Места — опубликованные в разделе stay (hotels, sadyby). Удобства: структурированные Google (place_enrichments.google.
// amenities — теги source import) плюс извлечение моделью из отзывов и описания Google (source reviews, в карточке —
// «за відгуками Google»): только удобства на территории с дословной цитатой; цитату программа перепроверяет (есть в
// тексте Google, есть слово удобства, нет отрицания и «поруч»). Модель — claude-sonnet-5-5 (как ИИ-текст карточки),
// ключ ANTHROPIC_API_KEY (SDK читает сам). Модель спрашивается только по местам, где в текстах Google есть ключевые
// слова удобств, и только по этим текстам.
// --out обязателен (кроме --plan): каждый ответ модели сразу дописывается в журнал JSONL; повторный запуск с тем же
// --out не оплачивает готовое (и --write после пробы не спрашивает модель заново). --max-usd (по умолчанию $3) —
// лимит на весь журнал. --limit — сколько мест максимум спросить у модели в этот запуск. Без --write в БД ничего не
// пишется: сводка и CSV (<out>.csv). --write — одна транзакция в контексте региона, аудит place.amenities на место;
// места, где теги правили люди (админка), не трогаются. Нужна миграция 0029 (place_tags.source).
// БД — DATABASE_URL (роль приложения), иначе DATABASE_MIGRATION_URL.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createDatabase, type Db } from "../db/index.js";
import {
  AMENITIES_MODEL,
  AMENITY_CODES,
  planCost,
  sumUsage,
  type AmenityCode,
} from "../places-amenities/amenities.js";
import { AmenitiesArgsError, parseAmenitiesArgs } from "../places-amenities/args.js";
import {
  openAmenityJournal,
  planTasks,
  readAmenityJournal,
  readyResults,
  resultsOf,
  runExtraction,
  type AmenityRecord,
} from "../places-amenities/run.js";
import { applyChanges, loadLodging, planChanges } from "../places-amenities/store.js";

/** Скрытые повторы SDK (429/5xx, обрыв до ответа) — не оплачиваются. */
const SDK_MAX_RETRIES = 4;

const csvCell = (v: string | number | null | undefined) => {
  const s = String(v ?? "");
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

let db: Db | undefined;

async function main(): Promise<void> {
  const args = parseAmenitiesArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
  if (!url) throw new AmenitiesArgsError("Нужен DATABASE_URL (места читаются из БД)");
  db = createDatabase({ connectionString: url, maxConnections: 2 });
  const state = await loadLodging(db, args.region);
  if (args.write && !state.hasSourceColumn)
    throw new AmenitiesArgsError("Нет столбца place_tags.source — сначала миграция 0029 (db:migrate)");
  const journalFile = args.out ? args.out.replace(/\.jsonl?$/i, "") + ".jsonl" : null;
  const prior = journalFile ? await readAmenityJournal(journalFile) : { records: [], broken: 0 };
  if (prior.broken) console.log(`В журнале ${journalFile} пропущено битых строк: ${prior.broken}.`);
  const spentBefore = sumUsage(prior.records.map((r) => r.usage)).costUsd;
  const tasks = planTasks(state.places, readyResults(prior.records), { limit: args.limit, only: args.only });
  const count = (k: string) => tasks.filter((t) => t.ai === k).length;
  console.log(
    `Регион ${args.region}: опубликованных мест «Де жити» ${state.places.length} (с ручными тегами ${state.places.filter((p) => p.touched).length}); ` +
      `режим: ${args.plan ? "оценка (--plan)" : args.write ? "запись (--write)" : "без записи"}.\n` +
      `Модели спросим: ${count("ask")}; без текстов с ключевыми словами ${count("no_keywords")}, готово в журнале ${count("journal")}, ` +
      `уже применено ${count("applied")}, отложено лимитом ${count("limit")}. По журналу потрачено ≈ $${spentBefore.toFixed(2)} ` +
      `из $${args.maxUsd}.`,
  );

  if (args.plan) {
    const asks = tasks.filter((t) => t.ai === "ask" || t.ai === "limit");
    const est = planCost(asks.map((t) => ({ name: t.place.name, sources: t.sources })));
    const hits = Object.fromEntries(
      AMENITY_CODES.map((c) => [c, asks.filter((t) => t.hits.includes(c)).length]),
    );
    console.log(
      `Оценка без запросов (ориентир, не замер): мест ${asks.length}, вход ≈ ${est.input} ток., вывод ≈ ${est.output} ток., ` +
        `≈ $${est.costUsd.toFixed(2)} (${AMENITIES_MODEL}, без кэша).\nКлючевые слова по удобствам: ${JSON.stringify(hits)}.`,
    );
    return;
  }

  let fresh: AmenityRecord[] = [];
  if (count("ask")) {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new AmenitiesArgsError("Нужен ANTHROPIC_API_KEY");
    if (spentBefore >= args.maxUsd)
      console.log(`Лимит --max-usd $${args.maxUsd} уже исчерпан журналом — новых запросов не будет.`);
    const client = new Anthropic({ maxRetries: SDK_MAX_RETRIES });
    const run = await runExtraction({
      tasks,
      api: client.messages,
      concurrency: args.concurrency,
      maxUsd: args.maxUsd,
      spentBefore,
      append: await openAmenityJournal(journalFile!),
      log: (line) => console.log(line),
    });
    fresh = run.records;
    const u = run.usage;
    console.log(
      `Запросов ${u.requests}, ошибок ${fresh.filter((r) => r.status === "error").length}; токенов ${u.input} вх. ` +
        `(кэш: запись ${u.cacheWrite}, чтение ${u.cacheRead}) / ${u.output} вых. Этот запуск ≈ $${u.costUsd.toFixed(2)}, ` +
        `всего по журналу ≈ $${(spentBefore + u.costUsd).toFixed(2)}.` +
        (run.stoppedBy === "budget"
          ? ` Лимит достигнут, не спрошено ${run.notStarted} — продолжить: тот же --out, больший --max-usd.`
          : "") +
        (run.stoppedBy === "journal" ? " Журнал перестал писаться — запуск остановлен." : ""),
    );
    if (run.stoppedBy === "journal") process.exitCode = 1;
  }

  const results = resultsOf(tasks, fresh);
  const { changes, skippedTouched } = planChanges(state.places, results);

  // Сводка: сколько мест с удобством по источникам и сколько находок модели отброшено проверкой.
  const allRecords = [...tasks.flatMap((t) => (t.journal ? [t.journal] : [])), ...fresh];
  const byCode = Object.fromEntries(
    AMENITY_CODES.map((c) => [
      c,
      {
        google: results.filter((r) => r.structured.includes(c)).length,
        reviews: results.filter((r) => !r.structured.includes(c) && r.reviews?.some((f) => f.code === c))
          .length,
      },
    ]),
  );
  const rejected: Record<string, number> = {};
  for (const r of allRecords) for (const x of r.rejected) rejected[x.reason] = (rejected[x.reason] ?? 0) + 1;
  const adds = changes.flatMap((c) => c.add);
  console.log(
    `Удобства по местам (google — структурированные, reviews — только по отзывам):\n` +
      AMENITY_CODES.map((c) => `  ${c}: google ${byCode[c]!.google}, reviews ${byCode[c]!.reviews}`).join(
        "\n",
      ) +
      `\nОтброшено проверкой находок модели: ${JSON.stringify(rejected)}.\n` +
      `План: мест с изменениями ${changes.filter((c) => c.add.length || c.upgrade.length || c.remove.length).length}, ` +
      `добавить тегов ${adds.length} (import ${adds.filter((a) => a.source === "import").length}, reviews ` +
      `${adds.filter((a) => a.source === "reviews").length}), сменить источник ${changes.reduce((n, c) => n + c.upgrade.length, 0)}, ` +
      `снять ${changes.reduce((n, c) => n + c.remove.length, 0)}; пропущено мест с ручными тегами ${skippedTouched.length}.`,
  );

  // CSV: строка на удобство места (итог) и на отброшенную находку — для выборочной проверки точности.
  const csvFile = args.csv ?? journalFile!.replace(/\.jsonl$/i, ".csv");
  const recByPlace = new Map(allRecords.map((r) => [r.placeId, r]));
  const head = ["place_id", "name", "category", "amenity", "source", "status", "evidence"];
  const rows: string[][] = [];
  for (const r of results) {
    const p = state.places.find((x) => x.id === r.placeId)!;
    const change = changes.find((c) => c.placeId === r.placeId);
    const add = (code: AmenityCode, source: string, evidence = "") => {
      const status = p.touched
        ? "ручные теги — пропуск"
        : change?.add.some((a) => a.code === code)
          ? "добавить"
          : p.tags.has(code)
            ? "уже есть"
            : "—";
      rows.push([p.id, p.name, p.category, code, source, status, evidence]);
    };
    for (const c of r.structured) add(c, "google");
    for (const f of r.reviews ?? []) if (!r.structured.includes(f.code)) add(f.code, "reviews", f.evidence);
    for (const c of change?.remove ?? []) rows.push([p.id, p.name, p.category, c, "reviews", "снять", ""]);
    for (const x of recByPlace.get(r.placeId)?.rejected ?? [])
      rows.push([p.id, p.name, p.category, x.code, "reviews", `отброшено: ${x.reason}`, x.evidence]);
  }
  await mkdir(path.dirname(path.resolve(csvFile)), { recursive: true });
  await writeFile(csvFile, `\uFEFF${[head, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n")}\r\n`);
  console.log(`CSV: ${csvFile}${journalFile ? `, журнал: ${journalFile}` : ""}`);

  if (!args.write) return;
  const stats = await applyChanges(db, state.regionId, changes, { model: AMENITIES_MODEL });
  console.log(
    `Запись в ${args.region}: создано тегов ${stats.tagsCreated.length ? stats.tagsCreated.join(", ") : "0"}; ` +
      `связей добавлено ${stats.added}, источник сменён ${stats.upgraded}, снято ${stats.removed}; аудит ${stats.audited}; ` +
      `пропущено (теги поправили во время прогона) ${stats.skippedTouched}.`,
  );
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db?.destroy();
}
