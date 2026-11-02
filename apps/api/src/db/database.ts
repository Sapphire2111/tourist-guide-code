import { Kysely, PostgresDialect, type Dialect, type Driver } from "kysely";
import pg from "pg";
import type { Database } from "./schema.js";
import type { TenancyMap } from "./tenancy.js";
import { rejectConnectionInsideTenant, type TenantContext } from "./tenant-context.js";
import { TenantGuardPlugin } from "./tenant-guard.plugin.js";

export type Db = Kysely<Database>;

/**
 * Диалект, драйвер которого не выдаёт новое соединение внутри withTenant() (rejectConnectionInsideTenant).
 * Проверка на уровне драйвера покрывает все пути: `db.transaction()`, `startTransaction()`, `connection()`,
 * запрос на корневом db мимо currentDb() и производные экземпляры (`withSchema`, `withPlugin`, `withTables`,
 * `withoutPlugins`) — они разделяют этот драйвер. Транзакция withTenant() берёт соединение до входа в контекст.
 */
export function tenantGuardedDialect(dialect: Dialect): Dialect {
  return {
    createAdapter: () => dialect.createAdapter(),
    createDriver: () => guardDriver(dialect.createDriver()),
    createIntrospector: (db) => dialect.createIntrospector(db),
    createQueryCompiler: () => dialect.createQueryCompiler(),
  };
}

function guardDriver(driver: Driver): Driver {
  return new Proxy(driver, {
    get(target, prop) {
      if (prop === "acquireConnection")
        return async (...args: Parameters<Driver["acquireConnection"]>) => {
          rejectConnectionInsideTenant();
          return target.acquireConnection(...args);
        };
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export type DatabaseOptions = {
  connectionString: string;
  /** Размер пула соединений (pg.Pool max). */
  maxConnections?: number;
  /** Классификация таблиц для TenantGuardPlugin (по умолчанию TABLE_TENANCY; тесты добавляют свои таблицы). */
  tenancy?: TenancyMap;
  /** Контекст плагина вне withTenant() — только тесты/скрипты под ролью-владельцем (см. TenantGuardOptions). */
  defaultTenant?: TenantContext;
};

/** Логирует ошибку простаивающего соединения пула вместо падения процесса. */
export function onIdleClientError(err: Error): void {
  console.error("PostgreSQL: ошибка простаивающего соединения пула:", err.message);
}

/**
 * Kysely поверх pg.Pool с TenantGuardPlugin (фильтр region_id, ADR-005). Соединения открываются лениво —
 * при первом запросе. Закрыть: `await db.destroy()` (закрывает и пул).
 */
export function createDatabase({
  connectionString,
  maxConnections = 10,
  tenancy,
  defaultTenant,
}: DatabaseOptions): Db {
  const pool = new pg.Pool({ connectionString, max: maxConnections, application_name: "tg-api" });
  // Ошибка простаивающего соединения (рестарт/обрыв БД) приходит событием пула; без обработчика
  // Node завершает процесс. Пул сам выбрасывает сломанное соединение и потом откроет новое.
  pool.on("error", onIdleClientError);
  return new Kysely<Database>({
    dialect: tenantGuardedDialect(new PostgresDialect({ pool })),
    plugins: [new TenantGuardPlugin({ tables: tenancy, defaultTenant })],
  });
}
