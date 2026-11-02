// Таблицы в памяти для unit-тестов с recordingDb: отвечает на простые запросы Kysely так, как их компилирует
// PostgresQueryCompiler (с фильтрами, которые добавил TenantGuardPlugin). Поддерживается ровно то, что нужно
// тестам каталога: SELECT/UPDATE/DELETE с условиями `col = $n` и `col in ($n, …)` через AND, INNER JOIN по id,
// INSERT … VALUES (значения — только параметры $n), count(*). Сортировка и LIMIT не вычисляются.
// Строго: оператор, который фейк не вычисляет (<, >, <>, LIKE/ILIKE, IS [NOT] NULL, OR, NOT, подзапрос, EXISTS), и
// условие по колонке, которой нет в строке таблицы, — ошибка, а не тихо неверный ответ. Такие сценарии — в
// integration-тестах на реальной PostgreSQL.
import { randomUUID } from "node:crypto";
import type { CompiledQuery } from "kysely";
import type { RespondResult } from "./recording-db.js";

export type MemRow = Record<string, unknown>;
export type MemTables = Record<string, MemRow[]>;

/** Часть WHERE (до ORDER BY / LIMIT / FOR UPDATE / RETURNING). */
function wherePart(sql: string): string {
  const i = sql.search(/ where /i);
  if (i < 0) return "";
  const rest = sql.slice(i + 7);
  const end = rest.search(/ order by | limit | for update| for share| returning /i);
  return end < 0 ? rest : rest.slice(0, end);
}

const UNSUPPORTED = /( < | > | <> | <= | >= | i?like | is null| is not null| or | not |\(select |exists)/i;

type Cond = { col: string; values: unknown[] };

/** Условия `col = $n` и `col in ($n, …)`; всё прочее в WHERE — ошибка. */
function conditions(sql: string, params: readonly unknown[]): Cond[] {
  const where = wherePart(sql);
  const bad = UNSUPPORTED.exec(where);
  if (bad) throw new Error(`memory-sql: оператор «${bad[1]!.trim()}» не поддерживается: ${sql}`);
  const conds: Cond[] = [];
  for (const m of where.matchAll(/(?:"\w+"\.)?"(\w+)" = \$(\d+)/g))
    conds.push({ col: m[1]!, values: [params[Number(m[2]) - 1]] });
  for (const m of where.matchAll(/(?:"\w+"\.)?"(\w+)" in \((\$\d+(?:, \$\d+)*)\)/g))
    conds.push({ col: m[1]!, values: m[2]!.split(", ").map((ref) => params[Number(ref.slice(1)) - 1]) });
  return conds;
}

function matches(row: MemRow, conds: readonly Cond[], sql: string): boolean {
  return conds.every(({ col, values }) => {
    if (!(col in row)) throw new Error(`memory-sql: в строке нет колонки «${col}» (условие WHERE): ${sql}`);
    return values.includes(row[col]);
  });
}

/** `inner join "t2" on "t2"."id" = "t1"."col"`: к строке t1 добавляются колонки строки t2 (без перезаписи). */
function joined(sql: string, tables: MemTables, rows: MemRow[]): MemRow[] {
  // TenantGuardPlugin берёт условие ON в скобки и добавляет region_id.
  const j = /inner join "(\w+)" on \(?"\1"\."id" = "\w+"\."(\w+)"/i.exec(sql);
  if (!j) {
    if (/ join /i.test(sql)) throw new Error(`memory-sql: такой JOIN не поддерживается: ${sql}`);
    return rows;
  }
  return rows.flatMap((r) => {
    const other = (tables[j[1]!] ?? []).find((o) => o.id === r[j[2]!]);
    return other ? [{ ...other, ...r }] : [];
  });
}

const tableOf = (sql: string, re: RegExp) => re.exec(sql)?.[1];

export function memorySql(tables: MemTables, defaults: Record<string, MemRow> = {}) {
  return (q: CompiledQuery): RespondResult => {
    const sql = q.sql;
    const p = q.parameters as unknown[];
    if (/^select set_config/i.test(sql)) return [{}];
    if (/^insert into/i.test(sql)) {
      if (/ on conflict /i.test(sql)) throw new Error(`memory-sql: ON CONFLICT не поддерживается: ${sql}`);
      const table = tableOf(sql, /^insert into "(\w+)"/i)!;
      const cols = /\(([^)]*)\) values/i
        .exec(sql)![1]!
        .split(",")
        .map((c) => c.trim().replace(/"/g, ""));
      const tuples = [...sql.slice(sql.toLowerCase().indexOf(" values ")).matchAll(/\(([^)]*)\)/g)];
      const out: MemRow[] = [];
      for (const t of tuples) {
        const refs = t[1]!.split(",").map((s) => s.trim());
        const row: MemRow = {
          id: randomUUID(),
          created_at: new Date("2026-11-02T10:00:00Z"),
          updated_at: new Date("2026-11-02T10:00:00Z"),
          ...defaults[table],
        };
        cols.forEach((c, i) => {
          const m = /^\$(\d+)$/.exec(refs[i] ?? "");
          if (!m) throw new Error(`memory-sql: значение INSERT не параметр (${refs[i]}): ${sql}`);
          row[c] = p[Number(m[1]) - 1];
        });
        (tables[table] ??= []).push(row);
        out.push({ ...row });
      }
      return { rows: out, numAffectedRows: BigInt(out.length) };
    }
    if (/^update/i.test(sql)) {
      const table = tableOf(sql, /^update "(\w+)"/i)!;
      const setPart = sql.slice(sql.indexOf(" set ") + 5, sql.search(/ where /i));
      const sets = [...setPart.matchAll(/"(\w+)" = \$(\d+)/g)].map(
        (m) => [m[1]!, p[Number(m[2]) - 1]] as const,
      );
      const conds = conditions(sql, p);
      const hit = (tables[table] ?? []).filter((r) => matches(r, conds, sql));
      for (const r of hit) for (const [c, v] of sets) r[c] = v;
      return { rows: hit.map((r) => ({ ...r })), numAffectedRows: BigInt(hit.length) };
    }
    if (/^delete from/i.test(sql)) {
      const table = tableOf(sql, /^delete from "(\w+)"/i)!;
      const conds = conditions(sql, p);
      const rows = tables[table] ?? [];
      const hit = rows.filter((r) => matches(r, conds, sql));
      tables[table] = rows.filter((r) => !hit.includes(r));
      return { rows: [], numAffectedRows: BigInt(hit.length) };
    }
    if (/^select/i.test(sql)) {
      const table = tableOf(sql, / from "(\w+)"/i);
      if (!table) throw new Error(`memory-sql: SELECT без таблицы не поддерживается: ${sql}`);
      const conds = conditions(sql, p);
      const hit = joined(sql, tables, tables[table] ?? []).filter((r) => matches(r, conds, sql));
      if (/count\(\*\)/i.test(sql)) return [{ n: String(hit.length) }];
      if (/max\(/i.test(sql)) throw new Error(`memory-sql: max() не поддерживается: ${sql}`);
      return hit.map((r) => ({ ...r }));
    }
    throw new Error(`memory-sql: запрос не поддерживается: ${sql}`);
  };
}
