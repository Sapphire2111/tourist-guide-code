// Прайс заведения (миграция 0030) на реальной PostgreSQL 17 под ролью приложения: RLS и права app на новых таблицах,
// CHECK цены и составной FK «позиция — раздел того же места», правка владельцем и менеджером (кассир — 403),
// версия (409), ▲▼, скрытие и архив, AuditLog; карточка туриста — только видимые позиции опубликованного места
// партнёра, черновик — 404, чужой регион — 404. Без Docker — пропуск (CI).
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../../src/modules/audit/index.js";
import { CatalogRepository, CatalogService } from "../../src/modules/catalog/index.js";
import { EmergencyContactsRepository } from "../../src/modules/emergency-contacts/index.js";
import { GuideRepository, GuideService } from "../../src/modules/guide/index.js";
import { NotificationsService } from "../../src/modules/host/index.js";
import type { MediaService } from "../../src/modules/media/index.js";
import {
  PartnerRepository,
  PartnerService,
  PriceListRepository,
  PriceListService,
  type PartnerAuditMeta,
} from "../../src/modules/partner/index.js";
import {
  dbScopeParentLoaders,
  RbacService,
  RoleAssignmentsRepository,
  ScopeHierarchy,
} from "../../src/modules/rbac/index.js";
import { RegionsRepository } from "../../src/modules/regions/index.js";
import { RoleAssignmentService } from "../../src/modules/role-assignments/index.js";
import { seedUuid } from "../../src/seed/ids.js";
import { seedCatalog } from "../../src/seed/seed-catalog.js";
import { seedBase, type SeedBaseResult } from "../../src/seed/seed.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const APP_LOGIN = "tg_api_price_list_test";
const APP_PASSWORD = "tg_api_price_list_test";

const OWNER = seedUuid("price-list-test:user:owner");
const MANAGER = seedUuid("price-list-test:user:manager");
const CASHIER = seedUuid("price-list-test:user:cashier");
const OTHER = seedUuid("price-list-test:user:other-org");

const meta = (userId: string): PartnerAuditMeta => ({
  actor: { type: "user", userId },
  roleAssignmentId: null,
  requestId: "it-price-list",
});

async function failure(p: Promise<unknown>): Promise<{ status: number; reason?: unknown }> {
  const e = (await p.then(
    () => undefined,
    (err: unknown) => err,
  )) as { getStatus?: () => number; details?: { reason?: unknown } } | undefined;
  if (!e?.getStatus) throw new Error(`Ожидалась ApiError, получено: ${String(e)}`);
  return { status: e.getStatus(), reason: e.details?.reason };
}

describe.skipIf(!dockerAvailable)(`Прайс заведения (миграция 0030)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let base: SeedBaseResult;
  let partner: PartnerService;
  let prices: PriceListService;
  let guide: GuideService;
  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);
  let orgId = "";
  let placeId = "";

  beforeAll(async () => {
    tdb = await startDatabase();
    await sql(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    for (const [id, tg] of [
      [OWNER, 990000000701],
      [MANAGER, 990000000702],
      [CASHIER, 990000000703],
      [OTHER, 990000000704],
    ] as const) {
      await sql(`INSERT INTO users (id, status, language, display_name) VALUES ($1, 'active', 'uk', $2)`, [
        id,
        `Партнер ${tg}`,
      ]);
      await sql(
        `INSERT INTO telegram_accounts (user_id, telegram_user_id, username, first_name, last_auth_date)
         VALUES ($1, $2, $3, 'Тест', now())`,
        [id, tg, `price_test_${tg}`],
      );
    }
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
    const hierarchy = new ScopeHierarchy(dbScopeParentLoaders(appDb));
    const audit = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);
    const rbac = new RbacService(new RoleAssignmentsRepository(appDb), hierarchy);
    const catalogRepo = new CatalogRepository(appDb);
    const catalog = new CatalogService(appDb, catalogRepo, audit);
    const notifications = new NotificationsService(appDb, { send: () => Promise.resolve() });
    const media = {
      find: () => Promise.resolve(undefined),
      links: () => Promise.resolve([]),
    } as unknown as MediaService;
    partner = new PartnerService(
      appDb,
      new PartnerRepository(appDb),
      catalogRepo,
      catalog,
      new RegionsRepository(appDb),
      rbac,
      hierarchy,
      new RoleAssignmentService(audit, hierarchy),
      audit,
      notifications,
      media,
      {},
    );
    prices = new PriceListService(appDb, new PriceListRepository(appDb), partner, audit);
    guide = new GuideService(
      appDb,
      new GuideRepository(appDb),
      new RegionsRepository(appDb),
      new EmergencyContactsRepository(appDb),
      media,
    );

    const result = await partner.onboard(
      OWNER,
      {
        regionId: base.regions.a,
        templateCode: "food",
        categoryId: seedUuid("catalog:a:category:cafes"),
        name: { uk: "Колиба «Ватра»" },
      },
      meta(OWNER),
    );
    orgId = result.organization.id;
    placeId = result.place.id;
    for (const [user, role] of [
      [MANAGER, "ORG_MANAGER"],
      [CASHIER, "ORG_STAFF"],
    ] as const) {
      const invite = await partner.createInvite(OWNER, orgId, role, meta(OWNER));
      await partner.acceptInvite(user, invite.token, meta(user));
    }
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  it("миграция 0030: RLS (FORCE) и права app без DELETE", async () => {
    expect(tdb!.applied).toContain("0030_price_lists.sql");
    const tables = ["price_list_sections", "price_list_items"];
    const { rows } = await sql(
      `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity`,
      [tables],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
    const privs = await sql(
      `SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'app' AND table_name = ANY($1) ORDER BY 1`,
      [tables],
    );
    expect(privs.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("правка: владелец и менеджер; кассир — 403; версия — 409; ▲▼; AuditLog", async () => {
    expect(await failure(prices.get(CASHIER, placeId))).toMatchObject({ status: 403 });
    expect(
      await failure(prices.createSection(CASHIER, placeId, { title: { uk: "Страви" } }, meta(CASHIER))),
    ).toMatchObject({ status: 403 });

    let list = await prices.createSection(OWNER, placeId, { title: { uk: "Страви" } }, meta(OWNER));
    list = await prices.createSection(MANAGER, placeId, { title: { uk: "Напої" } }, meta(MANAGER));
    const [food, drinks] = list.sections.map((s) => s.id);
    list = await prices.createItem(
      MANAGER,
      placeId,
      { sectionId: food!, name: { uk: "Банош" }, priceMinor: 18000, unit: { uk: "за порцію" } },
      meta(MANAGER),
    );
    list = await prices.createItem(
      OWNER,
      placeId,
      { sectionId: food!, name: { uk: "Бограч" }, priceMinor: 22000, priceFrom: true },
      meta(OWNER),
    );
    list = await prices.createItem(
      OWNER,
      placeId,
      { sectionId: drinks!, name: { uk: "Узвар" }, priceMinor: 4000, description: { uk: "Домашній" } },
      meta(OWNER),
    );
    expect(list.itemCount).toBe(3);
    const bograch = list.sections[0]!.items[1]!;
    expect(bograch).toMatchObject({ priceMinor: 22000, priceFrom: true, currency: "UAH", version: 1 });

    list = await prices.moveItem(OWNER, placeId, bograch.id, "up", meta(OWNER));
    expect(list.sections[0]!.items.map((i) => i.name.uk)).toEqual(["Бограч", "Банош"]);
    list = await prices.moveSection(OWNER, placeId, drinks!, "up", meta(OWNER));
    expect(list.sections.map((s) => s.title.uk)).toEqual(["Напої", "Страви"]);

    const current = list.sections[1]!.items[0]!;
    expect(
      await failure(
        prices.updateItem(
          OWNER,
          placeId,
          current.id,
          { priceMinor: 1, version: current.version - 1 },
          meta(OWNER),
        ),
      ),
    ).toEqual({ status: 409, reason: "version_conflict" });

    const audit = await sql(
      `SELECT action FROM audit_logs WHERE action LIKE 'price_list.%' AND region_id = $1 ORDER BY created_at`,
      [base.regions.a],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "price_list.section.create",
      "price_list.section.create",
      "price_list.item.create",
      "price_list.item.create",
      "price_list.item.create",
      "price_list.item.move",
      "price_list.section.move",
    ]);
  });

  it("чужая организация — 403; раздел/позиция другого места в пути — 404", async () => {
    const other = await partner.onboard(
      OTHER,
      {
        regionId: base.regions.a,
        templateCode: "food",
        categoryId: seedUuid("catalog:a:category:cafes"),
        name: { uk: "Кафе «Інше»" },
      },
      meta(OTHER),
    );
    const otherPlace = other.place.id;
    expect(await failure(prices.get(OTHER, placeId))).toMatchObject({ status: 403, reason: "not_partner" });
    expect(
      await failure(prices.createSection(OTHER, placeId, { title: { uk: "Злам" } }, meta(OTHER))),
    ).toMatchObject({ status: 403 });

    let theirs = await prices.createSection(OTHER, otherPlace, { title: { uk: "Кава" } }, meta(OTHER));
    const otherSection = theirs.sections[0]!.id;
    theirs = await prices.createItem(
      OTHER,
      otherPlace,
      { sectionId: otherSection, name: { uk: "Лате" }, priceMinor: 6000 },
      meta(OTHER),
    );
    const otherItem = theirs.sections[0]!.items[0]!.id;
    expect(
      await failure(prices.updateSection(OWNER, placeId, otherSection, { hidden: true }, meta(OWNER))),
    ).toMatchObject({ status: 404 });
    expect(await failure(prices.archiveItem(OWNER, placeId, otherItem, meta(OWNER)))).toMatchObject({
      status: 404,
    });
    expect(
      await failure(
        prices.createItem(
          OWNER,
          placeId,
          { sectionId: otherSection, name: { uk: "x" }, priceMinor: 1 },
          meta(OWNER),
        ),
      ),
    ).toMatchObject({ status: 404 });
    // Чужие строки не тронуты.
    expect((await prices.get(OTHER, otherPlace)).sections[0]).toMatchObject({
      hidden: false,
      items: [expect.objectContaining({ id: otherItem })],
    });
  });

  it("БД: цена ≥ 0, позиция не уходит в раздел чужого места", async () => {
    const section = await sql(`SELECT id FROM price_list_sections WHERE place_id = $1 LIMIT 1`, [placeId]);
    await expect(
      sql(
        `INSERT INTO price_list_items (region_id, place_id, section_id, name_i18n, price_minor)
         VALUES ($1, $2, $3, '{"uk": "x"}', -1)`,
        [base.regions.a, placeId, section.rows[0].id],
      ),
    ).rejects.toThrow(/price_list_items_price_check/);
    const other = await sql(`SELECT id FROM places WHERE region_id = $1 AND id <> $2 ORDER BY id LIMIT 1`, [
      base.regions.a,
      placeId,
    ]);
    await expect(
      sql(
        `INSERT INTO price_list_items (region_id, place_id, section_id, name_i18n, price_minor)
         VALUES ($1, $2, $3, '{"uk": "x"}', 100)`,
        [base.regions.a, other.rows[0].id, section.rows[0].id],
      ),
    ).rejects.toThrow(/price_list_items_section_fk/);
  });

  it("карточка: черновик — 404; опубликованное — только видимые; скрытые и архивные не видны; чужой регион — 404", async () => {
    expect(await guide.priceList(base.regions.a, placeId)).toBeUndefined();
    await sql(
      `UPDATE places SET status = 'published', first_published_at = now(), description_i18n = '{"uk": "Колиба"}',
         address_i18n = '{"uk": "Косів"}', location = ST_SetSRID(ST_MakePoint(25.09, 48.31), 4326)
       WHERE id = $1`,
      [placeId],
    );
    expect((await guide.place(base.regions.a, placeId, {}))?.hasPriceList).toBe(true);
    let card = await guide.priceList(base.regions.a, placeId);
    expect(card!.sections.map((s) => [s.title.uk, s.items.map((i) => i.name.uk)])).toEqual([
      ["Напої", ["Узвар"]],
      ["Страви", ["Бограч", "Банош"]],
    ]);

    const list = await prices.get(OWNER, placeId);
    const drinks = list.sections[0]!;
    const banosh = list.sections[1]!.items[1]!;
    await prices.updateSection(
      OWNER,
      placeId,
      drinks.id,
      { hidden: true, version: drinks.version },
      meta(OWNER),
    );
    await prices.archiveItem(OWNER, placeId, banosh.id, meta(OWNER));
    card = await guide.priceList(base.regions.a, placeId);
    expect(card!.sections.map((s) => [s.title.uk, s.items.map((i) => i.name.uk)])).toEqual([
      ["Страви", ["Бограч"]],
    ]);
    expect(card!.sections[0]!.items[0]).toMatchObject({ priceMinor: 22000, priceFrom: true, unit: null });
    expect((await prices.get(OWNER, placeId)).itemCount).toBe(2);

    expect(await guide.priceList(base.regions.b, placeId)).toBeUndefined();
  });
});
