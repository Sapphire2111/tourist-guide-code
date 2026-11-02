// Kysely без соединения для unit-тестов: запросы компилируются (с TenantGuardPlugin, как в createDatabase)
// и записываются, драйвер возвращает пустой результат (или строки из respond). Транзакции DummyDriver — без
// BEGIN/COMMIT в журнале.
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import {
  tenantGuardedDialect,
  TenantGuardPlugin,
  type Database,
  type TenantGuardOptions,
} from "../../src/db/index.js";

/** Ответ на запрос: строки или строки с числом затронутых строк (UPDATE/DELETE/INSERT). */
export type RespondResult =
  | Record<string, unknown>[]
  | { rows: Record<string, unknown>[]; numAffectedRows?: bigint };

/** Строки ответа на запрос (по умолчанию — пусто). */
export type Respond = (query: CompiledQuery) => RespondResult;

class RespondingDriver extends DummyDriver {
  constructor(private readonly respond: Respond) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const respond = this.respond;
    return {
      executeQuery: async <R>(query: CompiledQuery) => {
        const r = respond(query);
        return (Array.isArray(r) ? { rows: r } : r) as QueryResult<R>;
      },
      streamQuery: () => {
        throw new Error("recordingDb: streamQuery не поддерживается");
      },
    };
  }
}

export function recordingDb(
  options: TenantGuardOptions = {},
  respond: Respond = () => [],
): {
  db: Kysely<Database>;
  queries: CompiledQuery[];
} {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<Database>({
    dialect: tenantGuardedDialect({
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RespondingDriver(respond),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    }),
    plugins: [new TenantGuardPlugin(options)],
    log: (e) => {
      if (e.level === "query") queries.push(e.query);
    },
  });
  return { db, queries };
}
