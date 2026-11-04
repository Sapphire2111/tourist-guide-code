// Разбор ручной разметки мест (аудит категорий) в действия CLI places:curate.
// Только чистые функции: CSV, классификация строки «исправление», базовое имя записи-номера Booking, населённый
// пункт из адреса Google. Данные аудита в репозиторий не кладутся — путь к файлам передаётся аргументами.

import type { LonLat } from "../db/index.js";
import { IMPORT_LOCALITIES, type ImportLocality } from "../places-import/config.js";
import { haversineMeters } from "../places-import/mapping.js";

/** Строка CSV как объект «заголовок → значение». */
export type CsvRow = Readonly<Record<string, string>>;

/**
 * CSV с разделителем `;` (Excel, UTF-8 с BOM): кавычки `"…"` с удвоением `""`, переводы строк внутри кавычек,
 * CRLF. Первая строка — заголовки. Пустые строки пропускаются.
 */
export function parseCsv(text: string, delimiter = ";"): CsvRow[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let i = 0;
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    if (record.some((f) => f !== "")) records.push(record);
    record = [];
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) endField();
    else if (ch === "\n") endRecord();
    else if (ch !== "\r") field += ch;
    i += 1;
  }
  if (field !== "" || record.length) endRecord();
  const [header, ...rows] = records;
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(names.map((n, k) => [n, (r[k] ?? "").trim()])));
}

/** Строка ручной разметки (curated_findings.csv). */
export type Finding = {
  /** Номер строки в файле (с заголовком — 1), для отчёта. */
  line: number;
  section: string;
  name: string;
  id: string;
  locality: string;
  problem: string;
  fix: string;
  confidence: string;
};

const FINDING_COLUMNS = {
  section: "раздел",
  name: "место",
  id: "id",
  locality: "пункт",
  problem: "проблема",
  fix: "исправление",
  confidence: "уверенность",
} as const;

export class CurateInputError extends Error {
  override readonly name = "CurateInputError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseFindings(text: string): Finding[] {
  const rows = parseCsv(text);
  const first = rows[0];
  if (first)
    for (const col of Object.values(FINDING_COLUMNS))
      if (!(col in first)) throw new CurateInputError(`В файле разметки нет колонки «${col}»`);
  return rows.map((r, k) => {
    const f: Finding = {
      line: k + 2,
      section: r[FINDING_COLUMNS.section]!,
      name: r[FINDING_COLUMNS.name]!,
      id: r[FINDING_COLUMNS.id]!.toLowerCase(),
      locality: r[FINDING_COLUMNS.locality]!,
      problem: r[FINDING_COLUMNS.problem]!,
      fix: r[FINDING_COLUMNS.fix]!,
      confidence: r[FINDING_COLUMNS.confidence]!.toLowerCase(),
    };
    if (!UUID.test(f.id)) throw new CurateInputError(`Строка ${f.line}: id не uuid — «${f.id}»`);
    return f;
  });
}

/** Решение по месту из файла решений (разбор неоднозначных строк вручную). */
export type Decision =
  | { kind: "move"; id: string; category: string; extras: string[]; note: string }
  | { kind: "archive"; id: string; note: string }
  | { kind: "merge"; id: string; mainId: string; note: string }
  | { kind: "rename"; id: string; name: string; note: string }
  | { kind: "describe"; id: string; description: string; note: string }
  | { kind: "locality"; id: string; locality: string; note: string }
  | { kind: "skip"; id: string; note: string };

export const DECISION_KINDS = ["move", "archive", "merge", "rename", "describe", "locality", "skip"] as const;

/**
 * Файл решений: `id;action;value;note`. action: move (value — `категория[+доп+доп]`), archive, merge (value — id
 * главной записи), rename / describe (value — текст uk), locality (value — код пункта), skip (в список «не
 * применено», value не нужен). У одного id может быть несколько решений; решения по id заменяют автоматический
 * разбор всех его строк разметки.
 */
export function parseDecisions(text: string): Decision[] {
  return parseCsv(text).map((r, k) => {
    const line = k + 2;
    const id = (r.id ?? "").toLowerCase();
    const action = r.action ?? "";
    const value = r.value ?? "";
    const note = r.note ?? "";
    if (!UUID.test(id)) throw new CurateInputError(`Решения, строка ${line}: id не uuid — «${id}»`);
    switch (action) {
      case "move": {
        const [category, ...extras] = value.split("+").map((s) => s.trim());
        if (!category) throw new CurateInputError(`Решения, строка ${line}: move без категории`);
        return { kind: "move", id, category, extras, note };
      }
      case "archive":
      case "skip":
        return { kind: action, id, note };
      case "merge":
        if (!UUID.test(value)) throw new CurateInputError(`Решения, строка ${line}: merge — value не uuid`);
        if (value.toLowerCase() === id)
          throw new CurateInputError(`Решения, строка ${line}: merge сам в себя`);
        return { kind: "merge", id, mainId: value.toLowerCase(), note };
      case "rename":
      case "describe":
        if (!value) throw new CurateInputError(`Решения, строка ${line}: ${action} без текста`);
        return action === "rename"
          ? { kind: "rename", id, name: value, note }
          : { kind: "describe", id, description: value, note };
      case "locality":
        if (!value) throw new CurateInputError(`Решения, строка ${line}: locality без кода`);
        return { kind: "locality", id, locality: value, note };
      default:
        throw new CurateInputError(`Решения, строка ${line}: неизвестное действие «${action}»`);
    }
  });
}

/** Что делать со строкой разметки по тексту «исправление» без ручного решения. */
export type FixAction =
  | { kind: "move"; category: string; extras: string[] }
  | { kind: "archive" }
  | { kind: "booking" }
  | { kind: "todo"; reason: string };

/** Применяются только высокая и средняя уверенность. */
export const APPLIED_CONFIDENCE: ReadonlySet<string> = new Set(["высокая", "средняя"]);

const CODE = "[a-z][a-z0-9-]*";
const MOVE_ONLY = new RegExp(`^→\\s*(${CODE})$`);
const MOVE_PLUS = new RegExp(`^→\\s*(${CODE})\\s*\\(\\+(${CODE})(?:\\s+для прокатов)?\\)$`);
const MOVE_EXTRA = new RegExp(`^→\\s*(${CODE})\\s*\\((${CODE})\\s+—\\s+доп\\.\\s*категория\\)$`);
const MOVE_PAIR = new RegExp(`^→\\s*(${CODE})\\s*/\\s*(${CODE})$`);
/** Название проката — для «(+gear-rental для прокатов)». */
const RENTAL_NAME = /прокат|оренд|rental/i;
/** «переименовать/уточнить … или архив»: переименовать без данных нельзя, остаётся архив (только высокая). */
const RENAME_OR_ARCHIVE = /^(переименовать|уточнить)[^→]*?(\s+или\s+|\s*\/\s*)архив$/;

/**
 * Автоматический разбор «исправления». Однозначные формы: «архив…» (архив — первый вариант), «→ код»,
 * «→ код (+код)», «→ код (код — доп. категория)», «→ код / код» (основная / дополнительная), свёртка записей
 * Booking. «переименовать/уточнить или архив» — архив только при высокой уверенности (названия из данных не
 * взять). Всё остальное («или», «проверить», «уточнить», слияния без указания главной записи) — в список «не
 * применено», если нет ручного решения. Существование кодов категорий проверяет вызывающий.
 */
export function classifyFix(f: Pick<Finding, "fix" | "confidence" | "name">): FixAction {
  if (!APPLIED_CONFIDENCE.has(f.confidence)) return { kind: "todo", reason: `уверенность «${f.confidence}»` };
  const fix = f.fix.trim();
  if (/^слить в одно место на объект, суффикс убрать$/.test(fix)) return { kind: "booking" };
  if (/^архив(?!\p{L})/u.test(fix)) return { kind: "archive" };
  if (RENAME_OR_ARCHIVE.test(fix))
    return f.confidence === "высокая"
      ? { kind: "archive" }
      : { kind: "todo", reason: "нужно название (из данных не следует) или архив — средняя уверенность" };
  let m = MOVE_ONLY.exec(fix);
  if (m) return { kind: "move", category: m[1]!, extras: [] };
  m = MOVE_PLUS.exec(fix);
  if (m) {
    const conditional = fix.includes("для прокатов");
    return { kind: "move", category: m[1]!, extras: conditional && !RENTAL_NAME.test(f.name) ? [] : [m[2]!] };
  }
  m = MOVE_EXTRA.exec(fix) ?? MOVE_PAIR.exec(fix);
  if (m) return { kind: "move", category: m[1]!, extras: [m[2]!] };
  return { kind: "todo", reason: "неоднозначное исправление — нужно ручное решение" };
}

/** Суффикс типа номера Booking: « - Double Room», « - Two-Bedroom House», « - Vacation Home»… */
const BOOKING_SUFFIX = /^[a-z][a-z\s&-]*$/i;
const BOOKING_UNIT =
  /\b(room|house|villa|apartment|apartments|suite|studio|townhouse|chalet|cottage|home|bungalow|lodge|dormitory)\b/i;

/** Базовое имя записи-номера Booking (до последнего « - ») или null, если суффикса типа номера нет. */
export function bookingBaseName(name: string): string | null {
  const trimmed = name.trim();
  const at = trimmed.lastIndexOf(" - ");
  if (at < 0) return null;
  const suffix = trimmed.slice(at + 3).trim();
  if (!BOOKING_SUFFIX.test(suffix) || !BOOKING_UNIT.test(suffix)) return null;
  return trimmed.slice(0, at).trim() || null;
}

/** Нормализация имени для сравнения: регистр, кавычки, апострофы, пробелы. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[«»"“”„'‘’ʼʹ`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Написания населённых пунктов в адресах Google → код пункта. Яремче намеренно нет: это и город, и громада —
 * в адресе Google «Яремче» часто стоит у мест Поляниці, Яблуниці, Микуличина (неоднозначно).
 */
const LOCALITY_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(с\.?\s*|село\s+)?(микуличин|mykulychyn)$/i, "mykulychyn"],
  [/^(с\.?\s*|село\s+)?(татарів|tatariv)$/i, "tatariv"],
  [/^(смт\.?\s*|с\.?\s*|селище\s+)?(ворохта|vorokhta)$/i, "vorokhta"],
  [/^(с\.?\s*|село\s+)?(яблуниця|яблуница|яблониця|яблоница|yablunytsia|yablunytsya)$/i, "yablunytsia"],
  [/^(с\.?\s*|село\s+)?(поляниця|поляница|polianytsia|polyanytsia|буковель|bukovel)$/i, "polianytsia"],
];

/**
 * Населённый пункт по адресу Google: последний сегмент адреса через запятую, не номер/индекс. Код — только если
 * сегмент целиком совпадает с написанием пункта (кроме Яремче) и (при заданной точке) точка не дальше 2 радиусов
 * пункта от его центра, иначе null.
 */
export function localityFromAddress(
  address: string | null | undefined,
  at?: LonLat | null,
  localities: readonly ImportLocality[] = IMPORT_LOCALITIES,
): string | null {
  const code = townFromAddress(address);
  if (!code || !at) return code;
  // Как в импорте: адрес Google бывает ошибочным — пункт принимается, только если точка не дальше 2 его радиусов.
  const l = localities.find((x) => x.code === code);
  return l && haversineMeters(at, l.at) <= 2 * l.radiusM ? code : null;
}

/** Пункт по последнему сегменту адреса Google (без проверки расстояния). */
export function townFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !/^[\d\s-]+$/.test(s));
  const last = parts
    .at(-1)
    ?.replace(/\s+\d{5}$/, "")
    .trim();
  if (!last) return null;
  for (const [re, code] of LOCALITY_ALIASES) if (re.test(last)) return code;
  return null;
}
