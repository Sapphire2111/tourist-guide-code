// Блок 3 (ADR-0017): каталог на реальной PostgreSQL 17 + PostGIS (миграция 0012) под ролью приложения — RLS всех
// таблиц каталога (регион A не видит и не меняет строки региона B, без контекста — пусто), составные FK между
// регионами, один уровень категорий, append-only история бейджа, индексы выдачи, демо-seed (идемпотентность) и
// сервис каталога в транзакции региона (публикация, 422 без alt text, аудит). Без Docker — пропуск (проверяется в CI).
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, regionContext, withTenant, type Db } from "../../src/db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../../src/modules/audit/index.js";
import { CatalogError, CatalogRepository, CatalogService } from "../../src/modules/catalog/index.js";
import { seedCatalog, SEED_CATEGORIES, SEED_PLACES } from "../../src/seed/seed-catalog.js";
import { seedBase, seedUserId, type SeedBaseResult } from "../../src/seed/seed.js";
import { seedUuid } from "../../src/seed/ids.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

// Учётка только тестового контейнера.
const APP_LOGIN = "tg_api_catalog_test";
const APP_PASSWORD = "tg_api_catalog_test";
const INSUFFICIENT_PRIVILEGE = "42501";

const TABLES = [
  "categories",
  "localities",
  "place_badge_events",
  "place_extra_categories",
  "place_media",
  "place_schedule_exceptions",
  "place_schedules",
  "place_tags",
  "places",
  "tags",
] as const;

describe.skipIf(!dockerAvailable)(`Каталог (блок 3, миграция 0012)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let base: SeedBaseResult;
  let appUrl: string;

  beforeAll(async () => {
    tdb = await startDatabase();
    await tdb.client.query(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appUrl = url.toString();
    appDb = createDatabase({ connectionString: appUrl, maxConnections: 2 });
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);
  const placeId = (key: string, region: "a" | "b" = "a") => seedUuid(`catalog:${region}:place:${key}`);
  const categoryId = (code: string, region: "a" | "b" = "a") =>
    seedUuid(`catalog:${region}:category:${code}`);

  /** Прямой SQL под ролью app в транзакции с контекстом региона (как withTenant), откат в конце. */
  async function asApp<T>(regionId: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      if (regionId) await client.query("SELECT set_config('app.region_id', $1, true)", [regionId]);
      return await fn(client);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  }

  it("миграция: RLS (ENABLE + FORCE) на всех таблицах каталога, GIST-индексы точки мест", async () => {
    const { rows } = await sql(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY relname`,
      [TABLES],
    );
    expect(rows).toEqual(
      TABLES.map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
    );
    const { rows: idx } = await sql(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'places' ORDER BY indexname`,
    );
    const defs = Object.fromEntries(idx.map((r) => [r.indexname, r.indexdef as string]));
    expect(defs.places_location_geog_idx).toMatch(/USING gist \(\(\(location\)::geography\)\)/);
    expect(defs.places_region_status_category_idx).toMatch(/\(region_id, status, category_id\)/);
  });

  it("seed: корни — разделы SEED_CATEGORIES (9 с «Сервіси»), места с графиком; повторный запуск ничего не дублирует", async () => {
    const count = async () =>
      Object.fromEntries(
        await Promise.all(
          TABLES.map(async (t) => [
            t,
            (await sql(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number,
          ]),
        ),
      );
    const before = await count();
    await seedCatalog(ownerDb, base.regions);
    expect(await count()).toEqual(before);
    const { rows } = await sql(
      `SELECT count(*)::int AS n FROM categories WHERE region_id = $1 AND parent_id IS NULL AND home_section IS NOT NULL`,
      [base.regions.a],
    );
    expect(rows[0].n).toBe(SEED_CATEGORIES.length);
    expect(before.places).toBe(SEED_PLACES.length + 1);
    expect(before.place_schedules).toBeGreaterThan(0);
  });

  it.each(TABLES)("RLS %s: регион A не видит строк региона B; без контекста — пусто", async (table) => {
    const seenByA = await asApp(
      base.regions.a,
      async (c) =>
        (await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE region_id <> $1`, [base.regions.a]))
          .rows[0].n,
    );
    expect(seenByA).toBe(0);
    const noContext = await asApp(
      null,
      async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
    );
    expect(noContext).toBe(0);
  });

  it("RLS: регион A не меняет и не удаляет место региона B, не вставляет строку в B", async () => {
    const cafeB = placeId("cafe-b", "b");
    await asApp(base.regions.a, async (c) => {
      expect((await c.query(`UPDATE places SET recommended = true WHERE id = $1`, [cafeB])).rowCount).toBe(0);
      expect((await c.query(`DELETE FROM place_tags WHERE place_id = $1`, [cafeB])).rowCount).toBe(0);
      const err = await c
        .query(`INSERT INTO places (region_id, category_id, name_i18n) VALUES ($1, $2, '{"uk":"Чуже"}')`, [
          base.regions.b,
          categoryId("eat", "b"),
        ])
        .then(
          () => undefined,
          (e: { code?: string }) => e,
        );
      expect(err?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
    const { rows } = await sql(`SELECT recommended FROM places WHERE id = $1`, [cafeB]);
    expect(rows[0].recommended).toBe(false);
  });

  it("составные FK: место региона A с категорией региона B — отказ; тег B к месту A — отказ", async () => {
    await expect(
      sql(`INSERT INTO places (region_id, category_id, name_i18n) VALUES ($1, $2, '{"uk":"Х"}')`, [
        base.regions.a,
        categoryId("eat", "b"),
      ]),
    ).rejects.toThrow(/places_category_fk/);
    const tagB = await sql(
      `INSERT INTO tags (region_id, code, name_i18n) VALUES ($1, 'tag-b', '{"uk":"Б"}') RETURNING id`,
      [base.regions.b],
    );
    await expect(
      sql(`INSERT INTO place_tags (region_id, place_id, tag_id) VALUES ($1, $2, $3)`, [
        base.regions.a,
        placeId("cafe-kava"),
        tagB.rows[0].id,
      ]),
    ).rejects.toThrow(/place_tags_tag_fk/);
  });

  it("категории: один уровень вложенности; кнопка главной — только у корневой", async () => {
    await expect(
      sql(
        `INSERT INTO categories (region_id, parent_id, code, name_i18n) VALUES ($1, $2, 'deep', '{"uk":"Х"}')`,
        [base.regions.a, categoryId("cafes")],
      ),
    ).rejects.toThrow(/один уровень/);
    await expect(
      sql(`UPDATE categories SET parent_id = $1 WHERE id = $2`, [categoryId("eat"), categoryId("shop")]),
    ).rejects.toThrow(/подкатегории/);
    await expect(
      sql(
        `INSERT INTO categories (region_id, parent_id, code, name_i18n, home_section) VALUES ($1, $2, 'sub2', '{"uk":"Х"}', 'eat')`,
        [base.regions.a, categoryId("eat")],
      ),
    ).rejects.toThrow(/categories_home_section_root_only/);
  });

  it("опубликованное место без адреса — CHECK; история бейджа только дописывается (app)", async () => {
    await expect(
      sql(`UPDATE places SET address_i18n = NULL WHERE id = $1`, [placeId("cafe-kava")]),
    ).rejects.toThrow(/places_published_complete/);
    await asApp(base.regions.a, async (c) => {
      const err = await c.query(`UPDATE place_badge_events SET reason = 'x'`).then(
        () => undefined,
        (e: { code?: string }) => e,
      );
      expect(err?.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it("сервис в транзакции региона A: список — только A; фото без alt — 422; с alt — публикация и аудит", async () => {
    const service = new CatalogService(
      appDb,
      new CatalogRepository(appDb),
      new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS),
    );
    const meta = {
      actor: { type: "user" as const, userId: seedUserId("region-admin-a") },
      roleAssignmentId: null,
      requestId: "it-catalog",
    };
    const inA = regionContext(base.regions.a);
    const page = await withTenant(appDb, inA, () => service.listPlaces({ limit: 100 }));
    expect(page.items.map((p) => p.region_id)).toEqual(page.items.map(() => base.regions.a));
    expect(page.items.map((p) => p.id)).not.toContain(placeId("cafe-b", "b"));
    // Поиск по названию и фильтр по корневой категории (с подкатегориями).
    const found = await withTenant(appDb, inA, () => service.listPlaces({ q: "Ватра", limit: 10 }));
    expect(found.items.map((p) => p.id)).toEqual([placeId("kolyba-vatra")]);
    const eat = await withTenant(appDb, inA, () =>
      service.listPlaces({ categoryId: categoryId("eat"), limit: 50 }),
    );
    expect(eat.items).toHaveLength(3);
    expect(eat.items[0]!.location).toEqual(expect.objectContaining({ lon: expect.any(Number) }));
    // Чужое место по id — not_found.
    await expect(withTenant(appDb, inA, () => service.getPlace(placeId("cafe-b", "b")))).rejects.toThrow(
      CatalogError,
    );

    // Черновик SPA: заполняем описание, привязываем фото без alt — публикация 422.
    const spa = placeId("spa-ranok");
    const asset = await sql(
      `INSERT INTO media_assets (region_id, owner_type, owner_id, kind, status, mime, size_bytes, original_key)
       VALUES ($1, 'place', $2, 'image', 'ready', 'image/jpeg', 100, 'private/x/original') RETURNING id`,
      [base.regions.a, spa],
    );
    const assetId = asset.rows[0].id as string;
    await withTenant(appDb, inA, async () => {
      await service.updatePlace(meta, spa, { description: { uk: "Масаж і басейн" } });
      await service.attachMedia(meta, spa, assetId, { isCover: true });
    });
    const denied = await withTenant(appDb, inA, () => service.transition(meta, spa, "publish", null)).catch(
      (e: unknown) => e,
    );
    expect(denied).toBeInstanceOf(CatalogError);
    expect((denied as CatalogError).problems).toEqual(["media_alt_missing"]);
    const published = await withTenant(appDb, inA, async () => {
      await service.updateMedia(meta, spa, assetId, { alt: { uk: "Басейн SPA" } });
      return service.transition(meta, spa, "publish", "перевірено");
    });
    expect(published.status).toBe("published");
    const { rows: audit } = await sql(
      `SELECT action, region_id, actor_user_id FROM audit_logs WHERE entity_id = $1 ORDER BY created_at, id`,
      [spa],
    );
    expect(audit.map((r) => r.action)).toEqual([
      "place.edit",
      "media.attach",
      "media.update",
      "place.publish",
    ]);
    expect(new Set(audit.map((r) => r.region_id))).toEqual(new Set([base.regions.a]));

    // График: замена и чтение в таймзоне региона.
    const schedule = await withTenant(appDb, inA, () =>
      service.replaceSchedule(meta, spa, {
        weekly: [{ dayOfWeek: 1, opensAt: "10:00", closesAt: "20:00" }],
        exceptions: [{ date: "2026-12-31", closed: true }],
      }),
    );
    expect(schedule).toEqual({
      timezone: "Europe/Kyiv",
      weekly: [{ dayOfWeek: 1, opensAt: "10:00", closesAt: "20:00" }],
      exceptions: [{ date: "2026-12-31", closed: true, opensAt: null, closesAt: null, note: null }],
    });
  });
  // --- Сценарии, которые unit-фейк (memory-sql) не вычисляет: курсор, OR/подзапросы, удаление, ограничения БД. ---

  const svc = () =>
    new CatalogService(
      appDb,
      new CatalogRepository(appDb),
      new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS),
    );
  const actor = {
    actor: { type: "user" as const, userId: seedUserId("region-admin-a") },
    roleAssignmentId: null,
    requestId: "it-catalog-2",
  };
  const inRegionA = <T>(fn: () => Promise<T>) => withTenant(appDb, regionContext(base.regions.a), fn);
  const reasonOf = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (e: unknown) => (e instanceof CatalogError ? e.reason : String(e)),
    );
  const newAsset = async (owner: string) =>
    (
      await sql(
        `INSERT INTO media_assets (region_id, owner_type, owner_id, kind, status, mime, size_bytes, original_key)
         VALUES ($1, 'place', $2, 'image', 'ready', 'image/jpeg', 100, 'private/y/original') RETURNING id`,
        [base.regions.a, owner],
      )
    ).rows[0].id as string;

  it("курсор: страницы без пересечений и пропусков, новые сверху; последняя — без следующей", async () => {
    const all = await inRegionA(() => svc().listPlaces({ limit: 100 }));
    const seen: string[] = [];
    let afterId: string | undefined;
    for (;;) {
      const page = await inRegionA(() => svc().listPlaces({ limit: 4, afterId }));
      seen.push(...page.items.map((p) => p.id));
      if (!page.hasMore) break;
      afterId = page.items.at(-1)!.id;
    }
    expect(seen).toEqual(all.items.map((p) => p.id));
    expect([...seen].sort().reverse()).toEqual(seen);
    const drafts = await inRegionA(() => svc().listPlaces({ status: "draft", limit: 100 }));
    expect(drafts.items.every((p) => p.status === "draft")).toBe(true);
  });

  it("фото: смена обложки снимает прежнюю, повторная привязка — media_already_linked, отвязка", async () => {
    const place = placeId("cafe-kava");
    const [a1, a2] = [await newAsset(place), await newAsset(place)];
    await inRegionA(async () => {
      await svc().attachMedia(actor, place, a1, { alt: { uk: "Зала" }, isCover: true });
      await svc().attachMedia(actor, place, a2, { alt: { uk: "Тераса" } });
    });
    const covers = await inRegionA(async () => {
      await svc().updateMedia(actor, place, a2, { isCover: true });
      return (await svc().listMedia(place)).filter((m) => m.is_cover).map((m) => m.media_asset_id);
    });
    expect(covers).toEqual([a2]);
    expect(await reasonOf(inRegionA(() => svc().attachMedia(actor, place, a1, {})))).toBe(
      "media_already_linked",
    );
    await inRegionA(() => svc().detachMedia(actor, place, a1));
    expect((await inRegionA(() => svc().listMedia(place))).map((m) => m.media_asset_id)).toEqual([a2]);
    expect(await reasonOf(inRegionA(() => svc().detachMedia(actor, place, a1)))).toBe("not_found");
  });

  it("опубликованное место: фото без alt — 422 и откат привязки; снятие alt — 422 и alt на месте", async () => {
    const place = placeId("shop-pysanka");
    const asset = await newAsset(place);
    expect(await reasonOf(inRegionA(() => svc().attachMedia(actor, place, asset, {})))).toBe(
      "not_publishable",
    );
    expect(
      (await sql(`SELECT count(*)::int AS n FROM place_media WHERE media_asset_id = $1`, [asset])).rows[0].n,
    ).toBe(0);
    await inRegionA(() => svc().attachMedia(actor, place, asset, { alt: { uk: "Вітрина" } }));
    expect(await reasonOf(inRegionA(() => svc().updateMedia(actor, place, asset, { alt: null })))).toBe(
      "not_publishable",
    );
    const { rows } = await sql(`SELECT alt_i18n FROM media_assets WHERE id = $1`, [asset]);
    expect(rows[0].alt_i18n).toEqual({ uk: "Вітрина" });
  });

  it("удаление: место с историей бейджа — not_deletable; используемые категория и населённый пункт — in_use", async () => {
    // Черновик, ни разу не публиковавшийся, но с историей бейджа (выдан и снят) — только архив.
    const draft = await inRegionA(async () => {
      const p = await svc().createPlace(actor, { categoryId: categoryId("cafes"), name: { uk: "Чернетка" } });
      await svc().setBadge(actor, p.id, true, "тест");
      await svc().setBadge(actor, p.id, false, "тест");
      return p;
    });
    expect(draft.status).toBe("draft");
    expect(await reasonOf(inRegionA(() => svc().deletePlace(actor, draft.id)))).toBe("not_deletable");
    const clean = await inRegionA(() =>
      svc().createPlace(actor, { categoryId: categoryId("cafes"), name: { uk: "Без історії" } }),
    );
    expect(await reasonOf(inRegionA(() => svc().deletePlace(actor, clean.id)))).toBe("ok");
    expect(await reasonOf(inRegionA(() => svc().deleteCategory(actor, categoryId("cafes"))))).toBe("in_use");
    expect(await reasonOf(inRegionA(() => svc().deleteCategory(actor, categoryId("eat"))))).toBe("in_use");
    expect(
      await reasonOf(inRegionA(() => svc().deleteLocality(actor, seedUuid("catalog:a:locality:yaremche")))),
    ).toBe("in_use");
  });

  it("архив → публикация сразу; выключение категории с опубликованными местами — 409", async () => {
    const place = placeId("taxi-gory");
    const archived = await inRegionA(() => svc().transition(actor, place, "archive", null));
    expect(archived.status).toBe("archived");
    const back = await inRegionA(() => svc().transition(actor, place, "publish", "повернули"));
    expect(back.status).toBe("published");
    // Раздел «Трансфер»: опубликованное место в подкатегории taxi.
    expect(
      await reasonOf(inRegionA(() => svc().updateCategory(actor, categoryId("transfer"), { active: false }))),
    ).toBe("category_has_published_places");
    expect(
      await reasonOf(inRegionA(() => svc().updateCategory(actor, categoryId("rental"), { active: false }))),
    ).toBe("ok");
  });

  it("параллельные PATCH «A под B» и «B под A» не создают цикл: одна правка проходит, вторая — отказ", async () => {
    const make = async (code: string) =>
      (
        await sql(
          `INSERT INTO categories (region_id, code, name_i18n) VALUES ($1, $2, '{"uk":"Х"}') RETURNING id`,
          [base.regions.a, code],
        )
      ).rows[0].id as string;
    const [a, b] = [await make("race-a"), await make("race-b")];
    const results = await Promise.all([
      reasonOf(inRegionA(() => svc().updateCategory(actor, a, { parentId: b }))),
      reasonOf(inRegionA(() => svc().updateCategory(actor, b, { parentId: a }))),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok")).toEqual([
      expect.stringMatching(/parent_not_root|has_subcategories/),
    ]);
    const { rows } = await sql(
      `SELECT count(*)::int AS n FROM categories WHERE id = ANY($1) AND parent_id IS NOT NULL`,
      [[a, b]],
    );
    expect(rows[0].n).toBe(1);
  });
  it("выключение категории ∥ публикация места в ней: проходит одно, неактивной категории с опубликованным местом нет", async () => {
    const cat = (
      await sql(
        `INSERT INTO categories (region_id, parent_id, code, name_i18n) VALUES ($1, $2, 'race-cat', '{"uk":"Х"}') RETURNING id`,
        [base.regions.a, categoryId("fun")],
      )
    ).rows[0].id as string;
    const place = await inRegionA(() =>
      svc().createPlace(actor, {
        categoryId: cat,
        name: { uk: "Гонка" },
        description: { uk: "Опис" },
        address: { uk: "Адреса" },
        location: { lon: 24.55, lat: 48.45 },
      }),
    );
    const results = await Promise.all([
      reasonOf(inRegionA(() => svc().updateCategory(actor, cat, { active: false }))),
      reasonOf(inRegionA(() => svc().transition(actor, place.id, "publish", null))),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok")).toEqual([
      expect.stringMatching(/category_has_published_places|not_publishable/),
    ]);
    const { rows } = await sql(
      `SELECT c.active, p.status FROM places p JOIN categories c ON c.id = p.category_id WHERE p.id = $1`,
      [place.id],
    );
    expect(rows[0].active === false && rows[0].status === "published").toBe(false);
  });
});
