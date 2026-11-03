// CLI генерации сценариев «Мій план» через Claude:
//   pnpm --filter @tg/api scenarios:generate -- --dry-run --count 10 --out scenarios.json   — без записи, JSON в файл
//   pnpm --filter @tg/api scenarios:generate -- --count 150 --out scenarios.json            — запись черновиками
//   pnpm --filter @tg/api scenarios:generate -- --from-file scenarios.json [--publish]      — запись готового файла
// Сценарии — ТОЛЬКО из опубликованных мест каталога (они из Google Maps): модель получает список кандидатов, каждый
// пункт проверяется программой (место из списка, длительность, дорога, график, сезон, аудитория). Недостающие места
// задания (Говерла, Хом'як…) не выдумываются — в отчёт. Модель — claude-sonnet-5-5, ключ ANTHROPIC_API_KEY (SDK читает
// сам); БД — DATABASE_URL (роль приложения, контекст региона), иначе DATABASE_MIGRATION_URL. Запись — черновиками,
// --publish — опубликованными; нужна миграция 0025 (scenarios.seasons), иначе запись не начинается.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createDatabase, type Db } from "../db/index.js";
import { GenArgsError, parseGenArgs } from "../scenarios-gen/args.js";
import { allBriefs, WANTED_AREAS, type Brief } from "../scenarios-gen/briefs.js";
import { selectCandidates, type CandidateSet } from "../scenarios-gen/candidates.js";
import { loadCatalog } from "../scenarios-gen/catalog.js";
import { generateOne, pool, usd, type GenOutcome, type Usage } from "../scenarios-gen/generate.js";
import { wantedReport } from "../scenarios-gen/missing.js";
import { GEN_MODEL, SYSTEM_PROMPT, userPrompt } from "../scenarios-gen/prompt.js";
import type { ScenarioDraft } from "../scenarios-gen/validate.js";
import { ScenariosWriteError, writeDrafts } from "../scenarios-gen/writer.js";

let db: Db | undefined;
try {
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

  const usage: Usage = { input: 0, output: 0, requests: 0 };
  let drafts: ScenarioDraft[];
  const report: Record<string, unknown> = {
    model: GEN_MODEL,
    region: args.region,
    wanted,
    missing,
    missingAreas,
  };

  if (args.fromFile) {
    const file = JSON.parse(await readFile(args.fromFile, "utf8")) as { scenarios?: ScenarioDraft[] };
    drafts = file.scenarios ?? [];
    console.log(`Из файла ${args.fromFile}: сценариев ${drafts.length} (без запросов к модели).`);
  } else {
    // Заказы: по кругу тем, без уже записанных кодов, только те, что собираются из каталога.
    const skipped: { code: string; reason: string }[] = [];
    const chosen: { brief: Brief; set: CandidateSet }[] = [];
    for (const brief of allBriefs()) {
      if (chosen.length >= args.count) break;
      if (args.themes.size && !args.themes.has(brief.theme.code)) continue;
      if (args.areas.size && !args.areas.has(brief.area)) continue;
      if (catalog.existingCodes.has(brief.code)) {
        skipped.push({ code: brief.code, reason: "уже есть в БД" });
        continue;
      }
      const set = selectCandidates(brief, catalog);
      if (!set.viable) {
        skipped.push({ code: brief.code, reason: set.reason ?? "не собрать" });
        continue;
      }
      chosen.push({ brief, set });
    }
    report.skipped = skipped;
    console.log(
      `Заказов: ${chosen.length} (пропущено ${skipped.length}); запросов параллельно ${args.concurrency}.`,
    );
    if (args.plan) {
      // Оценка без запросов (замер прогона 03.11.2026: кириллица ~1,5 символа на токен, ответ ~600 токенов).
      const chars = chosen.map((c) => (SYSTEM_PROMPT + userPrompt(c.brief, c.set)).length);
      const input = Math.round(chars.reduce((a, b) => a + b, 0) / 1.5);
      const est = { input, output: chosen.length * 700, requests: chosen.length };
      console.log(`Оценка: ≈ ${est.input} вх. / ${est.output} вых. токенов ≈ ${usd(est)} (без повторов).`);
      for (const s of skipped.filter((x) => x.reason !== "уже есть в БД"))
        console.log(`  пропуск ${s.code}: ${s.reason}`);
      for (const c of chosen) console.log(`  ${c.brief.code}: кандидатов ${c.set.candidates.length}`);
      if (args.out) {
        const sample = chosen[0];
        await writeFile(
          args.out,
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
      process.exit(0);
    }
    if (chosen.length && !process.env.ANTHROPIC_API_KEY?.trim())
      throw new GenArgsError("Нужен ANTHROPIC_API_KEY");
    const client = new Anthropic();
    let done = 0;
    const outcomes: GenOutcome[] = await pool(chosen, args.concurrency, async ({ brief, set }) => {
      const r = await generateOne(client.messages, brief, set, usage, { retries: args.retries });
      done++;
      console.log(
        `[${done}/${chosen.length}] ${brief.code}: ${r.draft ? `ок (${r.draft.items.length} пунктов, попыток ${r.attempts})` : `отброшен — ${r.errors.slice(0, 2).join("; ")}`}`,
      );
      return r;
    });
    drafts = outcomes.flatMap((o) => (o.draft ? [o.draft] : []));
    report.failed = outcomes.filter((o) => !o.draft).map((o) => ({ code: o.code, errors: o.errors }));
    report.fixes = Object.fromEntries(outcomes.filter((o) => o.fixes.length).map((o) => [o.code, o.fixes]));
    report.candidates = Object.fromEntries(chosen.map((c) => [c.brief.code, c.set.candidates.length]));
  }
  report.usage = { ...usage, usd: usd(usage) };
  report.scenarios = drafts;
  console.log(
    `Сценариев прошло проверку: ${drafts.length}. Запросов ${usage.requests}, токенов ${usage.input} вх. / ` +
      `${usage.output} вых. ≈ $${usd(usage)}.`,
  );

  if (args.out) {
    await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await writeFile(args.out, JSON.stringify(report, null, 2));
    console.log(`Отчёт: ${args.out}`);
  }

  if (!args.dryRun) {
    const stats = await writeDrafts(db, catalog.regionId, drafts, { publish: args.publish });
    console.log(
      `Запись в ${args.region}: записано ${stats.written} (${args.publish ? "опубликованы" : "черновики"}), ` +
        `уже были ${stats.existing}, пропущено из-за снятых мест ${stats.placeUnavailable.length}.`,
    );
  }
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
