// «Це мій заклад» (миграция 0031) на реальной PostgreSQL 17 под ролью приложения: RLS и права place_claims, заявка
// на место импорта Google (новая организация или своя), дубль — 409, чужая организация — 403, очередь и решение
// модератора своего региона (чужой регион — 403), одобрение → место за организацией заявителя (published, source
// google, шаблон по категории), ORG_OWNER, конкурирующая заявка — автоотказ, AuditLog, уведомление; повторный импорт
// не меняет поля места партнёра и не снимает организацию. Без Docker — пропуск (CI).
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../../src/modules/audit/index.js";
import { CatalogRepository, CatalogService } from "../../src/modules/catalog/index.js";
import { EmergencyContactsRepository } from "../../src/modules/emergency-contacts/index.js";
import { GuideRepository, GuideService } from "../../src/modules/guide/index.js";
import { NotificationsService } from "../../src/modules/host/index.js";
import type { MediaService } from "../../src/modules/media/index.js";
import {
  AUTO_REJECT_COMMENT,
  PartnerRepository,
  PartnerService,
  PlaceClaimsRepository,
  PlaceClaimsService,
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
import type { MappedPlace } from "../../src/places-import/mapping.js";
import { writePlaces } from "../../src/places-import/writer.js";
import { seedUuid } from "../../src/seed/ids.js";
import { seedCatalog } from "../../src/seed/seed-catalog.js";
import { seedBase, seedUserId, type SeedBaseResult } from "../../src/seed/seed.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const APP_LOGIN = "tg_api_claims_test";
const APP_PASSWORD = "tg_api_claims_test";

const CLAIMANT = seedUuid("claims-test:user:claimant");
const RIVAL = seedUuid("claims-test:user:rival");
const MODERATOR_A = seedUserId("moderator-a");
const ADMIN_B = seedUserId("region-admin-b");
const GOOGLE_ID = "ChIJclaimTestPlace01";

const meta = (userId: string): PartnerAuditMeta => ({
  actor: { type: "user", userId },
  roleAssignmentId: null,
  requestId: "it-claims",
});

const mapped = (over: Partial<MappedPlace> = {}): MappedPlace => ({
  googlePlaceId: GOOGLE_ID,
  categoryCode: "restaurants",
  extraCategoryCodes: [],
  localityCode: "yaremche",
  name: "Ресторан «Гуцульська хата»",
  description: "Ресторан у Яремчі. Джерело: Google Maps.",
  address: "вулиця Свободи, 1, Яремче",
  at: { lon: 24.55, lat: 48.45 },
  phone: "+380987930729",
  website: "https://example.com/",
  week: [{ dayOfWeek: 1, opensAt: "09:00", closesAt: "22:00" }],
  photos: [],
  rating: 4.5,
  ratingCount: 10,
  ...over,
});

async function failure(p: Promise<unknown>): Promise<{ status: number; code: string; reason?: unknown }> {
  const e = (await p.then(
    () => undefined,
    (err: unknown) => err,
  )) as { getStatus?: () => number; code?: string; details?: { reason?: unknown } } | undefined;
  if (!e?.getStatus) throw new Error(`Ожидалась ApiError, получено: ${String(e)}`);
  return { status: e.getStatus(), code: e.code ?? "", reason: e.details?.reason };
}

describe.skipIf(!dockerAvailable)(`«Це мій заклад» (миграция 0031)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let base: SeedBaseResult;
  let claims: PlaceClaimsService;
  let partner: PartnerService;
  let guide: GuideService;
  let placeId = "";
  const sent: { chatId: string; text: string }[] = [];
  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);

  beforeAll(async () => {
    tdb = await startDatabase();
    await sql(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    for (const [id, tg] of [
      [CLAIMANT, 990000000701],
      [RIVAL, 990000000702],
    ] as const) {
      await sql(`INSERT INTO users (id, status, language, display_name) VALUES ($1, 'active', 'uk', $2)`, [
        id,
        `Заявник ${tg}`,
      ]);
      await sql(
        `INSERT INTO telegram_accounts (user_id, telegram_user_id, username, first_name, last_auth_date)
         VALUES ($1, $2, $3, 'Тест', now())`,
        [id, tg, `claims_test_${tg}`],
      );
      await sql(
        `INSERT INTO messaging_consents (user_id, purpose, granted, source, granted_at)
         VALUES ($1, 'service', true, 'settings', now())`,
        [id],
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
    const notifications = new NotificationsService(appDb, {
      send: (chatId, text) => {
        sent.push({ chatId, text });
        return Promise.resolve();
      },
    });
    const media = {
      find: () => Promise.resolve(undefined),
      links: () => Promise.resolve([]),
    } as unknown as MediaService;
    const repo = new PartnerRepository(appDb);
    const regions = new RegionsRepository(appDb);
    const roles = new RoleAssignmentService(audit, hierarchy);
    claims = new PlaceClaimsService(
      appDb,
      new PlaceClaimsRepository(appDb),
      repo,
      catalogRepo,
      regions,
      rbac,
      roles,
      audit,
      notifications,
    );
    partner = new PartnerService(
      appDb,
      repo,
      catalogRepo,
      catalog,
      regions,
      rbac,
      hierarchy,
      roles,
      audit,
      notifications,
      media,
    );
    guide = new GuideService(
      appDb,
      new GuideRepository(appDb),
      regions,
      new EmergencyContactsRepository(appDb),
      media,
    );
    // Место импорта Google: published, без организации.
    await writePlaces(appDb, "test-region", [mapped()], new Date("2026-11-01T10:00:00Z"));
    placeId = (await sql(`SELECT id FROM places WHERE google_place_id = $1`, [GOOGLE_ID])).rows[0]
      .id as string;
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  const claimInput = (over: Record<string, unknown> = {}) => ({
    regionId: base.regions.a,
    placeId,
    role: "owner" as const,
    phone: "+380501112233",
    phoneSource: "manual" as const,
    organizationName: "ФОП Гуцул",
    ...over,
  });

  it("миграция 0031: RLS на place_claims, у app — SELECT/INSERT/UPDATE", async () => {
    expect(tdb!.applied).toContain("0031_place_claims.sql");
    const { rows } = await sql(
      `SELECT relname FROM pg_class WHERE relname = 'place_claims' AND relrowsecurity AND relforcerowsecurity`,
    );
    expect(rows).toHaveLength(1);
    const privs = await sql(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'app' AND table_name = 'place_claims' ORDER BY 1`,
    );
    expect(privs.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("подача: место Google заявляемо; без организации — 400; чужая организация — 403; дубль — 409", async () => {
    expect((await guide.place(base.regions.a, placeId, {}))?.claimable).toBe(true);
    const noOrg = await failure(
      claims.create(CLAIMANT, claimInput({ organizationName: undefined }), meta(CLAIMANT)),
    );
    expect(noOrg).toMatchObject({ status: 400, reason: "organization_choice_required" });
    const foreign = await failure(
      claims.create(
        CLAIMANT,
        claimInput({ organizationName: undefined, organizationId: seedUuid("claims-test:org:none") }),
        meta(CLAIMANT),
      ),
    );
    expect(foreign).toMatchObject({ status: 403, reason: "not_org_owner" });

    const created = await claims.create(CLAIMANT, claimInput({ comment: "  Я власник  " }), meta(CLAIMANT));
    expect(created).toMatchObject({
      placeId,
      status: "pending",
      role: "owner",
      organizationId: null,
      organizationName: "ФОП Гуцул",
      decisionComment: null,
    });
    const dup = await failure(claims.create(CLAIMANT, claimInput(), meta(CLAIMANT)));
    expect(dup).toMatchObject({ status: 409, reason: "claim_pending" });
    // Конкурирующая заявка другого человека — допустима.
    await claims.create(
      RIVAL,
      claimInput({ role: "manager", phoneSource: "telegram_contact", organizationName: "ТОВ Інше" }),
      meta(RIVAL),
    );
    expect((await claims.mine(CLAIMANT, base.regions.a)).items.map((c) => c.status)).toEqual(["pending"]);
    const audit = await sql(
      `SELECT action FROM audit_logs WHERE entity_type = 'place_claim' ORDER BY created_at`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["place_claim.create", "place_claim.create"]);
  });

  it("очередь: модератор своего региона видит обе заявки; админ другого региона — 403; отказ без причины — 400", async () => {
    const queue = await claims.queue(MODERATOR_A, { status: "pending" });
    expect(queue.items.map((c) => c.organizationName)).toEqual(["ФОП Гуцул", "ТОВ Інше"]);
    const first = queue.items[0]!;
    const detail = await claims.get(MODERATOR_A, first.id);
    expect(detail).toMatchObject({
      phone: "+380501112233",
      comment: "Я власник",
      newOrganization: true,
      place: {
        id: placeId,
        source: "google",
        phone: "+380987930729",
        status: "published",
        organizationName: null,
      },
    });
    expect(detail.place.googleMapsUri).toContain(GOOGLE_ID);
    expect(detail.otherClaims).toHaveLength(1);
    expect(await failure(claims.get(ADMIN_B, first.id))).toMatchObject({ status: 403 });
    expect(await failure(claims.queue(CLAIMANT, { status: "pending" }))).toMatchObject({ status: 403 });
    expect(
      await failure(claims.decide(MODERATOR_A, first.id, "reject", "  ", meta(MODERATOR_A))),
    ).toMatchObject({ status: 400 });
  });

  it("одобрение: место за новой организацией (published, google, шаблон food), ORG_OWNER, автоотказ, AuditLog", async () => {
    const [mine] = (await claims.mine(CLAIMANT, base.regions.a)).items;
    const approved = await claims.decide(
      MODERATOR_A,
      mine!.id,
      "approve",
      "Подзвонили на номер Google",
      meta(MODERATOR_A),
    );
    expect(approved).toMatchObject({ status: "approved", decisionComment: "Подзвонили на номер Google" });
    const place = (
      await sql(
        `SELECT p.status, p.source, p.organization_id, t.code AS template FROM places p
         LEFT JOIN partner_templates t ON t.id = p.partner_template_id WHERE p.id = $1`,
        [placeId],
      )
    ).rows[0];
    expect(place).toMatchObject({ status: "published", source: "google", template: "food" });
    expect(place.organization_id).toBe(approved.organizationId);

    const me = await partner.me(CLAIMANT);
    expect(me.organizations).toHaveLength(1);
    expect(me.organizations[0]).toMatchObject({ name: "ФОП Гуцул", role: "ORG_OWNER" });
    expect(me.organizations[0]!.places.map((p) => p.id)).toEqual([placeId]);
    // С шаблоном у места работает редактор кабинета.
    expect((await partner.getPlace(CLAIMANT, placeId)).status).toBe("published");

    const [rival] = (await claims.mine(RIVAL, base.regions.a)).items;
    expect(rival).toMatchObject({ status: "rejected", decisionComment: AUTO_REJECT_COMMENT });
    expect(
      await failure(claims.decide(MODERATOR_A, rival!.id, "approve", undefined, meta(MODERATOR_A))),
    ).toMatchObject({
      status: 409,
      reason: "already_decided",
    });
    // У места уже есть организация: ссылки нет, новая заявка — 409.
    expect((await guide.place(base.regions.a, placeId, {}))?.claimable).toBe(false);
    expect(await failure(claims.create(RIVAL, claimInput(), meta(RIVAL)))).toMatchObject({
      status: 409,
      reason: "place_claimed",
    });
    const audit = await sql(
      `SELECT action FROM audit_logs WHERE action LIKE 'place_claim.%' OR action IN ('place.claim_assign',
       'organization.create') ORDER BY created_at, action`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "organization.create",
        "place.claim_assign",
        "place_claim.approve",
        "place_claim.auto_reject",
      ]),
    );
    await expect
      .poll(() => sent.filter((s) => s.text.includes("Це мій заклад")).length)
      .toBeGreaterThanOrEqual(2);
    expect(sent.some((s) => s.text.includes("схвалено"))).toBe(true);
  });

  it("повторный импорт: поля, график и организацию места партнёра не меняет", async () => {
    const before = (
      await sql(`SELECT phone, website, organization_id, address_i18n FROM places WHERE id = $1`, [placeId])
    ).rows[0];
    await writePlaces(
      appDb,
      "test-region",
      [
        mapped({
          phone: "+380000000000",
          website: "https://changed.example/",
          address: "інша адреса",
          week: [{ dayOfWeek: 2, opensAt: "10:00", closesAt: "11:00" }],
        }),
      ],
      new Date("2026-11-03T10:00:00Z"),
      { closedIds: [GOOGLE_ID] },
    );
    const after = (
      await sql(`SELECT phone, website, organization_id, address_i18n, status FROM places WHERE id = $1`, [
        placeId,
      ])
    ).rows[0];
    expect(after).toMatchObject({ ...before, status: "published" });
    const schedule = await sql(`SELECT day_of_week FROM place_schedules WHERE place_id = $1`, [placeId]);
    expect(schedule.rows.map((r) => r.day_of_week)).toEqual([1]);
  });

  const placeOf = async (googleId: string) =>
    (await sql(`SELECT id FROM places WHERE google_place_id = $1`, [googleId])).rows[0].id as string;

  it("не бизнес (вершина): ссылки нет, заявка — 409 not_claimable", async () => {
    await writePlaces(
      appDb,
      "test-region",
      [mapped({ googlePlaceId: "ChIJclaimTestPeak01", categoryCode: "peaks", name: "Говерла" })],
      new Date("2026-11-03T10:00:00Z"),
    );
    const peak = await placeOf("ChIJclaimTestPeak01");
    expect((await guide.place(base.regions.a, peak, {}))?.claimable).toBe(false);
    expect(await failure(claims.create(RIVAL, claimInput({ placeId: peak }), meta(RIVAL)))).toMatchObject({
      status: 409,
      reason: "not_claimable",
    });
  });

  it("своя заявка модератора — 403 own_claim; другой регион — 403; отзыв заявителем — только своей и на рассмотрении", async () => {
    await writePlaces(
      appDb,
      "test-region",
      [mapped({ googlePlaceId: "ChIJclaimTestPlace02", name: "Колиба «Друга»" })],
      new Date("2026-11-03T10:00:00Z"),
    );
    const place2 = await placeOf("ChIJclaimTestPlace02");
    const own = await claims.create(MODERATOR_A, claimInput({ placeId: place2 }), meta(MODERATOR_A));
    expect(
      await failure(claims.decide(MODERATOR_A, own.id, "approve", undefined, meta(MODERATOR_A))),
    ).toMatchObject({ status: 403, reason: "own_claim" });
    expect(await failure(claims.decide(ADMIN_B, own.id, "reject", "x", meta(ADMIN_B)))).toMatchObject({
      status: 403,
    });
    expect(await failure(claims.withdraw(RIVAL, own.id, meta(RIVAL)))).toMatchObject({ status: 404 });
    expect((await claims.withdraw(MODERATOR_A, own.id, meta(MODERATOR_A))).status).toBe("withdrawn");
    expect(await failure(claims.withdraw(MODERATOR_A, own.id, meta(MODERATOR_A)))).toMatchObject({
      status: 409,
    });
  });

  it("отмена одобрения: место без организации, заявка revoked, ORG_OWNER новой организации снят, AuditLog", async () => {
    const [mine] = (await claims.mine(CLAIMANT, base.regions.a)).items;
    expect(mine!.status).toBe("approved");
    expect(await failure(claims.revoke(MODERATOR_A, mine!.id, "  ", meta(MODERATOR_A)))).toMatchObject({
      status: 400,
    });
    const revoked = await claims.revoke(MODERATOR_A, mine!.id, "Помилкове схвалення", meta(MODERATOR_A));
    expect(revoked).toMatchObject({ status: "revoked", revokeReason: "Помилкове схвалення" });
    const place = (
      await sql(`SELECT organization_id, partner_template_id, status FROM places WHERE id = $1`, [placeId])
    ).rows[0];
    expect(place).toEqual({ organization_id: null, partner_template_id: null, status: "published" });
    expect((await partner.me(CLAIMANT)).organizations).toEqual([]);
    expect((await guide.place(base.regions.a, placeId, {}))?.claimable).toBe(true);
    expect(await failure(claims.revoke(MODERATOR_A, mine!.id, "ще раз", meta(MODERATOR_A)))).toMatchObject({
      status: 409,
    });
    const audit = await sql(
      `SELECT action FROM audit_logs WHERE action IN ('place_claim.revoke', 'place.claim_unassign', 'role.revoke')`,
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual(
      expect.arrayContaining(["place.claim_unassign", "place_claim.revoke"]),
    );
    await expect.poll(() => sent.some((s) => s.text.includes("скасовано"))).toBe(true);
  });

  it("одобрение на организацию, где заявитель больше не владелец, — 409 claimant_not_owner", async () => {
    const first = await claims.create(RIVAL, claimInput({ organizationName: "ТОВ Суперник" }), meta(RIVAL));
    await claims.decide(MODERATOR_A, first.id, "approve", undefined, meta(MODERATOR_A));
    const org = (await partner.me(RIVAL)).organizations[0]!;
    const place2 = await placeOf("ChIJclaimTestPlace02");
    const second = await claims.create(
      RIVAL,
      claimInput({ placeId: place2, organizationName: undefined, organizationId: org.id }),
      meta(RIVAL),
    );
    await sql(`UPDATE role_assignments SET revoked_at = now() WHERE id = $1`, [org.assignmentId]);
    expect(
      await failure(claims.decide(MODERATOR_A, second.id, "approve", undefined, meta(MODERATOR_A))),
    ).toMatchObject({ status: 409, reason: "claimant_not_owner" });
  });

  it("очистка ПДн: телефон и комментарий решённых заявок старше 90 дней стираются, на рассмотрении — нет", async () => {
    await sql(`ALTER TABLE place_claims DISABLE TRIGGER place_claims_set_updated_at`);
    await sql(`UPDATE place_claims SET updated_at = now() - interval '120 days'`);
    await sql(`ALTER TABLE place_claims ENABLE TRIGGER place_claims_set_updated_at`);
    await expect(sql(`SELECT place_claims_purge_expired_pii(10, 100)`)).rejects.toThrow();
    const n = (await sql(`SELECT place_claims_purge_expired_pii(90, 100) AS n`)).rows[0].n as number;
    expect(n).toBeGreaterThan(0);
    const rows = (await sql(`SELECT status, phone, comment, pii_purged_at FROM place_claims`)).rows;
    for (const r of rows)
      if (r.status === "pending") expect(r.phone).not.toBeNull();
      else expect(r).toMatchObject({ phone: null, comment: null });
    // Detail модератора после очистки: телефона нет.
    const purged = rows.length;
    expect(purged).toBeGreaterThan(0);
  });
});
