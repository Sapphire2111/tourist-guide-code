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
});
