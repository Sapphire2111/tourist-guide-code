import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checksum,
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  runMigrations,
  type SqlClient,
} from "./migrate.js";

/** Фейковый клиент: запоминает запросы; `applied` — уже применённые миграции (имя → sql). */
function fakeClient(applied: Record<string, string>, failOn?: RegExp) {
  const log: string[] = [];
  const client: SqlClient = {
    async query(sql) {
      log.push(sql);
      if (failOn?.test(sql)) throw new Error(`boom: ${sql.slice(0, 30)}`);
      if (sql.startsWith("SELECT name, checksum FROM schema_migrations"))
        return { rows: Object.entries(applied).map(([name, body]) => ({ name, checksum: checksum(body) })) };
      if (sql.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      return { rows: [] };
    },
  };
  return { client, log };
}

async function migrationsDir(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "tg-migrations-"));
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}

const body = (log: string[]) => log.filter((q) => q.startsWith("SQL") || q === "BEGIN" || q === "COMMIT");

describe("runMigrations", () => {
  it("применяет неприменённые .sql по порядку имён, каждую в транзакции", async () => {
    const dir = await migrationsDir({
      "0003_c.sql": "SQL C",
      "0001_a.sql": "SQL A",
      "0002_b.sql": "SQL B",
      "x.txt": "-",
    });
    const { client, log } = fakeClient({ "0002_b.sql": "SQL B" });

    expect(await runMigrations(client, dir)).toEqual(["0001_a.sql", "0003_c.sql"]);
    expect(body(log)).toEqual(["BEGIN", "SQL A", "COMMIT", "BEGIN", "SQL C", "COMMIT"]);
    expect(log.at(-1)).toContain("pg_advisory_unlock");
  });

  it("повторный запуск при всех применённых — no-op", async () => {
    const files = { "0001_a.sql": "SQL A", "0002_b.sql": "SQL B" };
    const dir = await migrationsDir(files);
    const { client, log } = fakeClient(files);

    expect(await runMigrations(client, dir)).toEqual([]);
    expect(body(log)).toEqual([]);
  });

  it("записывает контрольную сумму применённой миграции", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "SQL A" });
    const calls: unknown[][] = [];
    const { client } = fakeClient({});
    const query = client.query.bind(client);
    client.query = async (sql, params) => {
      if (sql.startsWith("INSERT INTO schema_migrations")) calls.push(params ?? []);
      return query(sql, params);
    };

    await runMigrations(client, dir);
    expect(calls).toEqual([["0001_a.sql", checksum("SQL A")]]);
  });

  it("изменённая после применения миграция — ошибка, ничего не применяется", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "SQL A (правка)", "0002_b.sql": "SQL B" });
    const { client, log } = fakeClient({ "0001_a.sql": "SQL A" });

    await expect(runMigrations(client, dir)).rejects.toThrow("Миграция 0001_a.sql изменена после применения");
    expect(body(log)).toEqual([]);
    expect(log.at(-1)).toContain("pg_advisory_unlock");
  });

  it("директива migrate:no-transaction — без BEGIN/COMMIT", async () => {
    const sql = "-- migrate:no-transaction\nSQL CONCURRENTLY";
    const dir = await migrationsDir({ "0001_idx.sql": sql });
    const { client, log } = fakeClient({});

    expect(await runMigrations(client, dir)).toEqual(["0001_idx.sql"]);
    expect(log.filter((q) => q === "BEGIN" || q === "COMMIT")).toEqual([]);
    expect(log).toContain(sql);
  });

  it("при ошибке откатывает транзакцию и снимает блокировку", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "SQL BAD" });
    const { client, log } = fakeClient({}, /SQL BAD/);

    await expect(runMigrations(client, dir)).rejects.toThrow(
      "Миграция 0001_a.sql не применена: boom: SQL BAD",
    );
    expect(log).toContain("ROLLBACK");
    expect(log.at(-1)).toContain("pg_advisory_unlock");
  });

  it("сбой ROLLBACK и unlock не маскирует исходную ошибку миграции", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "SQL BAD" });
    const { client } = fakeClient({}, /SQL BAD|ROLLBACK|pg_advisory_unlock/);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runMigrations(client, dir)).rejects.toThrow(
      "Миграция 0001_a.sql не применена: boom: SQL BAD",
    );
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});

describe("runMigrations: блокировки и соединение", () => {
  it("в транзакции миграции ставит lock_timeout (как SET LOCAL) до SQL миграции", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "SQL A" });
    const calls: [string, unknown[] | undefined][] = [];
    const { client } = fakeClient({});
    const query = client.query.bind(client);
    client.query = async (sql, params) => {
      calls.push([sql, params]);
      return query(sql, params);
    };

    await runMigrations(client, dir, { lockTimeoutMs: 3_000 });
    const begin = calls.findIndex(([q]) => q === "BEGIN");
    expect(calls[begin + 1]).toEqual(["SELECT set_config('lock_timeout', $1, $2)", ["3000ms", true]]);
    expect(calls[begin + 2]?.[0]).toBe("SQL A");
  });

  it("без транзакции: lock_timeout на сессию и RESET после", async () => {
    const dir = await migrationsDir({ "0001_idx.sql": "-- migrate:no-transaction\nSQL IDX" });
    const { client, log } = fakeClient({});

    await runMigrations(client, dir);
    const i = log.findIndex((q) => q.includes("SQL IDX"));
    expect(log[i - 1]).toContain("set_config('lock_timeout'");
    expect(log[i + 1]).toBe("RESET lock_timeout");
  });

  it("advisory lock занят дольше lockWaitMs — ошибка, миграции не выполняются", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "SQL A" });
    const log: string[] = [];
    const client: SqlClient = {
      async query(sql) {
        log.push(sql);
        if (sql.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ locked: false }] };
        return { rows: [] };
      },
    };

    await expect(runMigrations(client, dir, { lockWaitMs: 30, lockPollMs: 5 })).rejects.toThrow(
      "advisory lock не получен за 30 мс",
    );
    expect(log.filter((q) => q.startsWith("SELECT pg_try_advisory_lock")).length).toBeGreaterThan(1);
    expect(log).not.toContain("SQL A");
    expect(log.some((q) => q.includes("pg_advisory_unlock"))).toBe(false);
  });

  it("отклоняет pg.Pool (нужно одно соединение)", async () => {
    const pool = { totalCount: 0, query: async () => ({ rows: [] }) };
    // @ts-expect-error: SqlClient не допускает pg.Pool (у него есть totalCount)
    await expect(runMigrations(pool)).rejects.toThrow("а не pg.Pool");
  });
});

describe("loadMigrations", () => {
  it("UTF-8 BOM срезается: директива распознаётся, сумма как без BOM", async () => {
    const sql = "-- migrate:no-transaction\nSQL IDX";
    const dir = await migrationsDir({ "0001_idx.sql": "\uFEFF" + sql });
    const [m] = await loadMigrations(dir);
    expect(m?.transaction).toBe(false);
    expect(m?.sql).toBe(sql);
    expect(m?.checksum).toBe(checksum(sql));
    expect(checksum("\uFEFF" + sql)).toBe(checksum(sql));
  });

  it("отклоняет имя не по формату NNNN_имя.sql", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "-", "10_b.sql": "-", "0002_Big.sql": "-" });
    await expect(loadMigrations(dir)).rejects.toThrow("не по формату NNNN_имя.sql: 0002_Big.sql, 10_b.sql");
  });

  it("отклоняет два файла с одним номером", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "-", "0001_b.sql": "-" });
    await expect(loadMigrations(dir)).rejects.toThrow("Два файла миграций с номером 0001");
  });

  it("директива учитывается только в первой строке", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "SELECT 1;\n-- migrate:no-transaction\n" });
    const [m] = await loadMigrations(dir);
    expect(m?.transaction).toBe(true);
  });

  it("контрольная сумма не зависит от CRLF/LF", () => {
    expect(checksum("A\r\nB\r\n")).toBe(checksum("A\nB\n"));
    expect(checksum("A\nB")).not.toBe(checksum("A\nC"));
  });

  it("миграции репозитория проходят проверки формата", async () => {
    const migrations = await loadMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(migrations[0]?.name).toBe("0001_init.sql");
    expect(migrations.every((m) => m.transaction)).toBe(true);
  });
});
