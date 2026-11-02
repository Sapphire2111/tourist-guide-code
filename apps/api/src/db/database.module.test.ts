import { Test } from "@nestjs/testing";
import { Kysely } from "kysely";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createDatabase, DATABASE, DatabaseModule, type Db } from "./index.js";
import { migrationDatabaseUrl } from "./env.js";

describe("createDatabase", () => {
  it("ошибка простаивающего соединения пула логируется, а не роняет процесс", async () => {
    const on = vi.spyOn(pg.Pool.prototype, "on");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createDatabase({ connectionString: "postgres://u:p@127.0.0.1:1/db" });
    const pool = on.mock.contexts.find((c) => c instanceof pg.Pool) as pg.Pool;

    // Без слушателя "error" EventEmitter бросил бы исключение (в рантайме — падение процесса).
    expect(() => pool.emit("error", new Error("terminating connection"))).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("простаивающего"), "terminating connection");
    await db.destroy();
  });

  it("обрыв занятого соединения (событие на client) логируется, а не роняет процесс", async () => {
    const on = vi.spyOn(pg.Pool.prototype, "on");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createDatabase({ connectionString: "postgres://u:p@127.0.0.1:1/db" });
    const pool = on.mock.contexts.find((c) => c instanceof pg.Pool) as pg.Pool;
    const client = new pg.Client();
    pool.emit("connect", client);

    expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("занятого"),
      "Connection terminated unexpectedly",
    );
    await db.destroy();
  });
});

describe("migrationDatabaseUrl", () => {
  it("DATABASE_MIGRATION_URL, иначе DATABASE_URL, без обеих — ошибка", () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: "postgres://app@h/db" })).toBe("postgres://app@h/db");
    expect(
      migrationDatabaseUrl({
        DATABASE_URL: "postgres://app@h/db",
        DATABASE_MIGRATION_URL: " postgres://owner@h/db ",
      }),
    ).toBe("postgres://owner@h/db");
    expect(() => migrationDatabaseUrl({ DATABASE_URL: "  " })).toThrow(
      "DATABASE_MIGRATION_URL или DATABASE_URL",
    );
  });
});

describe("DatabaseModule", () => {
  it("даёт Kysely по токену и закрывает пул при остановке приложения (без соединения с БД)", async () => {
    // Порт 1 недоступен: пул ленивый, соединения не открываются, пока нет запросов.
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" })],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const db = app.get<Db>(DATABASE);
    expect(db).toBeInstanceOf(Kysely);
    const destroy = vi.spyOn(db, "destroy");

    await app.close();
    expect(destroy).toHaveBeenCalledOnce();
    // Компиляция Nest-модуля под нагрузкой (параллельный turbo) занимала > 5 с.
  }, 20_000);
});
