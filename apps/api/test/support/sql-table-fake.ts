// Таблица в памяти для unit-тестов поверх recordingDb (без БД): выполняет простые запросы Kysely к одной таблице
// так, как их компилирует PostgresQueryCompiler после TenantGuardPlugin. Поддерживается только то, что пишут
// репозитории админки: INSERT одной строки (с ON CONFLICT (col) DO NOTHING), SELECT * / UPDATE … SET / DELETE с
// условиями `"col" = $n` и `"col" < $n`, соединёнными AND (в том числе `"t"."region_id" = $n` от плагина),
// ORDER BY и LIMIT. Записи аудита (audit_logs, audit_log_pii) складываются в `audit`.
// Изоляция здесь — не проверка RLS (это integration-тесты), а исполнение фильтра, который подставил плагин:
// регион-админ чужую строку не получает ровно потому, что в SQL есть `region_id = :регион`.
import { randomUUID } from "node:crypto";
import type { CompiledQuery } from "kysely";
import type { Respond } from "./recording-db.js";

type Row = Record<string, unknown>;

export type TableFakeOptions = {
  table: string;
  /** Значения по умолчанию колонок, не переданных в INSERT (как DEFAULT в миграции). */
  defaults?: () => Row;
  /** Колонка уникальности для ON CONFLICT (col) DO NOTHING — проверяется по всем строкам, без учёта региона. */
  unique?: string;
};

const CONDITION = /(?:"\w+"\.)?"(\w+)" (=|<) \$(\d+)/g;

function conditions(where: string, params: readonly unknown[]): ((row: Row) => boolean)[] {
  return [...where.matchAll(CONDITION)].map(([, col, op, n]) => {
    const value = params[Number(n) - 1];
    return op === "=" ? (row: Row) => row[col!] === value : (row: Row) => String(row[col!]) < String(value);
  });
}

function between(sql: string, from: string, to: string): string {
  const start = sql.indexOf(from);
  if (start < 0) return "";
  const rest = sql.slice(start + from.length);
  const end = to ? rest.indexOf(to) : -1;
  return end < 0 ? rest : rest.slice(0, end);
}

export class SqlTableFake {
  readonly rows = new Map<string, Row>();
  readonly audit: Row[] = [];
  readonly queries: CompiledQuery[] = [];

  constructor(private readonly opts: TableFakeOptions) {}

  /** Строка напрямую (как seed/другой регион). */
  put(row: Row): Row {
    const full = { ...this.opts.defaults?.(), id: randomUUID(), ...row };
    this.rows.set(full.id as string, full);
    return full;
  }

  /** Обработчик recordingDb. */
  readonly respond: Respond = (q) => {
    this.queries.push(q);
    const t = `"${this.opts.table}"`;
    const p = q.parameters as unknown[];
    if (q.sql.startsWith('insert into "audit_logs"') || q.sql.startsWith('insert into "audit_log_pii"')) {
      const cols = between(q.sql, "(", ") values")
        .split(", ")
        .map((c) => c.replace(/"/g, ""));
      const row: Row = { id: randomUUID(), created_at: new Date() };
      cols.forEach((c, i) => (row[c] = p[i]));
      if (q.sql.startsWith('insert into "audit_logs"')) this.audit.push(row);
      return [row];
    }
    if (q.sql.startsWith(`insert into ${t}`)) {
      const cols = between(q.sql, `${t} (`, ") values")
        .split(", ")
        .map((c) => c.replace(/"/g, ""));
      const row: Row = {
        ...this.opts.defaults?.(),
        id: randomUUID(),
        created_at: new Date(),
        updated_at: new Date(),
      };
      cols.forEach((c, i) => (row[c] = p[i]));
      const u = this.opts.unique;
      if (u && q.sql.includes("on conflict") && [...this.rows.values()].some((r) => r[u] === row[u]))
        return [];
      this.rows.set(row.id as string, row);
      return [{ ...row }];
    }
    if (q.sql.startsWith(`select * from ${t}`)) {
      const where = between(q.sql, " where ", " order by ") || between(q.sql, " where ", " limit ");
      const conds = conditions(where, p);
      let out = [...this.rows.values()].filter((r) => conds.every((c) => c(r)));
      if (q.sql.includes('order by "id" desc')) out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
      else if (q.sql.includes('order by "sort_order"'))
        out.sort(
          (a, b) => Number(a.sort_order) - Number(b.sort_order) || String(a.id).localeCompare(String(b.id)),
        );
      const limit = /limit \$(\d+)/.exec(q.sql);
      if (limit) out = out.slice(0, Number(p[Number(limit[1]) - 1]));
      return out.map((r) => ({ ...r }));
    }
    if (q.sql.startsWith(`update ${t} set `)) {
      const sets = between(q.sql, " set ", " where ")
        .split(", ")
        .map((s) => s.split(" = ")[0]!.replace(/"/g, ""));
      const conds = conditions(between(q.sql, " where ", " returning"), p);
      const out: Row[] = [];
      for (const r of this.rows.values())
        if (conds.every((c) => c(r))) {
          sets.forEach((c, i) => (r[c] = p[i]));
          r.updated_at = new Date();
          out.push({ ...r });
        }
      return out;
    }
    if (q.sql.startsWith(`delete from ${t}`)) {
      const conds = conditions(between(q.sql, " where ", " returning"), p);
      const out: Row[] = [];
      for (const [id, r] of this.rows)
        if (conds.every((c) => c(r))) {
          this.rows.delete(id);
          out.push({ ...r });
        }
      return out;
    }
    return [];
  };

  /** Запросы к таблице (без set_config и аудита). */
  tableQueries(): CompiledQuery[] {
    return this.queries.filter((q) => q.sql.includes(`"${this.opts.table}"`));
  }
}
