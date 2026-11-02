import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { StartedRedisContainer } from "@testcontainers/redis";
import {
  redisPing,
  startDatabase,
  startRedis,
  stopDatabase,
  type TestDatabase,
} from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

describe.skipIf(!dockerAvailable)(`PostgreSQL/PostGIS + Redis в контейнерах${title}`, () => {
  let db: TestDatabase | undefined;
  let redis: StartedRedisContainer | undefined;

  beforeAll(async () => {
    // allSettled: если один старт упал, второй контейнер всё равно сохраняется и будет остановлен в afterAll.
    const [dbResult, redisResult] = await Promise.allSettled([startDatabase(), startRedis()]);
    if (dbResult.status === "fulfilled") db = dbResult.value;
    if (redisResult.status === "fulfilled") redis = redisResult.value;
    const failure = [dbResult, redisResult].find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
  });

  afterAll(async () => {
    const results = await Promise.allSettled([stopDatabase(db), redis?.stop()]);
    for (const r of results)
      if (r.status === "rejected") console.error("Остановка контейнера не удалась:", r.reason);
  });

  it("чистая БД: все миграции применены с нуля", async () => {
    expect(db!.applied).toContain("0001_init.sql");
    // Сортировка в JS (как в раннере) — без зависимости от коллации БД.
    const { rows } = await db!.client.query("SELECT name FROM schema_migrations");
    expect(rows.map((r) => String(r.name)).sort()).toEqual([...db!.applied].sort());
    const meta = await db!.client.query("SELECT value FROM app_meta WHERE key = 'schema_origin'");
    expect(meta.rows[0]?.value).toBe("T1-08");
  });

  it("PostGIS доступен", async () => {
    const { rows } = await db!.client.query("SELECT postgis_version() AS v");
    expect(String(rows[0]?.v)).toMatch(/^3\./);
  });

  it("Redis отвечает на PING", async () => {
    expect(await redisPing(redis!.getHost(), redis!.getPort())).toBe("+PONG");
  });
});
