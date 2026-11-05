// Прогон извлечения: какие места спрашивать у модели (есть ключевые слова, нет готового результата в журнале или в
// аудите), запрос с проверкой ответа, журнал JSONL (каждый оплаченный ответ дописывается сразу — повторный запуск с
// тем же --out его не оплачивает), лимит расходов на весь журнал. Модель подменяется в тестах.
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import {
  addApiUsage,
  AMENITIES_MODEL,
  emptyAmenitiesUsage,
  ExtractionParseError,
  inputHash,
  parseExtraction,
  relevantSources,
  requestParams,
  responseText,
  structuredAmenities,
  sumUsage,
  type AmenitiesUsage,
  type AmenityCode,
  type Finding,
  type Rejected,
  type Source,
} from "./amenities.js";
import type { AmenityResult, LodgingPlace } from "./store.js";

export type AmenityRecord = {
  placeId: string;
  name: string;
  hash: string;
  status: "ok" | "error";
  accepted: Finding[];
  rejected: Rejected[];
  error: string | null;
  /** Фактическая модель ответа. */
  model: string | null;
  usage: AmenitiesUsage;
  at: string;
};

/** Журнал: битые строки (оборванная запись) пропускаются и считаются. */
export function parseAmenityJournal(text: string): { records: AmenityRecord[]; broken: number } {
  const records: AmenityRecord[] = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Partial<AmenityRecord> | null;
      if (typeof v?.placeId !== "string" || typeof v.hash !== "string") throw new Error("не запись журнала");
      records.push({
        name: "",
        status: "error",
        accepted: [],
        rejected: [],
        error: null,
        model: null,
        at: "",
        ...v,
        placeId: v.placeId,
        hash: v.hash,
        usage: { ...emptyAmenitiesUsage(), ...v.usage },
      });
    } catch {
      broken++;
    }
  }
  return { records, broken };
}

export async function readAmenityJournal(
  file: string,
): Promise<{ records: AmenityRecord[]; broken: number }> {
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  return parseAmenityJournal(text);
}

/**
 * Дозапись журнала по одной строке с fsync (как журнал scenarios:generate): оборванный хвост прошлого запуска
 * отделяется переводом строки, записи идут в порядке вызовов.
 */
export async function openAmenityJournal(file: string): Promise<(r: AmenityRecord) => Promise<void>> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
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

/** Пул из concurrency воркеров; shouldStop — новые задачи не берутся (идущие дорабатывают). */
async function pool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (x: T) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !shouldStop()) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

/** Готовые ответы журнала: место + хэш входа → последняя успешная запись. */
export function readyResults(records: readonly AmenityRecord[]): Map<string, AmenityRecord> {
  const out = new Map<string, AmenityRecord>();
  for (const r of records) if (r.status === "ok") out.set(`${r.placeId}|${r.hash}`, r);
  return out;
}

export type PlaceTask = {
  place: LodgingPlace;
  structured: AmenityCode[];
  sources: Source[];
  hits: AmenityCode[];
  hash: string | null;
  /** Почему модель не спрашиваем: нет текстов с ключевыми словами, готово в журнале, применено (аудит), лимит. */
  ai: "ask" | "no_keywords" | "journal" | "applied" | "limit";
  journal?: AmenityRecord;
};

/**
 * Задачи по местам. limit — сколько мест максимум отправить модели в этот запуск (остальные с ключевыми словами —
 * «limit»: их теги по отзывам не трогаются); места без текстов и готовые в журнале/аудите в лимит не входят.
 */
export function planTasks(
  places: readonly LodgingPlace[],
  ready: ReadonlyMap<string, AmenityRecord>,
  opts: { limit: number | null; only?: ReadonlySet<string> },
): PlaceTask[] {
  let asked = 0;
  const tasks: PlaceTask[] = [];
  for (const place of places) {
    if (opts.only?.size && !opts.only.has(place.id)) continue;
    const structured = structuredAmenities(place.google?.amenities ?? []);
    const { sources, hits } = relevantSources(place.google);
    const hash = sources.length ? inputHash(sources) : null;
    const base = { place, structured, sources, hits, hash };
    if (!hash) {
      tasks.push({ ...base, ai: "no_keywords" });
      continue;
    }
    const journal = ready.get(`${place.id}|${hash}`);
    if (journal) tasks.push({ ...base, ai: "journal", journal });
    else if (place.appliedHash === hash) tasks.push({ ...base, ai: "applied" });
    else if (opts.limit !== null && asked >= opts.limit) tasks.push({ ...base, ai: "limit" });
    else {
      asked++;
      tasks.push({ ...base, ai: "ask" });
    }
  }
  return tasks;
}

/** Часть клиента Anthropic, нужная прогону (подменяется в тестах). */
export type CreateApi = Pick<Anthropic["messages"], "create">;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Один запрос к модели и проверка ответа; ошибка — запись со status error (деньги учтены, если ответ был). */
export async function extractOne(api: CreateApi, task: PlaceTask): Promise<AmenityRecord> {
  const usage = emptyAmenitiesUsage();
  const base = {
    placeId: task.place.id,
    name: task.place.name,
    hash: task.hash!,
    usage,
    at: new Date().toISOString(),
  };
  try {
    const res = (await api.create(requestParams(task.place.name, task.sources))) as Anthropic.Message;
    addApiUsage(usage, res.usage);
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens")
      return {
        ...base,
        status: "error",
        accepted: [],
        rejected: [],
        error: `stop_reason=${res.stop_reason}`,
        model: res.model,
      };
    const { accepted, rejected } = parseExtraction(responseText(res.content), task.sources);
    return { ...base, status: "ok", accepted, rejected, error: null, model: res.model };
  } catch (err) {
    return {
      ...base,
      status: "error",
      accepted: [],
      rejected: [],
      error: err instanceof ExtractionParseError ? `ответ: ${err.message}` : message(err),
      model: null,
    };
  }
}

export type RunOutcome = {
  records: AmenityRecord[];
  usage: AmenitiesUsage;
  stoppedBy: "budget" | "journal" | null;
  notStarted: number;
};

export async function runExtraction(opts: {
  tasks: readonly PlaceTask[];
  api: CreateApi;
  concurrency: number;
  maxUsd: number;
  spentBefore: number;
  append: (r: AmenityRecord) => Promise<void>;
  log: (line: string) => void;
}): Promise<RunOutcome> {
  const asks = opts.tasks.filter((t) => t.ai === "ask");
  const records: AmenityRecord[] = [];
  const usages: AmenitiesUsage[] = [];
  let stoppedBy: RunOutcome["stoppedBy"] = null;
  let started = 0;
  const spent = () => opts.spentBefore + sumUsage(usages).costUsd;
  await pool(
    asks,
    opts.concurrency,
    async (task) => {
      started++;
      const r = await extractOne(opts.api, task);
      usages.push(r.usage);
      records.push(r);
      try {
        await opts.append(r);
      } catch (err) {
        stoppedBy = "journal";
        opts.log(`Журнал не пишется, новые запросы не делаем: ${message(err)}`);
      }
      opts.log(
        `[${records.length}/${asks.length}] ${r.name}: ` +
          (r.status === "ok"
            ? `${r.accepted.map((a) => a.code).join(", ") || "—"}${r.rejected.length ? ` (отброшено ${r.rejected.length})` : ""}`
            : `ошибка — ${r.error}`) +
          ` ≈ $${r.usage.costUsd.toFixed(4)}, всего ≈ $${spent().toFixed(2)}`,
      );
    },
    () => {
      if (!stoppedBy && spent() >= opts.maxUsd) stoppedBy = "budget";
      return stoppedBy !== null;
    },
  );
  return { records, usage: sumUsage(usages), stoppedBy, notStarted: asks.length - started };
}

/** Итог по месту для плана записи: находки по отзывам — из ответа этого запуска или журнала. */
export function resultsOf(tasks: readonly PlaceTask[], fresh: readonly AmenityRecord[]): AmenityResult[] {
  const byKey = new Map(fresh.filter((r) => r.status === "ok").map((r) => [`${r.placeId}|${r.hash}`, r]));
  return tasks.map((t) => {
    const rec = t.journal ?? (t.hash ? byKey.get(`${t.place.id}|${t.hash}`) : undefined);
    return {
      placeId: t.place.id,
      structured: t.structured,
      // Нет текстов с ключевыми словами — подтверждений по отзывам нет (старые теги reviews снимаются);
      // не спрашивали (лимит, сбой, уже применено) — теги reviews не трогаем.
      reviews: rec ? rec.accepted : t.ai === "no_keywords" ? [] : null,
      hash: rec ? rec.hash : null,
    };
  });
}

export { AMENITIES_MODEL };
