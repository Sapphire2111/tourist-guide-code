// Импорт мест из Google (миграция 0016, places:import-google) на реальной PostgreSQL под ролью app: upsert по
// google_place_id в контексте региона, идемпотентность, демо-места seed и регион Б не меняются, график, фото через
// конвейер медиа (local-хранилище во временном каталоге, Google — подменённый fetch). README apps/api.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStorage } from "@tg/media";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/index.js";
import { GooglePlacesClient } from "../../src/places-import/google-client.js";
import type { MappedPlace } from "../../src/places-import/mapping.js";
import { importPhotos } from "../../src/places-import/photos.js";
import { googlePlaceIds, writePlaces } from "../../src/places-import/writer.js";
import { ALL_LOCALITIES } from "../../src/places-import/targeted.js";
import { seedCatalog, SEED_PLACES } from "../../src/seed/seed-catalog.js";
import { seedBase, type SeedBaseResult } from "../../src/seed/seed.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_places_import_test";
const APP_PASSWORD = "tg_api_places_import_test";

const place = (id: string, over: Partial<MappedPlace> = {}): MappedPlace => ({
  googlePlaceId: id,
  categoryCode: "restaurants",
  extraCategoryCodes: [],
  localityCode: "yaremche",
  name: `Ресторан ${id}`,
  description: "Ресторан у Яремчі. Джерело: Google Maps.",
  address: "вулиця Свободи, 1, Яремче",
  at: { lon: 24.55, lat: 48.45 },
  phone: "+380987930729",
  website: "https://example.com/",
  week: [
    { dayOfWeek: 1, opensAt: "09:00", closesAt: "13:00" },
    { dayOfWeek: 1, opensAt: "14:00", closesAt: "22:00" },
  ],
  photos: [`places/${id}/photos/p1`, `places/${id}/photos/p2`, `places/${id}/photos/p3`],
  rating: 4.5,
  ratingCount: 10,
  ...over,
});

describe.skipIf(!dockerAvailable)(`Импорт мест из Google (0016)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let base: SeedBaseResult;
  let storageDir: string;
  let cacheDir: string;

  beforeAll(async () => {
    tdb = await startDatabase();
    await tdb.client.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    storageDir = await mkdtemp(path.join(tmpdir(), "tg-import-storage-"));
    cacheDir = await mkdtemp(path.join(tmpdir(), "tg-import-cache-"));
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  });

  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);

  it("запись: места опубликованы, график, новые категории; seed и регион Б не тронуты; повтор — обновление", async () => {
    const seedBefore = (
      await sql("SELECT id, updated_at, phone FROM places WHERE source = 'manual' ORDER BY id")
    ).rows;
    expect(seedBefore.length).toBe(SEED_PLACES.length + 1); // + место региона Б

    const now = new Date("2026-11-02T10:00:00Z");
    const first = await writePlaces(
      appDb,
      "test-region",
      [
        place("gA"),
        place("gB", { categoryCode: "fast-food", localityCode: "polianytsia", week: [], website: null }),
      ],
      now,
    );
    expect(first).toMatchObject({
      inserted: 2,
      updated: 0,
      schedulesWritten: 2,
      manualPlaces: SEED_PLACES.length,
    });
    expect(first.categoriesCreated).toBeGreaterThan(0);
    expect(first.localitiesCreated).toBe(0); // пункты пилота уже есть в seed

    const rows = (
      await sql(
        `SELECT p.google_place_id, p.status, p.source, p.verified_at, p.first_published_at, p.last_synced_at,
                c.code AS category, l.code AS locality, r.code AS region
         FROM places p JOIN categories c ON c.id = p.category_id JOIN localities l ON l.id = p.locality_id
         JOIN regions r ON r.id = p.region_id
         WHERE p.source = 'google' ORDER BY p.google_place_id`,
      )
    ).rows;
    expect(rows.map((r) => [r.google_place_id, r.status, r.category, r.locality, r.region])).toEqual([
      ["gA", "published", "restaurants", "yaremche", "test-region"],
      ["gB", "published", "fast-food", "polianytsia", "test-region"],
    ]);
    expect(rows.every((r) => r.verified_at.getTime() === now.getTime())).toBe(true);
    expect(
      (
        await sql(
          "SELECT count(*)::int AS n FROM place_schedules s JOIN places p ON p.id = s.place_id WHERE p.google_place_id = 'gA'",
        )
      ).rows[0].n,
    ).toBe(2);
    // fast-food — под корневым «eat».
    expect(
      (
        await sql(
          "SELECT p.code FROM categories c JOIN categories p ON p.id = c.parent_id WHERE c.code = 'fast-food'",
        )
      ).rows,
    ).toEqual([{ code: "eat" }]);

    // Админка поправила название — повторный импорт его не трогает, телефон и график обновляет.
    await sql("UPDATE places SET name_i18n = '{\"uk\":\"Правка админа\"}' WHERE google_place_id = 'gA'");
    const later = new Date("2026-11-03T10:00:00Z");
    const second = await writePlaces(
      appDb,
      "test-region",
      [
        place("gA", {
          phone: "+380501112233",
          week: [{ dayOfWeek: 2, opensAt: "10:00", closesAt: "20:00" }],
        }),
        place("gB", { week: null }),
      ],
      later,
    );
    expect(second).toMatchObject({ inserted: 0, updated: 2, categoriesCreated: 0, schedulesWritten: 1 });
    const a = (await sql("SELECT name_i18n, phone, verified_at FROM places WHERE google_place_id = 'gA'"))
      .rows[0];
    expect(a.name_i18n).toEqual({ uk: "Правка админа" });
    expect(a.phone).toBe("+380501112233");
    expect(a.verified_at.getTime()).toBe(later.getTime());
    expect(
      (
        await sql(
          "SELECT day_of_week FROM place_schedules s JOIN places p ON p.id = s.place_id WHERE p.google_place_id = 'gA'",
        )
      ).rows,
    ).toEqual([{ day_of_week: 2 }]);

    const seedAfter = (
      await sql("SELECT id, updated_at, phone FROM places WHERE source = 'manual' ORDER BY id")
    ).rows;
    expect(seedAfter).toEqual(seedBefore);
  });

  it("seed: «Вершини» й «Бари» заведены (nearby, eat); повторный seed не дублирует", async () => {
    await seedCatalog(ownerDb, base.regions);
    const rows = (
      await sql(
        `SELECT c.code, p.code AS parent FROM categories c JOIN categories p ON p.id = c.parent_id
         JOIN regions r ON r.id = c.region_id
         WHERE r.code = 'test-region' AND c.code IN ('peaks', 'bars') ORDER BY c.code`,
      )
    ).rows;
    expect(rows).toEqual([
      { code: "bars", parent: "eat" },
      { code: "peaks", parent: "nearby" },
    ]);
  });

  it("теги (tagsForPlace): по категории и удобствам Google; только добавляются; места с действиями пользователя — нет", async () => {
    const t = new Date();
    const ids = ["gTag1", "gTag2", "gTag3"];
    await writePlaces(
      appDb,
      "test-region",
      [
        place("gTag1"),
        place("gTag2", { categoryCode: "nature", week: null }),
        place("gTag3", { categoryCode: "nature", week: null }),
      ],
      t,
    );
    await sql(
      `INSERT INTO place_enrichments (region_id, place_id, google)
       SELECT region_id, id, '{"amenities":["good_for_children","dogs_allowed","parking_free","wheelchair_entrance"]}'::jsonb
       FROM places WHERE google_place_id = ANY($1)`,
      [ids],
    );
    const user = String((await sql("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0].id);
    await sql(
      `INSERT INTO audit_logs (actor_type, actor_user_id, region_id, action, entity_type, entity_id)
       SELECT 'user', $1, region_id, 'place.update', 'place', id::text FROM places WHERE google_place_id = 'gTag3'`,
      [user],
    );
    const r = await writePlaces(
      appDb,
      "test-region",
      [
        place("gTag1"),
        place("gTag2", { categoryCode: "nature", week: null }),
        place("gTag3", { categoryCode: "nature", week: null }),
      ],
      t,
    );
    const tags = async (id: string) =>
      (
        await sql(
          `SELECT t.code FROM place_tags pt JOIN tags t ON t.id = pt.tag_id JOIN places p ON p.id = pt.place_id
           WHERE p.google_place_id = $1 ORDER BY t.code`,
          [id],
        )
      ).rows.map((x) => x.code);
    expect(await tags("gTag1")).toEqual(["kids", "parking", "pets", "rainy-day"]);
    expect(await tags("gTag2")).toEqual(["kids", "parking", "pets"]);
    expect(await tags("gTag3")).toEqual([]);
    // Первый прогон: «У дощ» ресторану; второй — удобства (по 3 у gTag1 и gTag2).
    expect(r.tagsWritten).toBe(6);
    // Повтор — ничего нового (ON CONFLICT DO NOTHING).
    const again = await writePlaces(appDb, "test-region", [place("gTag1")], t);
    expect(again.tagsWritten).toBe(0);
  });

  it("ручная чистка (place.curate от system) и использование: импорт не меняет категорию, пункт, статус и не архивирует", async () => {
    const t = new Date();
    // Главная запись Booking после чистки: категория и пункт поправлены, импорт её не трогает и не архивирует.
    await writePlaces(appDb, "test-region", [place("gCur1", { categoryCode: "hotels" })], t);
    await sql(
      `UPDATE places SET category_id = (SELECT id FROM categories WHERE code = 'sadyby' AND region_id = places.region_id),
         locality_id = (SELECT id FROM localities WHERE code = 'tatariv' AND region_id = places.region_id)
       WHERE google_place_id = 'gCur1'`,
    );
    await sql(
      `INSERT INTO audit_logs (actor_type, region_id, action, entity_type, entity_id)
       SELECT 'system', region_id, 'place.curate', 'place', id::text FROM places WHERE google_place_id = 'gCur1'`,
    );
    // Место в избранном у пользователя — не архивируется, хоть и «не наше».
    await writePlaces(appDb, "test-region", [place("gFav1")], t);
    const user = String((await sql("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0].id);
    await sql(
      `INSERT INTO favorites (region_id, user_id, place_id)
       SELECT region_id, $1, id FROM places WHERE google_place_id = 'gFav1'`,
      [user],
    );
    const r = await writePlaces(
      appDb,
      "test-region",
      [place("gCur1", { categoryCode: "hotels", localityCode: "yaremche" })],
      t,
      { rejectedIds: ["gCur1", "gFav1"] },
    );
    expect(r.archivedRejected).toBe(0);
    expect(r.recategorized).toBe(0);
    const row = async (id: string) =>
      (
        await sql(
          `SELECT p.status, c.code AS category, l.code AS locality FROM places p
           JOIN categories c ON c.id = p.category_id LEFT JOIN localities l ON l.id = p.locality_id
           WHERE p.google_place_id = $1`,
          [id],
        )
      ).rows[0];
    expect(await row("gCur1")).toEqual({ status: "published", category: "sadyby", locality: "tatariv" });
    expect((await row("gFav1")).status).toBe("published");
  });

  it("CHECK: google_place_id только у source = google; уникален в регионе", async () => {
    await expect(sql("UPDATE places SET google_place_id = 'x1' WHERE source = 'manual'")).rejects.toThrow(
      /places_google_source_consistent/,
    );
    await expect(
      sql("UPDATE places SET google_place_id = 'gA' WHERE google_place_id = 'gB'"),
    ).rejects.toThrow(/places_region_google_place_id_key/);
  });

  it("фото: до двух на место через конвейер медиа, обложка — первое; повтор ничего не догружает", async () => {
    const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#4a7" } })
      .jpeg()
      .toBuffer();
    let calls = 0;
    const fetch = (async (input: string | URL) => {
      calls++;
      const url = String(input);
      if (url.includes("/media?"))
        return new Response(JSON.stringify({ photoUri: "https://lh3.googleusercontent.com/p/test=w1600" }));
      return new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg" } });
    }) as typeof globalThis.fetch;
    const client = new GooglePlacesClient({ apiKey: "test", cacheDir, maxRequests: 100, fetch });
    const storage = createStorage(
      { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
      "http://localhost",
    );
    const places = [place("gA"), place("gB", { photos: ["places/gB/photos/only"] })];
    const ids = await googlePlaceIds(appDb, base.regions.a);
    expect(ids.size).toBe(2);

    // photoUri — на хосте Google: другой не пройдёт проверку адреса фото (isAllowedPhotoUrl).
    const log: string[] = [];
    const first = await importPhotos(appDb, client, storage, base.regions.a, places, ids, (l) => log.push(l));
    expect(first, JSON.stringify({ first, log })).toEqual({
      placesConsidered: 2,
      added: 3,
      rejected: 0,
      failed: 0,
      limitReached: false,
    });
    const media = (
      await sql(
        `SELECT p.google_place_id, pm.is_cover, m.status, m.alt_i18n, m.variants
         FROM place_media pm JOIN places p ON p.id = pm.place_id JOIN media_assets m ON m.id = pm.media_asset_id
         ORDER BY p.google_place_id, pm.sort_order`,
      )
    ).rows;
    expect(media.map((m) => [m.google_place_id, m.is_cover, m.status])).toEqual([
      ["gA", true, "ready"],
      ["gA", false, "ready"],
      ["gB", true, "ready"],
    ]);
    expect(media[0].alt_i18n).toEqual({ uk: "Ресторан gA" }); // alt — название места из Google
    expect(Object.keys(media[0].variants).sort()).toEqual(["w1600", "w320", "w800"]);

    const before = calls;
    const again = await importPhotos(appDb, client, storage, base.regions.a, places, ids);
    expect(again).toMatchObject({ added: 0, placesConsidered: 0 });
    expect(calls).toBe(before);
  });

  it("повтор не затирает ручные правки пустым от Google: телефон, сайт, перевод адреса, график", async () => {
    const t0 = new Date("2026-11-04T10:00:00Z");
    const gc = (over: Partial<MappedPlace> = {}) =>
      place("gC", { week: [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "18:00" }], ...over });
    await writePlaces(appDb, "test-region", [gc()], t0);
    await sql(
      `UPDATE places SET address_i18n = '{"uk":"старий","en":"Svobody st, 1"}', phone = '+380671234567',
         website = 'https://admin.example/' WHERE google_place_id = 'gC'`,
    );
    const row = async () =>
      (
        await sql(
          `SELECT p.phone, p.website, p.address_i18n, p.status,
                  (SELECT count(*)::int FROM place_schedules s WHERE s.place_id = p.id) AS schedules
           FROM places p WHERE google_place_id = 'gC'`,
        )
      ).rows[0];

    // Нет телефона, сайт был http (в маппинге — null), нет часов.
    const r1 = await writePlaces(
      appDb,
      "test-region",
      [gc({ phone: null, website: null, week: null, address: "вулиця Нова, 2, Яремче" })],
      t0,
    );
    expect(r1).toMatchObject({ updated: 1, schedulesWritten: 0 });
    expect(await row()).toEqual({
      phone: "+380671234567",
      website: "https://admin.example/",
      address_i18n: { uk: "вулиця Нова, 2, Яремче", en: "Svobody st, 1" },
      status: "published",
      schedules: 1,
    });

    // Пустой график и график, не прошедший правила (пересечение), существующий не трогают.
    await writePlaces(appDb, "test-region", [gc({ week: [] })], t0);
    const bad = await writePlaces(
      appDb,
      "test-region",
      [
        gc({
          week: [
            { dayOfWeek: 1, opensAt: "09:00", closesAt: "15:00" },
            { dayOfWeek: 1, opensAt: "14:00", closesAt: "18:00" },
          ],
        }),
      ],
      t0,
    );
    expect(bad.schedulesRejected).toBe(1);
    expect((await row()).schedules).toBe(1);
  });

  it("закрытые навсегда снимаются с публикации; пропавшие — только в отчёт; аудит — запись на прогон", async () => {
    const auditBefore = (await sql("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'place.import'"))
      .rows[0].n as number;
    expect(auditBefore).toBeGreaterThan(0);
    const r = await writePlaces(appDb, "test-region", [], new Date(), {
      closedIds: ["gC", "gNotImported"],
      seenIds: ["gC"],
      complete: true,
    });
    expect(r.suspendedClosed).toBe(1);
    expect(r.missingFromGoogle).toBe(2); // gA, gB
    expect(r.missingExamples).toHaveLength(2);
    expect((await sql("SELECT status FROM places WHERE google_place_id = 'gC'")).rows[0].status).toBe(
      "suspended",
    );
    expect(
      (await sql("SELECT status FROM places WHERE google_place_id IN ('gA','gB') ORDER BY google_place_id"))
        .rows,
    ).toEqual([{ status: "published" }, { status: "published" }]);
    expect(
      (await sql("SELECT count(*)::int AS n FROM places WHERE source = 'manual' AND status = 'suspended'"))
        .rows[0].n,
    ).toBe(0);

    const audit = (
      await sql(
        `SELECT a.actor_type, a.entity_type, a.new_values, r.code FROM audit_logs a JOIN regions r ON r.id = a.region_id
         WHERE a.action = 'place.import' ORDER BY a.created_at DESC, a.id DESC LIMIT 1`,
      )
    ).rows[0];
    expect(audit).toMatchObject({ actor_type: "system", entity_type: "region", code: "test-region" });
    expect(audit.new_values).toMatchObject({
      source: "google",
      suspendedClosed: 1,
      suspendedIds: ["gC"],
      missingFromGoogle: 2,
      schedulesRejected: 0,
      inserted: 0,
    });
    expect(
      (await sql("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'place.import'")).rows[0].n,
    ).toBe(auditBefore + 1);

    // Неполная выгрузка — пропавшие не считаются.
    const partial = await writePlaces(appDb, "test-region", [], new Date(), { seenIds: [], complete: false });
    expect(partial.missingFromGoogle).toBeNull();
  });

  it("переразметка (0020): категорию импорта меняют новые правила, правку админки — нет; «не наши» — в архив", async () => {
    const t = new Date();
    await writePlaces(
      appDb,
      "test-region",
      [
        place("gR1", { categoryCode: "entertainment" }),
        place("gR2", { categoryCode: "entertainment" }),
        place("gR3", { categoryCode: "post" }),
        place("gR4", { categoryCode: "post" }),
      ],
      t,
    );
    const cat = async (id: string) =>
      (
        await sql(
          `SELECT c.code, p.status, p.import_category_id = p.category_id AS untouched
           FROM places p JOIN categories c ON c.id = p.category_id WHERE p.google_place_id = $1`,
          [id],
        )
      ).rows[0];
    expect(await cat("gR1")).toEqual({ code: "entertainment", status: "published", untouched: true });
    // Админка перенесла gR2 в «Музеї» и gR4 в «Сувеніри».
    await sql(
      `UPDATE places SET category_id = (SELECT id FROM categories WHERE code = 'museums' AND region_id = places.region_id)
       WHERE google_place_id = 'gR2'`,
    );
    await sql(
      `UPDATE places SET category_id = (SELECT id FROM categories WHERE code = 'souvenirs' AND region_id = places.region_id)
       WHERE google_place_id = 'gR4'`,
    );
    const r = await writePlaces(
      appDb,
      "test-region",
      [place("gR1", { categoryCode: "kids" }), place("gR2", { categoryCode: "kids" })],
      t,
      { rejectedIds: ["gR3", "gR4"] },
    );
    expect(r.recategorized).toBe(1);
    expect(r.archivedRejected).toBe(1);
    expect(await cat("gR1")).toEqual({ code: "kids", status: "published", untouched: true });
    expect(await cat("gR2")).toEqual({ code: "museums", status: "published", untouched: false });
    expect(await cat("gR3")).toMatchObject({ code: "post", status: "archived" });
    expect(await cat("gR4")).toMatchObject({ code: "souvenirs", status: "published" });
  });

  it("«не наши» не архивируются у мест партнёра и мест с действиями пользователя; id — в аудите прогона", async () => {
    const t = new Date();
    await writePlaces(
      appDb,
      "test-region",
      ["gA1", "gA2", "gA3"].map((id) => place(id, { categoryCode: "post" })),
      t,
    );
    const org = String(
      (
        await sql(
          `INSERT INTO organizations (region_id, name) SELECT region_id, 'Партнер' FROM places
           WHERE google_place_id = 'gA2' RETURNING id`,
        )
      ).rows[0].id,
    );
    await sql(`UPDATE places SET organization_id = $1 WHERE google_place_id = 'gA2'`, [org]);
    const user = String((await sql("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0].id);
    await sql(
      `INSERT INTO audit_logs (actor_type, actor_user_id, region_id, action, entity_type, entity_id)
       SELECT 'user', $1, region_id, 'place.update', 'place', id::text FROM places WHERE google_place_id = 'gA3'`,
      [user],
    );
    const r = await writePlaces(appDb, "test-region", [], t, { rejectedIds: ["gA1", "gA2", "gA3"] });
    expect(r.archivedRejected).toBe(1);
    expect(r.archivedIds).toEqual(["gA1"]);
    const status = async (id: string) =>
      (await sql("SELECT status FROM places WHERE google_place_id = $1", [id])).rows[0].status;
    expect(await status("gA1")).toBe("archived");
    expect(await status("gA2")).toBe("published");
    expect(await status("gA3")).toBe("published");
    const audit = (
      await sql(
        "SELECT new_values FROM audit_logs WHERE action = 'place.import' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
    ).rows[0].new_values;
    expect(audit).toMatchObject({ archivedRejected: 1, archivedIds: ["gA1"] });
  });

  it("доп. категории импорта не пересобираются у мест, где админка сменила основную категорию", async () => {
    const t = new Date();
    await writePlaces(
      appDb,
      "test-region",
      [place("gY1", { categoryCode: "car-service", extraCategoryCodes: ["help"] })],
      t,
    );
    await sql(
      `UPDATE places SET category_id = (SELECT id FROM categories WHERE code = 'museums' AND region_id = places.region_id)
       WHERE google_place_id = 'gY1'`,
    );
    const r = await writePlaces(
      appDb,
      "test-region",
      [place("gY1", { categoryCode: "car-service", extraCategoryCodes: ["active"] })],
      t,
    );
    expect(r.extraCategoriesWritten).toBe(0);
    const extras = (
      await sql(
        `SELECT c.code, x.source FROM place_extra_categories x JOIN places p ON p.id = x.place_id
         JOIN categories c ON c.id = x.category_id WHERE p.google_place_id = 'gY1' ORDER BY c.code`,
      )
    ).rows;
    expect(extras).toEqual([{ code: "help", source: "import" }]);
  });

  it("дополнительные категории (0020): импорт пересобирает свои, ручные (manual) не трогает", async () => {
    const t = new Date();
    await writePlaces(
      appDb,
      "test-region",
      [place("gX1", { categoryCode: "car-service", extraCategoryCodes: ["help"] })],
      t,
    );
    const extras = async () =>
      (
        await sql(
          `SELECT c.code, x.source FROM place_extra_categories x JOIN places p ON p.id = x.place_id
           JOIN categories c ON c.id = x.category_id WHERE p.google_place_id = 'gX1' ORDER BY c.code`,
        )
      ).rows;
    expect(await extras()).toEqual([{ code: "help", source: "import" }]);
    // Админка добавила «Сувеніри» вручную.
    await sql(
      `INSERT INTO place_extra_categories (region_id, place_id, category_id, source)
       SELECT p.region_id, p.id, c.id, 'manual' FROM places p JOIN categories c ON c.region_id = p.region_id
       WHERE p.google_place_id = 'gX1' AND c.code = 'souvenirs'`,
    );
    const r = await writePlaces(
      appDb,
      "test-region",
      [place("gX1", { categoryCode: "car-service", extraCategoryCodes: ["active"] })],
      t,
    );
    expect(r.extraCategoriesWritten).toBe(1);
    expect(await extras()).toEqual([
      { code: "active", source: "import" },
      { code: "souvenirs", source: "manual" },
    ]);
  });

  it("дополнительные категории: админка правила набор места (аудит place.extra_categories.edit) — импорт не пересобирает, даже если список очищен", async () => {
    const t = new Date();
    await writePlaces(
      appDb,
      "test-region",
      [place("gX2", { categoryCode: "car-service", extraCategoryCodes: ["help"] })],
      t,
    );
    const extras = async () =>
      (
        await sql(
          `SELECT c.code, x.source FROM place_extra_categories x JOIN places p ON p.id = x.place_id
           JOIN categories c ON c.id = x.category_id WHERE p.google_place_id = 'gX2' ORDER BY c.code`,
        )
      ).rows;
    expect(await extras()).toEqual([{ code: "help", source: "import" }]);
    // Админ очистил список: строк нет, в аудите — запись об изменении.
    await sql(
      `DELETE FROM place_extra_categories WHERE place_id IN (SELECT id FROM places WHERE google_place_id = 'gX2')`,
    );
    const user = String((await sql("INSERT INTO users DEFAULT VALUES RETURNING id")).rows[0].id);
    await sql(
      `INSERT INTO audit_logs (actor_type, actor_user_id, region_id, action, entity_type, entity_id)
       SELECT 'user', $1, region_id, 'place.extra_categories.edit', 'place', id::text FROM places WHERE google_place_id = 'gX2'`,
      [user],
    );
    const r = await writePlaces(
      appDb,
      "test-region",
      [place("gX2", { categoryCode: "car-service", extraCategoryCodes: ["help", "active"] })],
      t,
    );
    expect(r.extraCategoriesWritten).toBe(0);
    expect(await extras()).toEqual([]);
  });

  it("точечный импорт: Косів через options.localities, без пункту — NULL, категория закреплена; широкий прогон её не меняет и не архивирует", async () => {
    const t = new Date("2026-11-03T10:00:00Z");
    // Уже было от широкого импорта как «готель» (категорию ставил импорт) — точечный перезакрепляет.
    await writePlaces(appDb, "test-region", [place("gT3", { categoryCode: "hotels" })], t);
    const r = await writePlaces(
      appDb,
      "test-region",
      [
        place("gT1", { categoryCode: "nature", localityCode: "", week: null, at: { lon: 24.5, lat: 48.16 } }),
        place("gT2", { categoryCode: "museums", localityCode: "kosiv", at: { lon: 25.09, lat: 48.32 } }),
        place("gT3", { categoryCode: "nature" }),
      ],
      t,
      { localities: ALL_LOCALITIES, pinCategory: true },
    );
    expect(r).toMatchObject({
      inserted: 2,
      updated: 1,
      localitiesCreated: 1,
      suspendedClosed: 0,
      archivedRejected: 0,
      notPublished: [],
    });
    const rows = async () =>
      (
        await sql(
          `SELECT p.google_place_id AS id, p.status, c.code AS category, l.code AS locality, l.kind,
                  p.import_category_id IS NULL AS pinned
           FROM places p JOIN categories c ON c.id = p.category_id LEFT JOIN localities l ON l.id = p.locality_id
           WHERE p.google_place_id IN ('gT1', 'gT2', 'gT3') ORDER BY 1`,
        )
      ).rows;
    expect(await rows()).toEqual([
      { id: "gT1", status: "published", category: "nature", locality: null, kind: null, pinned: true },
      {
        id: "gT2",
        status: "published",
        category: "museums",
        locality: "kosiv",
        kind: "settlement",
        pinned: true,
      },
      {
        id: "gT3",
        status: "published",
        category: "nature",
        locality: "yaremche",
        kind: "settlement",
        pinned: true,
      },
    ]);

    // Широкий прогон: другая категория по типам, «не наше» по правилам — закреплённые не трогает.
    const broad = await writePlaces(
      appDb,
      "test-region",
      [
        place("gT1", { categoryCode: "hotels", extraCategoryCodes: ["active"] }),
        place("gT3", { categoryCode: "hotels" }),
      ],
      t,
      { rejectedIds: ["gT2"] },
    );
    expect(broad).toMatchObject({ recategorized: 0, archivedRejected: 0, extraCategoriesWritten: 0 });
    expect((await rows()).map((x) => [x.id, x.status, x.category, x.pinned])).toEqual([
      ["gT1", "published", "nature", true],
      ["gT2", "published", "museums", true],
      ["gT3", "published", "nature", true],
    ]);

    // Скрытое админкой место — в отчёте точечного прогона реальный статус, а не просто «обновлено».
    await sql("UPDATE places SET status = 'suspended' WHERE google_place_id = 'gT2'");
    const again = await writePlaces(
      appDb,
      "test-region",
      [place("gT2", { categoryCode: "museums", localityCode: "kosiv" })],
      t,
      { localities: ALL_LOCALITIES, pinCategory: true },
    );
    expect(again.notPublished).toEqual([{ googlePlaceId: "gT2", name: "Ресторан gT2", status: "suspended" }]);
  });

  it("только новые (--zones-only/--insert-only): существующие не обновляются, не скрываются и не архивируются", async () => {
    const t = new Date();
    await writePlaces(appDb, "test-region", [place("gIO1")], t);
    const r = await writePlaces(
      appDb,
      "test-region",
      [
        place("gIO1", { categoryCode: "hotels", phone: "+380671112233", address: "інша адреса" }),
        place("gIO2", { categoryCode: "cafes", localityCode: "tatariv" }),
      ],
      t,
      { insertOnly: true, closedIds: ["gIO1"], rejectedIds: ["gIO1"], seenIds: ["gIO2"], complete: true },
    );
    expect(r).toMatchObject({
      inserted: 1,
      updated: 0,
      suspendedClosed: 0,
      archivedRejected: 0,
      recategorized: 0,
      missingFromGoogle: null,
      insertedIds: ["gIO2"],
    });
    const rows = (
      await sql(
        `SELECT p.google_place_id AS id, p.status, p.phone, p.address_i18n->>'uk' AS address, c.code AS category
         FROM places p JOIN categories c ON c.id = p.category_id
         WHERE p.google_place_id IN ('gIO1','gIO2') ORDER BY p.google_place_id`,
      )
    ).rows;
    expect(rows).toEqual([
      {
        id: "gIO1",
        status: "published",
        phone: "+380987930729",
        address: "вулиця Свободи, 1, Яремче",
        category: "restaurants",
      },
      {
        id: "gIO2",
        status: "published",
        phone: "+380987930729",
        address: "вулиця Свободи, 1, Яремче",
        category: "cafes",
      },
    ]);
    const audit = (
      await sql(
        "SELECT new_values FROM audit_logs WHERE action = 'place.import' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
    ).rows[0];
    expect(audit.new_values).toMatchObject({ insertOnly: true, inserted: 1, updated: 0 });
  });
});
