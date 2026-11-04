// Unit: peaks:sync — путь со вставкой новых вершин (fresh). Запись идёт одной транзакцией: writePlaces получает trx,
// а не корневой db (иначе запрос региона внутри withTenant берёт новое соединение — TenantContextError). Драйвер —
// поддельный, под тем же tenantGuardedDialect, что и в проде: корневой db внутри withTenant бросает ошибку.
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import { describe, expect, it, vi } from "vitest";
import { tenantGuardedDialect, type Database, type Db } from "../db/index.js";
import type { MappedPlace } from "./mapping.js";
import type * as Writer from "./writer.js";
import { PEAKS } from "./peaks.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const turkul = PEAKS.find((p) => p.slug === "turkul")!;

const writer = vi.hoisted(() => ({ calls: [] as { isTransaction: boolean }[], inserted: false }));

vi.mock("./writer.js", async (orig) => ({
  ...(await orig<typeof Writer>()),
  findRegionId: vi.fn(async () => REGION),
  // Как настоящий writePlaces: сначала запрос региона на полученном db.
  writePlaces: vi.fn(async (db: Db) => {
    writer.calls.push({ isTransaction: db.isTransaction });
    await db.selectFrom("regions").select("id").execute();
    writer.inserted = true;
    return {};
  }),
}));

vi.mock("./targeted.js", () => ({
  collectTargeted: vi.fn(async () => ({
    queriesDone: 1,
    places: [{ googlePlaceId: "g-turkul", name: "гора Туркул", at: turkul.location } as MappedPlace],
  })),
}));

const { syncPeaks } = await import("./peaks-sync.js");

/** Ответы по тексту SQL: места вершины появляются только после вставки. */
function rowsFor(sql: string): unknown[] {
  if (sql.includes('insert into "audit_logs"')) return [{ id: "a1", region_id: REGION }];
  if (sql.includes('from "categories"')) return [{ id: "c1" }];
  if (sql.includes('insert into "categories"')) return [{ id: "c2" }];
  if (sql.includes('"places"."google_place_id" in') && writer.inserted)
    return [
      {
        id: "p-turkul",
        google_place_id: "g-turkul",
        name: "Туркул",
        category_code: "peaks",
        status: "published",
        cover_source: null,
        cover_author: null,
      },
    ];
  return [];
}

function fakeDb(): Db {
  const conn: DatabaseConnection = {
    executeQuery: async <R>(q: { sql: string }): Promise<QueryResult<R>> => ({ rows: rowsFor(q.sql) as R[] }),
    streamQuery: () => {
      throw new Error("not used");
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => conn,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<Database>({
    dialect: tenantGuardedDialect({
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    }),
  });
}

describe("syncPeaks — вставка новых вершин", () => {
  it("writePlaces получает транзакцию; вставленное место — по своему id Google, аудит в той же транзакции", async () => {
    const { stats, plans } = await syncPeaks({
      db: fakeDb(),
      regionCode: "kosiv",
      google: {} as never,
      wiki: {} as never,
      write: true,
      importMissing: true,
      covers: false,
    });
    expect(writer.calls).toEqual([{ isTransaction: true }]);
    expect(stats.inserted).toEqual([expect.objectContaining({ slug: "turkul", googlePlaceId: "g-turkul" })]);
    expect(plans.find((p) => p.peak.slug === "turkul")).toMatchObject({
      matchedBy: "google_place_id",
      place: { id: "p-turkul" },
    });
    expect(stats.nameMatched).toEqual([]);
  });
});
