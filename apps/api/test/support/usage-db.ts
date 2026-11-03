// Unit-тесты учёта запросов Google: recordingDb с имитацией google_api_usage (условный INSERT … ON CONFLICT).
import { expect } from "vitest";
import { recordingDb, type Respond } from "./recording-db.js";

/** usage — строки google_api_usage («день|вид» → count): общие между экземплярами сервиса, как после рестарта. */
export function usageDb(usage: Map<string, number>, opts: { fails?: boolean; extra?: Respond } = {}) {
  return recordingDb({}, (q) => {
    const p = q.parameters as unknown[];
    if (q.sql.startsWith('insert into "google_api_usage"')) {
      if (opts.fails) throw new Error("db down");
      // INSERT (day, kind, units) ON CONFLICT … SET count + units WHERE count <= $limit − units RETURNING count:
      // исчерпан — строки нет.
      expect(q.sql).toContain('"google_api_usage"."count" <= $');
      const key = `${String(p[0])}|${String(p[1])}`;
      const units = Number(p[2]);
      const n = usage.get(key);
      if (n !== undefined && n > Number(p[4])) return [];
      usage.set(key, (n ?? 0) + units);
      return [{ count: (n ?? 0) + units }];
    }
    if (q.sql.startsWith('update "google_api_usage"')) {
      const key = [...usage.keys()].find((k) => k.endsWith("_month"));
      if (key) usage.set(key, Math.max(0, usage.get(key)! - Number(p[0])));
      return { rows: [], numAffectedRows: 1n };
    }
    if (q.sql.startsWith('select "kind", "count" from "google_api_usage"'))
      return [...usage.entries()].map(([k, count]) => ({ kind: k.split("|")[1], count }));
    return opts.extra ? opts.extra(q) : [];
  });
}
