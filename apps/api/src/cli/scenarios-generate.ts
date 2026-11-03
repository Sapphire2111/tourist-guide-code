// CLI генерации сценариев «Мій план» через Claude:
//   pnpm --filter @tg/api scenarios:generate -- --plan --count 200 --out run.json                — оценка без запросов
//   pnpm --filter @tg/api scenarios:generate -- --dry-run --count 10 --max-usd 5 --out run.json  — без записи в БД
//   pnpm --filter @tg/api scenarios:generate -- --count 150 --max-usd 60 --out run.json          — запись черновиками
//   pnpm --filter @tg/api scenarios:generate -- --from-file run.jsonl [--publish]                — запись готового файла
// Сценарии — ТОЛЬКО из опубликованных мест каталога (они из Google Maps): модель получает список кандидатов, каждый
// пункт проверяется программой (место из списка, длительность, дорога, график, сезон, аудитория). Недостающие места
// задания (Говерла, Хом'як…) не выдумываются — в отчёт. Модель — claude-opus-5-5 (при отказе — запасная на стороне API),
// ключ ANTHROPIC_API_KEY (SDK читает сам); БД — DATABASE_URL (роль приложения, контекст региона), иначе
// DATABASE_MIGRATION_URL. Запись — черновиками, --publish — опубликованными; нужна миграция 0025 (scenarios.seasons),
// иначе запись не начинается.
// --out обязателен при генерации: каждый готовый результат сразу дописывается в журнал <имя>.jsonl, повторный запуск с
// тем же --out пропускает готовые коды (упавшие повторяет, --skip-failed — нет). --max-usd — лимит на весь журнал:
// новые заказы не берутся, идущие дорабатывают (поэтому итог может превысить лимит на стоимость идущих заказов).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createDatabase, type Db } from "../db/index.js";
import { GenArgsError, parseGenArgs } from "../scenarios-gen/args.js";
import { allBriefs, AREAS, targetBriefs, WANTED_AREAS } from "../scenarios-gen/briefs.js";
import { selectCandidates } from "../scenarios-gen/candidates.js";
import { loadCatalog } from "../scenarios-gen/catalog.js";
import { generateOne, usd } from "../scenarios-gen/generate.js";
import {
  latestByCode,
  openJournal,
  parseScenariosFile,
  readJournal,
  readyCodes,
  runPaths,
  totalUsage,
} from "../scenarios-gen/journal.js";
import { wantedReport } from "../scenarios-gen/missing.js";
import { GEN_MODEL, GEN_SDK_MAX_RETRIES, userPrompt } from "../scenarios-gen/prompt.js";
import { chooseOrders, planEstimate, runOrders, summarize } from "../scenarios-gen/run.js";
import { checkDraft, type ScenarioDraft } from "../scenarios-gen/validate.js";
import { ScenariosWriteError, writeDrafts } from "../scenarios-gen/writer.js";

let db: Db | undefined;

async function main(): Promise<void> {
  const args = parseGenArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
  if (!url) throw new GenArgsError("Нужен DATABASE_URL (каталог мест читается из БД)");
  db = createDatabase({ connectionString: url, maxConnections: 2 });
  const catalog = await loadCatalog(db, args.region);
  console.log(
    `Регион ${args.region}: опубликованных мест ${catalog.places.length}, сценариев уже ${catalog.existingCodes.size}; ` +
      `режим: ${args.dryRun ? "без записи (--dry-run)" : args.publish ? "запись опубликованными" : "запись черновиками"}.`,
  );

  const wanted = wantedReport(catalog);
  const missing = wanted.filter((w) => w.found.length === 0).map((w) => w.name);
  const missingAreas = Object.values(WANTED_AREAS);
  console.log(`Нет в каталоге (не выдумываем): ${[...missing, ...missingAreas].join("; ") || "—"}.`);

  let drafts: ScenarioDraft[];
  let failedExit = false;
  const report: Record<string, unknown> = {
    requestedModel: GEN_MODEL,
    region: args.region,
    wanted,
    missing,
    missingAreas,
  };
  const paths = args.out ? runPaths(args.out) : null;

  if (args.fromFile) {
    const file = parseScenariosFile(await readFile(args.fromFile, "utf8"));
    if (file.broken) console.log(`В файле ${args.fromFile} не прочитано строк: ${file.broken}.`);
    // Файл могли поправить руками — та же проверка программой; невалидные — в отчёт, не в БД.
    const byId = new Map(catalog.places.map((p) => [p.id, p]));
    const rejected: { code: string; errors: string[] }[] = [];
    drafts = file.scenarios.filter((d): d is ScenarioDraft => {
      const errors = checkDraft(d, byId);
      if (errors.length) rejected.push({ code: String((d as { code?: unknown } | null)?.code), errors });
      return errors.length === 0;
    });
    report.rejected = rejected;
    console.log(
      `Из файла ${args.fromFile}: сценариев ${file.scenarios.length}, прошли проверку ${drafts.length} (без запросов к модели).`,
    );
    for (const r of rejected) console.log(`  пропуск ${r.code}: ${r.errors.slice(0, 3).join("; ")}`);
  } else {
    // Журнал прошлых запусков: готовые коды не генерируем, их деньги входят в --max-usd.
    const prior = paths ? await readJournal(paths.journal) : { records: [], broken: 0 };
    if (prior.broken) console.log(`В журнале ${paths?.journal} пропущено битых строк: ${prior.broken}.`);
    const foreign = prior.records.find((r) => r.region && r.region !== args.region);
    if (foreign)
      throw new GenArgsError(
        `Журнал ${paths?.journal} — другого региона (${foreign.region}), укажите другой --out`,
      );
    const { chosen, skipped, resumed } = chooseOrders(
      allBriefs(AREAS, targetBriefs(catalog.places)),
      catalog,
      args,
      readyCodes(prior.records, args.skipFailed),
    );
    report.skipped = skipped;
    const spentBefore = totalUsage(prior.records).costUsd;
    console.log(
      `Заказов: ${chosen.length} (пропущено ${skipped.length}, уже в журнале ${resumed}, ` +
        `по журналу потрачено ≈ $${usd({ costUsd: spentBefore })}); запросов параллельно ${args.concurrency}.`,
    );
    if (args.plan) {
      const est = planEstimate(chosen, args.criticRounds);
      console.log(
        `Оценка без запросов (НЕ замер — уточните пилотом):\n` +
          `  нижняя граница ≈ $${usd(est.lowerBound)}: по одному запросу на заказ, без размышления и критика;\n` +
          `  ориентир ≈ $${usd(est.guess)}: ${est.guess.requests} запросов (генерация и раундов критика ${args.criticRounds}), ` +
          `объём размышления — предположение, без кэша и повторов.`,
      );
      for (const s of skipped.filter((x) => x.reason !== "уже есть в БД"))
        console.log(`  пропуск ${s.code}: ${s.reason}`);
      for (const c of chosen) console.log(`  ${c.brief.code}: кандидатов ${c.set.candidates.length}`);
      if (paths) {
        const sample = chosen[0];
        await writeFile(
          paths.report,
          JSON.stringify(
            {
              ...report,
              skipped,
              estimate: est,
              samplePrompt: sample ? userPrompt(sample.brief, sample.set) : null,
            },
            null,
            2,
          ),
        );
      }
      return; // соединение с БД закрывает finally
    }
    if (!paths) throw new GenArgsError("Нужен --out"); // parseGenArgs уже проверил; сужение типа
    if (chosen.length && !process.env.ANTHROPIC_API_KEY?.trim())
      throw new GenArgsError("Нужен ANTHROPIC_API_KEY");
    const client = new Anthropic({ maxRetries: GEN_SDK_MAX_RETRIES });
    // Разнообразие: сколько раз место уже взято в готовые сценарии прогона — штраф при подборе следующих.
    const usedCounts = new Map<string, number>();
    const countUsed = (draft: ScenarioDraft | null) => {
      for (const i of draft?.items ?? []) usedCounts.set(i.placeId, (usedCounts.get(i.placeId) ?? 0) + 1);
    };
    for (const r of latestByCode(prior.records)) countUsed(r.draft);
    const run = await runOrders({
      orders: chosen,
      region: args.region,
      concurrency: args.concurrency,
      maxUsd: args.maxUsd,
      spentBefore,
      append: await openJournal(paths.journal),
      log: (line) => console.log(line),
      generate: async ({ brief, set }, usage) => {
        const fresh = selectCandidates(brief, catalog, usedCounts);
        const r = await generateOne(client.beta.messages, brief, fresh.viable ? fresh : set, usage, {
          retries: args.retries,
          criticRounds: args.criticRounds,
        });
        countUsed(r.draft);
        return r;
      },
    });
    if (run.stoppedBy === "journal") failedExit = true;
    const records = [...prior.records, ...run.records];
    const latest = latestByCode(records);
    const sum = summarize(records);
    report.critic = Object.fromEntries(latest.filter((o) => o.critic.length).map((o) => [o.code, o.critic]));
    report.reuse = [...usedCounts.entries()]
      .filter(([, n]) => n > 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([id, n]) => ({ place: catalog.places.find((p) => p.id === id)?.name ?? id, scenarios: n }));
    drafts = latest.flatMap((o) => (o.draft ? [o.draft] : []));
    report.failed = latest.filter((o) => !o.draft).map((o) => ({ code: o.code, errors: o.errors }));
    report.fixes = Object.fromEntries(latest.filter((o) => o.fixes.length).map((o) => [o.code, o.fixes]));
    report.candidates = Object.fromEntries(chosen.map((c) => [c.brief.code, c.set.candidates.length]));
    report.scenarioModels = Object.fromEntries(latest.flatMap((o) => (o.model ? [[o.code, o.model]] : [])));
    report.models = sum.models;
    report.usage = { ...sum.usage, usd: usd(sum.usage) };
    report.usageThisRun = { ...run.usage, usd: usd(run.usage) };
    report.usdPerScenario = sum.usdPerScenario;
    report.criticErrors = sum.criticErrors;
    report.maxUsd = args.maxUsd;
    report.stoppedBy = run.stoppedBy;
    report.notStarted = run.notStarted;
    const u = sum.usage;
    console.log(
      `Сценариев прошло проверку: ${sum.ok}, отброшено ${sum.failed}. Запросов ${u.requests} (без ответа ${u.failedRequests}), ` +
        `токенов ${u.input} вх. (+ кэш: запись ${u.cacheWrite}, чтение ${u.cacheRead}) / ${u.output} вых.\n` +
        `Потрачено ≈ $${usd(u)} (этот запуск ≈ $${usd(run.usage)})` +
        `${args.maxUsd === null ? "" : ` при лимите $${args.maxUsd}`}; остаток заказов ${run.notStarted.length}; ` +
        `средняя цена за сценарий ${sum.usdPerScenario === null ? "—" : `≈ $${sum.usdPerScenario}`}.\n` +
        `Критик: правок ${sum.criticFixes}, сбоев ${sum.criticErrors}. stop_reason=max_tokens: генерация ${u.maxTokensGen}, ` +
        `критик ${u.maxTokensCritic}. Отказов ${u.refusals}, ответов запасной модели ${u.fallbacks}. ` +
        `Модели: ${JSON.stringify(u.servedBy)}.`,
    );
    if (u.interrupted)
      console.log(
        `Оборвалось потоков: ${u.interrupted} — их вывод неизвестен, фактическая сумма выше посчитанной.`,
      );
    if (run.stoppedBy === "budget")
      console.log(
        "Лимит --max-usd достигнут: новые заказы не брались. Продолжить — тот же --out и больший лимит.",
      );
  }
  report.scenarios = drafts;

  if (paths) {
    await mkdir(path.dirname(path.resolve(paths.report)), { recursive: true });
    await writeFile(paths.report, JSON.stringify(report, null, 2));
    console.log(`Отчёт: ${paths.report}${args.fromFile ? "" : `, журнал: ${paths.journal}`}`);
  }

  if (!args.dryRun) {
    const stats = await writeDrafts(db, catalog.regionId, drafts, { publish: args.publish });
    console.log(
      `Запись в ${args.region}: записано ${stats.written} (${args.publish ? "опубликованы" : "черновики"}), ` +
        `уже были ${stats.existing}, пропущено из-за снятых мест ${stats.placeUnavailable.length}, ` +
        `ошибок ${stats.failed.length}.`,
    );
    for (const f of stats.failed) console.error(`  ошибка записи ${f.code}: ${f.error}`);
    if (stats.failed.length) failedExit = true;
  }
  if (failedExit) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(
    err instanceof GenArgsError || err instanceof ScenariosWriteError
      ? err.message
      : err instanceof Error
        ? err.message
        : err,
  );
  process.exitCode = 1;
} finally {
  await db?.destroy();
}
