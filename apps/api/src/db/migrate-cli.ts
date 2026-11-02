// CLI миграций: `pnpm --filter @tg/api db:migrate` (собирает и запускает) или в образе Docker
// `node dist/db/migrate-cli.js` — шаг перед стартом новой версии (pre-deploy). Только вперёд.
import pg from "pg";
import { migrationDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";

const client = new pg.Client({ connectionString: migrationDatabaseUrl(), application_name: "tg-migrate" });
// Обрыв соединения посреди миграции — в catch/finally (ошибку получит текущий запрос), а не uncaughtException.
client.on("error", (err) => console.error("PostgreSQL: обрыв соединения миграций:", err.message));
try {
  await client.connect();
  const applied = await runMigrations(client);
  console.log(applied.length ? `Применены миграции: ${applied.join(", ")}` : "Новых миграций нет.");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
