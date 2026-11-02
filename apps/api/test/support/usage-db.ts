// Unit-тесты учёта запросов Google: recordingDb с имитацией google_api_usage (условный INSERT … ON CONFLICT).
import { expect } from "vitest";
import { recordingDb, type Respond } from "./recording-db.js";

/** usage — строки google_api_usage («день|вид» → count): общие между экземплярами сервиса, как после рестарта. */
export function usageDb(usage: Map<string, number>, opts: { fails?: boolean; extra?: Respond } = {}) {
  return recordingDb({}, (q) => {
    const p = q.parameters as unknown[];
    if (q.sql.startsWith('insert into "google_api_usage"')) {
      if (opts.fails) throw new Error("db down");
      // INSERT (day, kind, 1) ON CONFLICT … WHERE count < $limit RETURNING count: исчерпан — строки нет.
      expect(q.sql).toContain('"google_api_usage"."count" < $');
      const key = `${String(p[0])}|${String(p[1])}`;
      const n = usage.get(key) ?? 0;
      if (n >= Number(p[3])) return [];
      usage.set(key, n + 1);
      return [{ count: n + 1 }];
    }
    if (q.sql.startsWith('update "google_api_usage"')) {
      const key = [...usage.keys()].find((k) => k.endsWith("_month"));
      if (key) usage.set(key, Math.max(0, usage.get(key)! - 1));
      return { rows: [], numAffectedRows: 1n };
    }
    if (q.sql.startsWith('select "kind", "count" from "google_api_usage"'))
      return [...usage.entries()].map(([k, count]) => ({ kind: k.split("|")[1], count }));
    return opts.extra ? opts.extra(q) : [];
  });
}
