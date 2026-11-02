// Блок 6 (ADR-0021) на реальной PostgreSQL 17 под ролью приложения: миграция 0017 (RLS, права, шаблоны), онбординг
// по шаблону (Organization + Place draft + ORG_OWNER), невидимость места туристу до одобрения (поиск и карточка →
// нет), обязательные поля шаблона и отправка на модерацию, очередь и решения модератора своего региона (C-15) с
// AuditLog и причиной, повторная подача после возврата, приглашения (одноразовые, TTL), кассир — 403 на редактор,
// сотрудников и акции, менеджер — без полей личности места и без сотрудников (не удаляет владельца), смена роли —
// AuditLog, акции, изоляция регионов. Без Docker — пропуск (CI).
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, regionContext, withTenant, type Db } from "../../src/db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../../src/modules/audit/index.js";
import { CatalogRepository, CatalogService } from "../../src/modules/catalog/index.js";
import { EmergencyContactsRepository } from "../../src/modules/emergency-contacts/index.js";
import { GuideRepository, GuideService } from "../../src/modules/guide/index.js";
import { NotificationsService } from "../../src/modules/host/index.js";
import type { MediaService } from "../../src/modules/media/index.js";
import {
  ModerationService,
  PartnerRepository,
  PARTNER_TERMS_VERSION,
  PartnerService,
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
import { seedBase, seedUserId, type SeedBaseResult } from "../../src/seed/seed.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const APP_LOGIN = "tg_api_partner_test";
const APP_PASSWORD = "tg_api_partner_test";

const OWNER = seedUuid("partner-test:user:owner");
const MANAGER = seedUuid("partner-test:user:manager");
const CASHIER = seedUuid("partner-test:user:cashier");
const LATE = seedUuid("partner-test:user:late");
const OTHER = seedUuid("partner-test:user:other");
const MODERATOR_A = seedUserId("moderator-a");
const ADMIN_B = seedUserId("region-admin-b");

const meta = (userId: string): PartnerAuditMeta => ({
  actor: { type: "user", userId },
  roleAssignmentId: null,
  requestId: "it-partner",
});

/** Код ошибки и причина (ApiError: getStatus, code, details). */
async function failure(p: Promise<unknown>): Promise<{ status: number; code: string; reason?: unknown }> {
  const e = (await p.then(
    () => undefined,
    (err: unknown) => err,
  )) as { getStatus?: () => number; code?: string; details?: { reason?: unknown } } | undefined;
  if (!e?.getStatus) throw new Error(`Ожидалась ApiError, получено: ${String(e)}`);
  return { status: e.getStatus(), code: e.code ?? "", reason: e.details?.reason };
}

describe.skipIf(!dockerAvailable)(`Кабинет партнёра и модерация (блок 6, миграция 0017)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let base: SeedBaseResult;
  let partner: PartnerService;
  let moderation: ModerationService;
  let guide: GuideService;
  let catalogService: CatalogService;
  /** Опубликованное место демо-каталога, рядом с которым ставим точку заявки (проверка дублей). */
  let neighbour: { id: string; lon: number; lat: number };
  const sent: { chatId: string; text: string }[] = [];
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
      [OWNER, 990000000601],
      [MANAGER, 990000000602],
      [CASHIER, 990000000603],
      [LATE, 990000000604],
      [OTHER, 990000000605],
    ] as const) {
      await sql(`INSERT INTO users (id, status, language, display_name) VALUES ($1, 'active', 'uk', $2)`, [
        id,
        `Партнер ${tg}`,
      ]);
      await sql(
        `INSERT INTO telegram_accounts (user_id, telegram_user_id, username, first_name, last_auth_date)
         VALUES ($1, $2, $3, 'Тест', now())`,
        [id, tg, `partner_test_${tg}`],
      );
    }
    // Модератор региона A и владелец — с согласием на сервисные сообщения (уведомления ботом).
    await sql(
      `INSERT INTO telegram_accounts (user_id, telegram_user_id, last_auth_date) VALUES ($1, $2, now())`,
      [MODERATOR_A, 990000000699],
    );
    for (const id of [MODERATOR_A, OWNER])
      await sql(
        `INSERT INTO messaging_consents (user_id, purpose, granted, source, granted_at)
         VALUES ($1, 'service', true, 'settings', now())`,
        [id],
      );
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
    partner = new PartnerService(
      appDb,
      repo,
      catalogRepo,
      catalog,
      new RegionsRepository(appDb),
      rbac,
      hierarchy,
      new RoleAssignmentService(audit, hierarchy),
      audit,
      notifications,
      media,
      { botUsername: "tourist_guide_bot" },
    );
    moderation = new ModerationService(appDb, repo, catalogRepo, catalog, rbac, audit, notifications, media);
    catalogService = catalog;
    guide = new GuideService(
      appDb,
      new GuideRepository(appDb),
      new RegionsRepository(appDb),
      new EmergencyContactsRepository(appDb),
      media,
    );
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  const invisibleToTourist = async () => {
    expect(await guide.place(base.regions.a, placeId, {})).toBeUndefined();
    const found = await guide.search(base.regions.a, { text: "Смерекова хата", limit: 50, offset: 0 });
    expect(found.items.map((i) => i.id)).not.toContain(placeId);
  };

  it("миграция 0017: RLS на новых tenant-таблицах, шаблоны — только чтение у app, три шаблона", async () => {
    expect(tdb!.applied).toContain("0017_partner_cabinet.sql");
    const tables = ["organizations", "moderation_cases", "staff_invites", "offers"];
    const { rows } = await sql(
      `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity`,
      [tables],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
    const privs = await sql(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'app' AND table_name = 'partner_templates' ORDER BY 1`,
    );
    expect(privs.rows.map((r) => r.privilege_type)).toEqual(["SELECT"]);
    const list = await partner.templates(base.regions.a);
    expect(list.items.map((t) => t.code)).toEqual(["hotel", "food", "chan"]);
    expect(list.items[0]!.categories.map((c) => c.code).sort()).toEqual(["hotels", "sadyby"]);
  });

  it("онбординг: организация, место draft, ORG_OWNER; туристу место не видно; категория не из шаблона — 422", async () => {
    const wrong = await failure(
      partner.onboard(
        OWNER,
        {
          regionId: base.regions.a,
          templateCode: "hotel",
          categoryId: seedUuid("catalog:a:category:cafes"),
          name: { uk: "Не та категорія" },
        },
        meta(OWNER),
      ),
    );
    expect(wrong).toMatchObject({ status: 422, reason: "category_not_in_template" });

    const result = await partner.onboard(
      OWNER,
      {
        regionId: base.regions.a,
        templateCode: "hotel",
        categoryId: seedUuid("catalog:a:category:hotels"),
        name: { uk: "Смерекова хата" },
        organizationName: "ФОП Смерека",
      },
      meta(OWNER),
    );
    orgId = result.organization.id;
    placeId = result.place.id;
    expect(result.organization).toMatchObject({
      name: "ФОП Смерека",
      role: "ORG_OWNER",
      regionId: base.regions.a,
    });
    expect(result.organization.abilities).toMatchObject({ manageStaff: true, submit: true, editPlace: true });
    expect(result.place).toMatchObject({ status: "draft", editable: true, template: { code: "hotel" } });
    expect(result.place.missingFields).toEqual(["description", "address", "location", "phone", "photo"]);

    const audit = await sql(
      `SELECT action, actor_type FROM audit_logs WHERE entity_id = ANY($1) OR (action = 'role.assign' AND new_values->>'scopeId' = $2) ORDER BY created_at`,
      [[orgId, placeId], orgId],
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual([
      "organization.create",
      "place.create",
      "role.assign",
    ]);
    await invisibleToTourist();
  });

  it("отправка на модерацию: без согласия и с пустыми полями — 422; затем pending_moderation, уведомление модератору", async () => {
    expect(await failure(partner.submit(OWNER, placeId, { acceptTerms: false }, meta(OWNER)))).toMatchObject({
      status: 422,
      reason: "terms_required",
    });
    expect(await failure(partner.submit(OWNER, placeId, { acceptTerms: true }, meta(OWNER)))).toMatchObject({
      status: 422,
      reason: "required_fields_missing",
    });
    const near = await sql(
      `SELECT id, ST_X(location) AS lon, ST_Y(location) AS lat FROM places
       WHERE region_id = $1 AND status = 'published' AND location IS NOT NULL ORDER BY id LIMIT 1`,
      [base.regions.a],
    );
    neighbour = { id: near.rows[0].id, lon: Number(near.rows[0].lon), lat: Number(near.rows[0].lat) };
    await partner.updatePlace(
      OWNER,
      placeId,
      {
        description: { uk: "Садиба серед смерек" },
        address: { uk: "вул. Лісова, 1" },
        location: { lon: neighbour.lon + 0.0005, lat: neighbour.lat },
        phone: "+380501112233",
      },
      meta(OWNER),
    );
    const asset = await sql(
      `INSERT INTO media_assets (region_id, owner_type, owner_id, kind, status, mime, size_bytes, original_key, alt_i18n)
       VALUES ($1, 'place', $2, 'image', 'ready', 'image/jpeg', 100, 'private/p/original', '{"uk": "Фасад"}')
       RETURNING id`,
      [base.regions.a, placeId],
    );
    await sql(
      `INSERT INTO place_media (region_id, place_id, media_asset_id, is_cover) VALUES ($1, $2, $3, true)`,
      [base.regions.a, placeId, asset.rows[0].id],
    );
    const submitted = await partner.submit(
      OWNER,
      placeId,
      { acceptTerms: true, note: "Дзвоніть" },
      meta(OWNER),
    );
    expect(submitted).toMatchObject({ status: "pending_moderation", editable: false, missingFields: [] });
    expect(submitted.moderation).toMatchObject({ status: "open", decision: null });
    expect(await failure(partner.submit(OWNER, placeId, { acceptTerms: true }, meta(OWNER)))).toMatchObject({
      status: 409,
    });
    // На модерации — только чтение.
    expect(
      await failure(partner.updatePlace(OWNER, placeId, { phone: "+380501112234" }, meta(OWNER))),
    ).toMatchObject({ status: 409 });
    await invisibleToTourist();
    await expect.poll(() => sent.some((s) => s.text.includes("Нова заявка на модерацію"))).toBe(true);
    // Согласие с условиями — версия и время в AuditLog и в снимке заявки; подписанных ссылок в снимке нет.
    const audit = await sql(
      `SELECT new_values FROM audit_logs WHERE action = 'place.submit' AND entity_id = $1`,
      [placeId],
    );
    expect(audit.rows[0].new_values).toMatchObject({ termsVersion: PARTNER_TERMS_VERSION });
    const snap = await sql(`SELECT place_snapshot FROM moderation_cases WHERE place_id = $1`, [placeId]);
    expect(snap.rows[0].place_snapshot.terms).toMatchObject({ version: PARTNER_TERMS_VERSION });
    expect(snap.rows[0].place_snapshot).not.toHaveProperty("mediaPreview");
  });

  it("приглашения: одноразовые, с TTL; повтор и истёкшее — 409; принятие — AuditLog", async () => {
    const manager = await partner.createInvite(OWNER, orgId, "ORG_MANAGER", meta(OWNER));
    expect(manager.startParam).toBe(`inv_${manager.token}`);
    expect(manager.link).toBe(`https://t.me/tourist_guide_bot?startapp=inv_${manager.token}`);
    const preview = await partner.previewInvite(MANAGER, manager.startParam);
    expect(preview).toMatchObject({ organizationName: "ФОП Смерека", role: "ORG_MANAGER", state: "active" });
    await partner.acceptInvite(MANAGER, manager.token, meta(MANAGER));
    expect(await failure(partner.acceptInvite(OTHER, manager.token, meta(OTHER)))).toMatchObject({
      status: 409,
      reason: "used",
    });

    const cashier = await partner.createInvite(OWNER, orgId, "ORG_STAFF", meta(OWNER));
    await partner.acceptInvite(CASHIER, cashier.token, meta(CASHIER));

    const late = await partner.createInvite(OWNER, orgId, "ORG_STAFF", meta(OWNER));
    await sql(
      `UPDATE staff_invites SET created_at = now() - interval '4 days', expires_at = now() - interval '1 day'
       WHERE id = $1`,
      [late.invite.id],
    );
    expect(await failure(partner.acceptInvite(LATE, late.token, meta(LATE)))).toMatchObject({
      status: 409,
      reason: "expired",
    });
    expect(await failure(partner.acceptInvite(LATE, "x".repeat(43), meta(LATE)))).toMatchObject({
      status: 404,
    });

    const staff = await partner.staff(OWNER, orgId);
    expect(staff.members.map((m) => m.role).sort()).toEqual(["ORG_MANAGER", "ORG_OWNER", "ORG_STAFF"]);
    expect(staff.invites.map((i) => i.state).sort()).toEqual(["accepted", "accepted", "expired"]);
    const accepted = await sql(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'staff_invite.accept'`,
    );
    expect(accepted.rows[0].n).toBe(2);
  });

  it("кассир — 403 на редактор, сотрудников и акции; менеджер — без полей личности и сотрудников", async () => {
    expect(await failure(partner.getPlace(CASHIER, placeId))).toMatchObject({ status: 403 });
    expect(
      await failure(partner.updatePlace(CASHIER, placeId, { phone: "+380501112299" }, meta(CASHIER))),
    ).toMatchObject({ status: 403 });
    expect(await failure(partner.staff(CASHIER, orgId))).toMatchObject({ status: 403 });
    expect(
      await failure(partner.createOffer(CASHIER, placeId, { title: { uk: "Знижка" } }, meta(CASHIER))),
    ).toMatchObject({ status: 403 });

    expect(
      await failure(partner.updatePlace(MANAGER, placeId, { name: { uk: "Інша назва" } }, meta(MANAGER))),
    ).toMatchObject({ status: 403, reason: "identity_fields_forbidden" });
    const owner = (await partner.staff(OWNER, orgId)).members.find((m) => m.role === "ORG_OWNER")!;
    expect(
      await failure(partner.deactivate(MANAGER, orgId, owner.assignmentId, meta(MANAGER))),
    ).toMatchObject({
      status: 403,
    });
    // Владельца не трогает и сам владелец (owner_protected).
    expect(await failure(partner.deactivate(OWNER, orgId, owner.assignmentId, meta(OWNER)))).toMatchObject({
      status: 403,
      reason: "owner_protected",
    });

    const me = await partner.me(CASHIER);
    expect(me.organizations[0]).toMatchObject({ id: orgId, role: "ORG_STAFF" });
    expect(me.organizations[0]!.abilities).toMatchObject({
      editPlace: false,
      manageStaff: false,
      manageOffers: false,
    });
  });

  it("модерация: чужой регион — 403; возврат с комментарием → правка → повторная подача → одобрение; AuditLog", async () => {
    expect(
      await failure(moderation.list(ADMIN_B, { status: "open", regionId: base.regions.a })),
    ).toMatchObject({
      status: 403,
    });
    const queue = await moderation.list(MODERATOR_A, { status: "open" });
    const kase = queue.items.find((c) => c.placeId === placeId)!;
    expect(kase).toMatchObject({ organizationName: "ФОП Смерека", templateCode: "hotel", status: "open" });
    expect(await failure(moderation.get(ADMIN_B, kase.id))).toMatchObject({ status: 403 });
    expect(
      await failure(
        moderation.decide(
          ADMIN_B,
          kase.id,
          { decision: "approve", verificationMethod: "phone_call" },
          meta(ADMIN_B),
        ),
      ),
    ).toMatchObject({ status: 403 });
    const detail = await moderation.get(MODERATOR_A, kase.id);
    expect(detail.partnerNote).toBe("Дзвоніть");
    expect(detail.owners.map((o) => o.userId)).toEqual([OWNER]);
    expect(detail.publishProblems).toEqual([]);
    expect(detail).toMatchObject({ templateName: { uk: "Готель / садиба" }, ownOrganization: false });
    const dup = detail.possibleDuplicates.find((d) => d.id === neighbour.id);
    expect(dup).toBeDefined();
    expect(dup!.distanceMeters).toBeLessThan(150);
    expect(detail.possibleDuplicates.length).toBeLessThanOrEqual(5);
    expect(detail.possibleDuplicates.map((d) => d.id)).not.toContain(placeId);
    expect(queue.items.every((c) => c.ownOrganization === false)).toBe(true);

    const returned = await moderation.decide(
      MODERATOR_A,
      kase.id,
      { decision: "changes_requested", comment: "Додайте фото номерів" },
      meta(MODERATOR_A),
    );
    expect(returned).toMatchObject({
      status: "decided",
      decision: "changes_requested",
      placeStatus: "changes_requested",
    });
    expect(
      await failure(
        moderation.decide(
          MODERATOR_A,
          kase.id,
          { decision: "approve", verificationMethod: "phone_call" },
          meta(MODERATOR_A),
        ),
      ),
    ).toMatchObject({ status: 409, reason: "already_decided" });
    await invisibleToTourist();

    const back = await partner.getPlace(OWNER, placeId);
    expect(back.moderation).toMatchObject({ decision: "changes_requested", comment: "Додайте фото номерів" });
    await partner.updatePlace(MANAGER, placeId, { description: { uk: "Садиба, 5 номерів" } }, meta(MANAGER));
    await partner.submit(OWNER, placeId, { acceptTerms: true }, meta(OWNER));
    const second = (await moderation.list(MODERATOR_A, { status: "open" })).items.find(
      (c) => c.placeId === placeId,
    )!;
    expect(second.id).not.toBe(kase.id);
    expect((await moderation.get(MODERATOR_A, second.id)).history.map((h) => h.id)).toEqual([kase.id]);

    const approved = await moderation.decide(
      MODERATOR_A,
      second.id,
      { decision: "approve", verificationMethod: "phone_call" },
      meta(MODERATOR_A),
    );
    expect(approved.decidedByName).not.toBeUndefined();
    expect(approved).toMatchObject({
      decidedBy: MODERATOR_A,
      decision: "approve",
      verificationMethod: "phone_call",
      placeStatus: "published",
    });
    const card = await guide.place(base.regions.a, placeId, {});
    expect(card?.id).toBe(placeId);

    const decisions = await sql(
      `SELECT action, reason, role_assignment_id FROM audit_logs WHERE entity_type = 'moderation_case'
       ORDER BY created_at`,
    );
    expect(decisions.rows.map((r) => r.action)).toEqual(["moderation.return", "moderation.approve"]);
    expect(decisions.rows[0].reason).toBe("Додайте фото номерів");
    expect(decisions.rows[1].reason).toBe("verification:phone_call");
    expect(decisions.rows.every((r) => r.role_assignment_id)).toBe(true);
    await expect.poll(() => sent.some((s) => s.text.includes("схвалено"))).toBe(true);

    // Опубликованное место: поля личности — 409 (только через админа региона), описание и телефон — сразу.
    expect(
      await failure(partner.updatePlace(OWNER, placeId, { name: { uk: "Нова назва" } }, meta(OWNER))),
    ).toMatchObject({ status: 409, reason: "identity_change_requires_moderation" });
    expect(
      await failure(
        partner.updatePlace(OWNER, placeId, { localityId: null, phone: "+380501112200" }, meta(OWNER)),
      ),
    ).toMatchObject({ status: 409 });
    const live = await partner.updatePlace(OWNER, placeId, { phone: "+380501112200" }, meta(OWNER));
    expect(live).toMatchObject({ status: "published", phone: "+380501112200" });

    const me = await partner.me(OWNER);
    expect(me.organizations[0]!.places[0]).toMatchObject({
      status: "published",
      moderation: { decision: "approve" },
      openServiceRequests: 0,
    });
  });

  it("онбординг с длинным названием — организация обрезается до 200 символов; админ не публикует черновик партнёра", async () => {
    const long = "Ї".repeat(250);
    const result = await partner.onboard(
      OTHER,
      {
        regionId: base.regions.a,
        templateCode: "food",
        categoryId: seedUuid("catalog:a:category:cafes"),
        name: { uk: long },
      },
      meta(OTHER),
    );
    expect(result.organization.name).toBe("Ї".repeat(200));
    expect(result.place.name.uk).toBe(long);
    const denied = await withTenant(appDb, regionContext(base.regions.a), () =>
      catalogService.transition(
        {
          actor: { type: "user", userId: seedUserId("region-admin-a") },
          roleAssignmentId: null,
          requestId: "it",
        },
        result.place.id,
        "publish",
        null,
      ),
    ).catch((e: unknown) => e as { reason?: string });
    expect(denied).toMatchObject({ reason: "moderation_required" });
    const status = await sql(`SELECT status FROM places WHERE id = $1`, [result.place.id]);
    expect(status.rows[0].status).toBe("draft");
  });

  it("смена роли и деактивация сотрудника — AuditLog; акции менеджера; изоляция регионов", async () => {
    const cashier = (await partner.staff(OWNER, orgId)).members.find((m) => m.userId === CASHIER)!;
    const promoted = await partner.changeRole(OWNER, orgId, cashier.assignmentId, "ORG_MANAGER", meta(OWNER));
    expect(promoted).toMatchObject({ userId: CASHIER, role: "ORG_MANAGER" });
    const roleAudit = await sql(
      `SELECT action, actor_user_id, reason FROM audit_logs
       WHERE entity_type = 'role_assignment' AND reason LIKE 'staff_role_change:%' ORDER BY created_at`,
    );
    expect(roleAudit.rows.map((r) => r.action)).toEqual(["role.revoke", "role.assign"]);
    expect(roleAudit.rows.every((r) => r.actor_user_id === OWNER)).toBe(true);
    await partner.deactivate(OWNER, orgId, promoted.assignmentId, meta(OWNER));
    expect((await partner.staff(OWNER, orgId)).members.some((m) => m.userId === CASHIER)).toBe(false);
    expect((await partner.me(CASHIER)).organizations).toEqual([]);

    const offer = await partner.createOffer(
      MANAGER,
      placeId,
      { title: { uk: "-10% у будні" }, startsAt: "2026-11-03T00:00:00Z", endsAt: "2026-12-01T00:00:00Z" },
      meta(MANAGER),
    );
    expect(
      await failure(
        partner.updateOffer(MANAGER, placeId, offer.id, { endsAt: "2026-11-01T00:00:00Z" }, meta(MANAGER)),
      ),
    ).toMatchObject({ status: 422 });
    const archived = await partner.archiveOffer(MANAGER, placeId, offer.id, meta(MANAGER));
    expect(archived.status).toBe("archived");
    expect(
      await failure(partner.updateOffer(MANAGER, placeId, offer.id, { title: { uk: "x" } }, meta(MANAGER))),
    ).toMatchObject({ status: 409 });
    expect((await partner.listOffers(OWNER, placeId, "active")).items).toEqual([]);

    // Изоляция: место региона A не видно в контексте региона B; партнёр без роли — 403.
    expect(await guide.place(base.regions.b, placeId, {})).toBeUndefined();
    expect(await failure(partner.getPlace(OTHER, placeId))).toMatchObject({
      status: 403,
      reason: "not_partner",
    });
    const inB = await sql(`SELECT count(*)::int AS n FROM organizations WHERE region_id = $1`, [
      base.regions.b,
    ]);
    expect(inB.rows[0].n).toBe(0);
  });
});
