// Журнал прогона (JSONL): каждый готовый результат сразу дописывается строкой — убийство процесса не теряет оплаченное.
// При запуске журнал читается: готовые коды пропускаются, деньги прошлых запусков входят в лимит --max-usd. Оборванная
// последняя строка (процесс убит посреди записи) пропускается, следующая запись начинается с новой строки.
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { addUsage, emptyUsage, type CriticRound, type Usage } from "./generate.js";
import type { ScenarioDraft } from "./validate.js";

/** ok — есть черновик; rejected — модель ответила, проверка не прошла; error — исключение при обработке заказа. */
export type GenStatus = "ok" | "rejected" | "error";

export type GenRecord = {
  code: string;
  region: string;
  status: GenStatus;
  draft: ScenarioDraft | null;
  errors: string[];
  fixes: string[];
  attempts: number;
  critic: CriticRound[];
  /** Фактическая модель итогового черновика (может быть запасной). */
  model: string | null;
  /** Токены и деньги этого заказа, включая критика и повторы. */
  usage: Usage;
  at: string;
};

/** Из --out: журнал <имя>.jsonl и итоговый отчёт (--out x.json и --out x.jsonl дают одну и ту же пару x.jsonl + x.json). */
export function runPaths(out: string): { journal: string; report: string } {
  const stem = out.replace(/\.jsonl?$/i, "");
  return { journal: `${stem}.jsonl`, report: /\.jsonl$/i.test(out) ? `${stem}.json` : out };
}

/** Строки журнала; битые не роняют чтение, а считаются. */
export function parseJournal(text: string): { records: GenRecord[]; broken: number } {
  const records: GenRecord[] = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Partial<GenRecord> | null;
      if (typeof v?.code !== "string") throw new Error("не запись журнала");
      records.push({
        region: "",
        status: v.draft ? "ok" : "rejected",
        draft: null,
        errors: [],
        fixes: [],
        attempts: 0,
        critic: [],
        model: null,
        at: "",
        ...v,
        code: v.code,
        usage: { ...emptyUsage(), ...v.usage },
      });
    } catch {
      broken++;
    }
  }
  return { records, broken };
}

/** Журнал прогона: чтение прошлых записей и запись новых по одной (порядок записи — порядок вызовов). */
export async function readJournal(file: string): Promise<{ records: GenRecord[]; broken: number }> {
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  return parseJournal(text);
}

export async function openJournal(file: string): Promise<(r: GenRecord) => Promise<void>> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  // Хвост без перевода строки — запись оборвана: новая запись не должна склеиться с ней.
  const text = await readFile(file, "utf8").catch(() => "");
  if (text && !text.endsWith("\n")) await appendFile(file, "\n");
  let tail: Promise<unknown> = Promise.resolve();
  return (r) => {
    const write = tail.then(async () => {
      const fh = await open(file, "a");
      try {
        await fh.appendFile(`${JSON.stringify(r)}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
    });
    tail = write.catch(() => undefined);
    return write;
  };
}

/** Последняя запись по каждому коду (повторный прогон упавшего кода заменяет прежнюю). */
export function latestByCode(records: readonly GenRecord[]): GenRecord[] {
  return [...new Map(records.map((r) => [r.code, r])).values()];
}

/** Коды, которые второй раз не генерируем: с черновиком, а при skipFailed — и упавшие. */
export function readyCodes(records: readonly GenRecord[], skipFailed: boolean): Set<string> {
  return new Set(
    latestByCode(records)
      .filter((r) => r.draft || skipFailed)
      .map((r) => r.code),
  );
}

/** Сумма по всем записям: деньги потрачены и на заменённые записи. */
export function totalUsage(records: readonly GenRecord[]): Usage {
  const total = emptyUsage();
  for (const r of records) addUsage(total, r.usage);
  return total;
}

/**
 * --from-file: итоговый файл ({ scenarios: […] }) или журнал JSONL (черновики последних записей по кодам).
 * files.broken — сколько строк журнала не прочитано.
 */
export function parseScenariosFile(text: string): { scenarios: unknown[]; broken: number } {
  try {
    const v = JSON.parse(text) as { scenarios?: unknown } | null;
    if (v && typeof v === "object" && "scenarios" in v)
      return { scenarios: Array.isArray(v.scenarios) ? (v.scenarios as unknown[]) : [], broken: 0 };
  } catch {
    // Не один JSON — значит, журнал.
  }
  const { records, broken } = parseJournal(text);
  return { scenarios: latestByCode(records).flatMap((r) => (r.draft ? [r.draft] : [])), broken };
}
