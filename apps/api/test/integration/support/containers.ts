import net from "node:net";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { runMigrations } from "../../../src/db/migrate.js";

// Образы закреплены точными тегами; PostGIS-образ включает PostgreSQL той же мажорной версии.
export const POSTGIS_IMAGE = "postgis/postgis:17-3.5";
export const REDIS_IMAGE = "redis:7.4-alpine";

export type TestDatabase = { container: StartedPostgreSqlContainer; client: pg.Client; applied: string[] };

/** Чистая PostgreSQL+PostGIS в контейнере с применёнными миграциями apps/api/migrations. */
export async function startDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  try {
    await client.connect();
    const applied = await runMigrations(client);
    return { container, client, applied };
  } catch (err) {
    // Не оставлять контейнер и соединение при падении подключения/миграций.
    await Promise.allSettled([client.end()]);
    await Promise.allSettled([container.stop()]);
    throw err;
  }
}

export async function stopDatabase(db: TestDatabase | undefined): Promise<void> {
  if (!db) return;
  await Promise.allSettled([db.client.end()]);
  await db.container.stop();
}

export function startRedis(): Promise<StartedRedisContainer> {
  return new RedisContainer(REDIS_IMAGE).start();
}

/** PING по протоколу RESP без клиентской библиотеки (клиент Redis выберут в T1-21). */
export function redisPing(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => socket.write("PING\r\n"));
    socket.setTimeout(5_000, () => socket.destroy(new Error("Redis PING: таймаут")));
    socket.once("data", (data) => {
      socket.end();
      resolve(data.toString().trim());
    });
    socket.once("error", reject);
  });
}
