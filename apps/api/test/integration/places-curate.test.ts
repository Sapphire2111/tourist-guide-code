// Осторожное слияние дублей и архив (places:check → curatePlaces с guardMerges) на реальной PostgreSQL под ролью app:
// дубль с ручной правкой графика (schedule.edit) не сливается, чистый дубль Google сливается с переносом ссылок,
// архив места партнёра — в «не применено».
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/index.js";
import { curatePlaces } from "../../src/places-curate/apply.js";
import type { MappedPlace } from "../../src/places-import/mapping.js";
import { writePlaces } from "../../src/places-import/writer.js";
import { seedCatalog } from "../../src/seed/seed-catalog.js";
import { seedBase } from "../../src/seed/seed.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const APP_LOGIN = "tg_api_places_curate_test";
const APP_PASSWORD = "tg_api_places_curate_test";

const place = (id: string): MappedPlace => ({
  googlePlaceId: id,
  categoryCode: "restaurants",
  extraCategoryCodes: [],
  localityCode: "yaremche",
  name: `Ресторан ${id}`,
  description: "Ресторан у Яремчі. Джерело: Google Maps.",
  address: "вулиця Свободи, 1, Яремче",
  at: { lon: 24.55, lat: 48.45 },
  phone: null,
  website: null,
  week: [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "22:00" }],
  photos: [],
  rating: 4.5,
  ratingCount: 10,
});

describe.skipIf(!dockerAvailable)(`Осторожная чистка мест (places:check)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;

  beforeAll(async () => {
    tdb = await startDatabase();
    await tdb.client.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    const base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);
  const idOf = async (g: string) =>
    String((await sql("SELECT id FROM places WHERE google_place_id = $1", [g])).rows[0].id);
  const statusOf = async (g: string) =>
    String((await sql("SELECT status FROM places WHERE google_place_id = $1", [g])).rows[0].status);

  it("ручной график блокирует, чистый Google сливается, архив места партнёра — в todo", async () => {
    await writePlaces(
      appDb,
      "test-region",
      ["cMain", "cDup", "cManual", "cPartner"].map(place),
      new Date("2026-11-01T00:00:00Z"),
    );
    const [main, dup, manual, partner] = await Promise.all(
      ["cMain", "cDup", "cManual", "cPartner"].map(idOf),
    );
    const user = String((await sql("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0].id);
    // Ручная правка графика; id в верхнем регистре — как может прийти через ParseUUIDPipe.
    await sql(
      `INSERT INTO audit_logs (actor_type, actor_user_id, region_id, action, entity_type, entity_id)
       SELECT 'user', $1, region_id, 'schedule.edit', 'place', upper(id::text) FROM places WHERE id = $2`,
      [user, manual],
    );
    const org = String(
      (
        await sql(
          `INSERT INTO organizations (region_id, name) SELECT region_id, 'Партнер' FROM places
           WHERE id = $1 RETURNING id`,
          [partner],
        )
      ).rows[0].id,
    );
    await sql("UPDATE places SET organization_id = $1 WHERE id = $2", [org, partner]);
    await sql(
      `INSERT INTO favorites (region_id, user_id, place_id) SELECT region_id, $1, id FROM places WHERE id = $2`,
      [user, dup],
    );

    const report = await curatePlaces(appDb, {
      regionCode: "test-region",
      findings: [],
      decisions: [
        { kind: "merge", id: dup, mainId: main, note: "тест" },
        { kind: "merge", id: manual, mainId: main, note: "тест" },
        { kind: "archive", id: partner, note: "тест: вне региона" },
      ],
      localityIssueIds: [],
      dryRun: false,
      reason: "тест",
      guardMerges: true,
    });

    expect(await statusOf("cDup")).toBe("archived");
    expect(await statusOf("cManual")).toBe("published");
    expect(await statusOf("cPartner")).toBe("published");
    expect(
      (await sql("SELECT count(*)::int AS n FROM favorites WHERE place_id = $1", [main])).rows[0].n,
    ).toBe(1);
    const todo = new Map(report.todo.map((t) => [t.id, t.reason]));
    expect(todo.get(manual)).toMatch(/schedule\.edit/);
    expect(todo.get(partner)).toMatch(/место партнёра/);
    expect(todo.has(dup)).toBe(false);
  });
});
