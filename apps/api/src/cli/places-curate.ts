// CLI чистки мест по ручной разметке аудита категорий:
//   pnpm --filter @tg/api places:curate -- --findings <curated_findings.csv> [--decisions <decisions.csv>]
//     [--issues <issues_auto.csv>] [--todo-out <low_confidence_todo.csv>] [--report <report.json>]
//     [--region test-region] [--dry-run]
// Файлы аудита — вне репозитория (репозиторий публичный), путь передаётся аргументом. Применяются строки с
// уверенностью «высокая»/«средняя» и однозначным исправлением; остальные и неоднозначные — в --todo-out.
// --dry-run выполняет всё в транзакции и откатывает её (план = результат). Запись — под DATABASE_URL (роль
// приложения, контекст региона), иначе DATABASE_MIGRATION_URL; одна транзакция, аудит place.curate по месту.
import { readFile, writeFile } from "node:fs/promises";
import { createDatabase, type Db } from "../db/index.js";
import { curatePlaces, type TodoItem } from "../places-curate/apply.js";
import { CurateInputError, parseCsv, parseDecisions, parseFindings } from "../places-curate/rules.js";

type Args = {
  findings: string;
  decisions?: string;
  issues?: string;
  todoOut?: string;
  report?: string;
  region: string;
  dryRun: boolean;
};

function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = { region: "test-region", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new CurateInputError(`${a}: нужно значение`);
      return v;
    };
    if (a === "--") continue;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--findings") out.findings = value();
    else if (a === "--decisions") out.decisions = value();
    else if (a === "--issues") out.issues = value();
    else if (a === "--todo-out") out.todoOut = value();
    else if (a === "--report") out.report = value();
    else if (a === "--region") out.region = value();
    else throw new CurateInputError(`Неизвестный аргумент ${a}`);
  }
  if (!out.findings) throw new CurateInputError("Нужен --findings <curated_findings.csv>");
  return out as Args;
}

const csvCell = (v: string | number | null | undefined) => {
  const s = String(v ?? "");
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function todoCsv(items: readonly TodoItem[]): string {
  const head = [
    "строка",
    "раздел",
    "место",
    "id",
    "пункт",
    "проблема",
    "исправление",
    "уверенность",
    "причина",
  ];
  const rows = items.map((t) =>
    [
      t.line,
      t.finding?.section ?? "",
      t.name,
      t.id,
      t.finding?.locality ?? "",
      t.finding?.problem ?? "",
      t.finding?.fix ?? "",
      t.finding?.confidence ?? "",
      t.reason,
    ]
      .map(csvCell)
      .join(";"),
  );
  return `\uFEFF${[head.join(";"), ...rows].join("\r\n")}\r\n`;
}

let db: Db | undefined;
try {
  const args = parseArgs(process.argv.slice(2));
  const findings = parseFindings(await readFile(args.findings, "utf8"));
  const decisions = args.decisions ? parseDecisions(await readFile(args.decisions, "utf8")) : [];
  const issues = args.issues ? parseCsv(await readFile(args.issues, "utf8")) : [];
  const localityIssueIds = issues.filter((r) => (r.issue ?? "").startsWith("Пункт")).map((r) => r.id ?? "");
  const bars = issues.filter((r) => r.sec === "cafes" && /^Бар\/паб/.test(r.issue ?? ""));
  console.log(
    `Разметка: ${findings.length} строк, решений: ${decisions.length}, пункт по адресу: ${localityIssueIds.length}; ` +
      `режим: ${args.dryRun ? "без записи (--dry-run, откат)" : `запись в ${args.region}`}`,
  );

  const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_MIGRATION_URL?.trim();
  if (!url) throw new CurateInputError("Не задан DATABASE_URL (или DATABASE_MIGRATION_URL)");
  db = createDatabase({ connectionString: url, maxConnections: 1 });
  const report = await curatePlaces(db, {
    regionCode: args.region,
    findings,
    decisions,
    localityIssueIds,
    dryRun: args.dryRun,
  });

  console.log(`\nИзменено мест: ${report.changedPlaces}`);
  console.log(`По действиям: ${JSON.stringify(report.counts)}`);
  console.log("Переносы категорий:");
  for (const [k, v] of Object.entries(report.moves).sort((a, b) => b[1] - a[1])) console.log(`  ${v}\t${k}`);
  console.log(
    `Слияний: ${report.merges.length} (Booking ${report.merges.filter((m) => m.kind === "booking").length})`,
  );
  console.log(`Перенесено ссылок: ${JSON.stringify(report.movedRefs)}`);
  for (const l of report.leftRefs) console.log(`  осталось на дубле ${l.dup}: ${l.table} ×${l.count}`);
  for (const n of report.bookingNotes) console.log(`  Booking: ${n}`);
  for (const s of report.archivedInScenarios)
    console.log(`  в архиве, но в сценариях: ${s.name} (${s.id}) — пунктов ${s.items}`);
  console.log(`Не применено (в todo): ${report.todo.length}`);
  console.log(
    `Опубликованных с суффиксом номера Booking: ${report.publishedRoomSuffix.before} → ${report.publishedRoomSuffix.after}`,
  );
  console.log("Опубликованных по категориям (до → после):");
  const cats = new Set([
    ...Object.keys(report.publishedByCategory.before),
    ...Object.keys(report.publishedByCategory.after),
  ]);
  for (const c of [...cats].sort()) {
    const b = report.publishedByCategory.before[c] ?? 0;
    const a = report.publishedByCategory.after[c] ?? 0;
    console.log(`  ${c}: ${b} → ${a}${a !== b ? ` (${a - b > 0 ? "+" : ""}${a - b})` : ""}`);
  }
  const notPeaks = report.peaksCheck.filter((p) => p.category !== "peaks" || p.status !== "published");
  console.log(`Вершины: в peaks ${report.peaksCheck.length - notPeaks.length}/${report.peaksCheck.length}`);
  for (const p of notPeaks) console.log(`  не в peaks/не опубл.: ${p.name} — ${p.category}, ${p.status}`);
  if (bars.length) {
    console.log(`Бары/кальянные в cafes (категории bars нет — не перенесены): ${bars.length}`);
    for (const b of bars) console.log(`  ${b.id}\t${b.name}`);
  }
  if (args.todoOut) {
    await writeFile(args.todoOut, todoCsv(report.todo));
    console.log(`Не применено: ${args.todoOut}`);
  }
  if (args.report) {
    await writeFile(args.report, JSON.stringify({ ...report, bars }, null, 2));
    console.log(`Отчёт: ${args.report}`);
  }
} catch (e) {
  if (e instanceof CurateInputError) console.error(e.message);
  else console.error(e);
  process.exitCode = 1;
} finally {
  await db?.destroy();
}
