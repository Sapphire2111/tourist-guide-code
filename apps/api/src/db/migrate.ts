// Раннер SQL-миграций (ADR-006): миграции — рукописный SQL в apps/api/migrations, только вперёд.
// Применяет NNNN_имя.sql по порядку номера, каждую в своей транзакции, пишет имя и контрольную сумму
// в schema_migrations. Повторный запуск — no-op; изменённый после применения файл — ошибка.
// Директива `-- migrate:no-transaction` первой строкой: файл выполняется без BEGIN/COMMIT
// (для CREATE INDEX CONCURRENTLY и т. п.; в таком файле должен быть один оператор).
// Таймауты: ожидание advisory lock другого запуска — lockWaitMs; ожидание блокировок таблиц внутри
// миграции — lock_timeout (lockTimeoutMs), чтобы миграция не держала очередь боевых запросов за собой.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Одно соединение: pg.Client или pg.PoolClient. pg.Pool не подходит — advisory lock, BEGIN/COMMIT и
 * SET держатся на соединении, а пул отдаёт каждый запрос в произвольное. Тип отсекает pg.Pool
 * (у него есть totalCount), runMigrations дополнительно проверяет это в рантайме.
 */
export type SqlClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  totalCount?: never;
};

export type MigrateOptions = {
  /** Сколько ждать advisory lock параллельного запуска, мс (по умолчанию 60 000). */
  lockWaitMs?: number;
  /** Интервал повторной попытки взять advisory lock, мс (по умолчанию 500). */
  lockPollMs?: number;
  /** lock_timeout для операторов миграции, мс (по умолчанию 10 000; 0 — без ограничения). */
  lockTimeoutMs?: number;
};

/** apps/api/migrations — одинаково из src/db и dist/db (в образе Docker — /app/migrations). */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Имя файла миграции: 4 цифры, подчёркивание, латиница/цифры/подчёркивания. */
export const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

const NO_TRANSACTION = /^--\s*migrate:no-transaction\s*$/m;

// Произвольный ключ advisory-lock, чтобы параллельные запуски не применяли миграции дважды.
const LOCK_KEY = 7_051_005;

export type Migration = { name: string; sql: string; checksum: string; transaction: boolean };

/** sha256 содержимого; BOM и CRLF нормализуются, чтобы редактор/checkout не меняли сумму. */
export function checksum(sql: string): string {
  return createHash("sha256").update(stripBom(sql).replace(/\r\n/g, "\n")).digest("hex");
}

/** UTF-8 BOM в начале файла (редакторы Windows) — иначе директива первой строки не распознаётся. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Читает и проверяет миграции каталога; возвращает их в порядке применения. */
export async function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const bad = files.filter((f) => !MIGRATION_NAME.test(f));
  if (bad.length) throw new Error(`Имя миграции не по формату NNNN_имя.sql: ${bad.join(", ")}`);
  const numbers = files.map((f) => f.slice(0, 4));
  const dup = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (dup) throw new Error(`Два файла миграций с номером ${dup}`);
  return Promise.all(
    files.map(async (name) => {
      const sql = stripBom(await readFile(path.join(dir, name), "utf8"));
      const firstLine = sql.split("\n", 1)[0] ?? "";
      return { name, sql, checksum: checksum(sql), transaction: !NO_TRANSACTION.test(firstLine) };
    }),
  );
}

export async function runMigrations(
  client: SqlClient,
  dir = DEFAULT_MIGRATIONS_DIR,
  { lockWaitMs = 60_000, lockPollMs = 500, lockTimeoutMs = 10_000 }: MigrateOptions = {},
): Promise<string[]> {
  if ("totalCount" in client)
    throw new TypeError("runMigrations нужен pg.Client/PoolClient (одно соединение), а не pg.Pool");
  const migrations = await loadMigrations(dir);
  await acquireLock(client, lockWaitMs, lockPollMs);
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query("SELECT name, checksum FROM schema_migrations");
    const done = new Map(rows.map((r) => [String(r.name), String(r.checksum)]));
    const applied: string[] = [];
    for (const m of migrations) {
      const doneChecksum = done.get(m.name);
      if (doneChecksum !== undefined) {
        if (doneChecksum !== m.checksum)
          throw new Error(
            `Миграция ${m.name} изменена после применения (контрольная сумма не совпадает). ` +
              "Применённые миграции не правят — нужна новая миграция.",
          );
        continue;
      }
      await apply(client, m, lockTimeoutMs);
      applied.push(m.name);
    }
    return applied;
  } finally {
    // Ошибка unlock не должна маскировать исходную ошибку миграции.
    await client
      .query("SELECT pg_advisory_unlock($1)", [LOCK_KEY])
      .catch((e: unknown) => console.error("pg_advisory_unlock не удался:", e));
  }
}

/** pg_try_advisory_lock с повтором: не ждать бесконечно зависший параллельный запуск. */
async function acquireLock(client: SqlClient, waitMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [LOCK_KEY]);
    if (rows[0]?.locked === true) return;
    if (Date.now() >= deadline)
      throw new Error(`Миграции уже выполняет другой процесс: advisory lock не получен за ${waitMs} мс`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function apply(client: SqlClient, m: Migration, lockTimeoutMs: number): Promise<void> {
  const record = () =>
    client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
  const lockTimeout = (local: boolean) =>
    client.query("SELECT set_config('lock_timeout', $1, $2)", [`${lockTimeoutMs}ms`, local]);
  try {
    if (!m.transaction) {
      // Без транзакции частичный результат не откатится: такой файл держат из одного оператора.
      await lockTimeout(false);
      try {
        await client.query(m.sql);
      } finally {
        await client
          .query("RESET lock_timeout")
          .catch((e: unknown) => console.error("RESET lock_timeout не удался:", e));
      }
      await record();
      return;
    }
    await client.query("BEGIN");
    try {
      await lockTimeout(true); // как SET LOCAL: до конца транзакции миграции
      await client.query(m.sql);
      await record();
      await client.query("COMMIT");
    } catch (err) {
      await client
        .query("ROLLBACK")
        .catch((e: unknown) => console.error(`ROLLBACK после ${m.name} не удался:`, e));
      throw err;
    }
  } catch (err) {
    throw new Error(`Миграция ${m.name} не применена: ${(err as Error).message}`, { cause: err });
  }
}
