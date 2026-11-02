// CLI seed: `pnpm --filter @tg/api db:seed [-- --volume=small|tz --users=N --events=N --allow-large]`. Только local и staging.
// Подключается под ролью миграций (DATABASE_MIGRATION_URL, иначе DATABASE_URL) — см. README apps/api, «Seed».
import { createDatabase } from "../db/index.js";
import { migrationDatabaseUrl } from "../db/env.js";
import { assertSeedAllowed } from "./guard.js";
import { seedCatalog } from "./seed-catalog.js";
import { seedHost } from "./seed-host.js";
import {
  assertVolumeAllowed,
  parseVolumeArgs,
  seedBase,
  seedEmergencyContacts,
  seedQrPoints,
  seedVolume,
} from "./seed.js";

try {
  const url = migrationDatabaseUrl(); // тот же fallback, что у db:migrate
  const appEnv = assertSeedAllowed(process.env, url); // до подключения к БД
  const { allowLarge, ...volume } = parseVolumeArgs(process.argv.slice(2));
  assertVolumeAllowed(volume, appEnv, allowLarge);
  const db = createDatabase({ connectionString: url, maxConnections: 2 });
  try {
    const base = await seedBase(db);
    const qr = await seedQrPoints(db, base.regions);
    const emergency = await seedEmergencyContacts(db, base.regions);
    const catalog = await seedCatalog(db, base.regions);
    const host = await seedHost(db, base.regions);
    await seedVolume(db, base.regions, volume, console.log);
    console.log(
      `Seed (${appEnv}): регионов ${Object.keys(base.regions).length}, пользователей с ролями ${Object.keys(base.users).length}, ` +
        `новых назначений ${base.assignmentsCreated}, демо-QR ${Object.keys(qr).length}, новых экстренных контактов ${emergency}, каталог: категорий ${catalog.categories}, мест ${catalog.places}; блок 5: новых модулів «Про заклад» ${host.hostModules}, сценаріїв ${host.scenarios}; объём: пользователей ${volume.users}, событий ${volume.events}.`,
    );
  } finally {
    await db.destroy();
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
