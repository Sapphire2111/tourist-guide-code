// Блок 10 (подтверждённые отзывы) на реальной PostgreSQL под ролью приложения: миграция 0028 (RLS, права, триггер
// bookings → ReviewEligibility), отзыв без права — отказ, повтор — новая версия, автофильтр → очередь модерации,
// партнёр отвечает и жалуется, но не скрывает; решение модератора и апелляции — в AuditLog, апелляцию решает другой
// модератор; бронь вышла из completed — право revoked; окно прошло — expired; рейтинг с порогом.
// Без Docker — пропуск (CI).
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDatabase, type Db } from "../../src/db/index.js";
import type { AnalyticsService } from "../../src/modules/analytics/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../../src/modules/audit/index.js";
import {
  dbScopeParentLoaders,
  RbacService,
  RoleAssignmentsRepository,
  ScopeHierarchy,
} from "../../src/modules/rbac/index.js";
import { RegionsRepository } from "../../src/modules/regions/index.js";
import {
  RATING_PARAMS,
  REVIEW_PARAMS,
  ReviewsRepository,
  ReviewsService,
  type ReviewAuditMeta,
} from "../../src/modules/reviews/index.js";
import { seedUuid } from "../../src/seed/ids.js";
import { seedCatalog } from "../../src/seed/seed-catalog.js";
import { seedBase, type SeedBaseResult } from "../../src/seed/seed.js";
import { startDatabase, stopDatabase, type TestDatabase } from "./support/containers.js";

const dockerAvailable = inject("dockerAvailable");
const title = dockerAvailable ? "" : " [ПРОПУСК: Docker недоступен]";

const APP_LOGIN = "tg_api_reviews_test";
const APP_PASSWORD = "tg_api_reviews_test";

const OWNER = seedUuid("reviews-test:user:owner");
const STAFF = seedUuid("reviews-test:user:staff");
const TOURISTS = Array.from({ length: 8 }, (_, i) => seedUuid(`reviews-test:user:tourist-${i}`));
const ORG = seedUuid("reviews-test:org");
const DAY = 24 * 3_600_000;

const meta = (userId: string): ReviewAuditMeta => ({
  actor: { type: "user", userId },
  roleAssignmentId: null,
  requestId: "it-reviews",
});

/** Код ошибки и причина (ApiError: getStatus, code, messageKey, details). */
async function failure(
  p: Promise<unknown>,
): Promise<{ status: number; code: string; messageKey?: string; reason?: unknown }> {
  const e = (await p.then(
    () => undefined,
    (err: unknown) => err,
  )) as
    | { getStatus?: () => number; code?: string; messageKey?: string; details?: { reason?: unknown } }
    | undefined;
  if (!e?.getStatus) throw new Error(`Ожидалась ApiError, получено: ${String(e)}`);
  return { status: e.getStatus(), code: e.code ?? "", messageKey: e.messageKey, reason: e.details?.reason };
}

describe.skipIf(!dockerAvailable)(`Отзывы (блок 10, миграция 0028)${title}`, () => {
  let tdb: TestDatabase | undefined;
  let ownerDb: Db;
  let appDb: Db;
  let base: SeedBaseResult;
  let reviews: ReviewsService;
  const events: { event: string; props: Record<string, unknown> }[] = [];
  const sql = (text: string, params: unknown[] = []) => tdb!.client.query(text, params);

  let regionId = "";
  let placeId = "";
  let resourceId = "";
  let moderator = "";
  let regionAdmin = "";
  let slot = 0;

  /** Бронь туриста, завершённая (completed) daysAgo дней назад: триггер 0028 выдаёт право на отзыв. */
  const completedBooking = async (userId: string, daysAgo = 1): Promise<string> => {
    slot += 1;
    const starts = new Date(Date.now() - daysAgo * DAY - slot * 3_600_000);
    const ends = new Date(starts.getTime() + 3_000_000);
    const { rows } = await sql(
      `INSERT INTO bookings (region_id, organization_id, place_id, resource_id, user_id, source, starts_at, ends_at,
         occupied_from, occupied_until, people_count, customer_name, status)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $6, $7, 2, 'Гість', 'confirmed') RETURNING id`,
      [regionId, ORG, placeId, resourceId, userId, starts, ends],
    );
    const id = rows[0].id as string;
    await sql(
      `UPDATE bookings SET status = 'completed', completed_at = now(), closed_at = now() WHERE id = $1`,
      [id],
    );
    return id;
  };
  const eligibilityOf = async (bookingId: string) =>
    (
      await sql(`SELECT id, status, revoke_reason FROM review_eligibilities WHERE booking_id = $1`, [
        bookingId,
      ])
    ).rows[0] as { id: string; status: string; revoke_reason: string | null } | undefined;
  const submit = (userId: string, eligibilityId: string, rating: number, text: string) =>
    reviews.submit(userId, { regionId, eligibilityId, rating, text }, meta(userId));
  const auditOf = async (entityId: string) =>
    (
      await sql(
        `SELECT action, actor_user_id, new_values FROM audit_logs WHERE entity_id = $1 ORDER BY created_at, id`,
        [entityId],
      )
    ).rows as { action: string; actor_user_id: string; new_values: Record<string, unknown> }[];

  beforeAll(async () => {
    tdb = await startDatabase();
    await sql(`CREATE ROLE ${APP_LOGIN} LOGIN PASSWORD '${APP_PASSWORD}' IN ROLE app`);
    ownerDb = createDatabase({ connectionString: tdb.container.getConnectionUri(), maxConnections: 2 });
    base = await seedBase(ownerDb);
    await seedCatalog(ownerDb, base.regions);
    regionId = base.regions.a;
    moderator = base.users["moderator-a"];
    regionAdmin = base.users["region-admin-a"];
    for (const [i, id] of [OWNER, STAFF, ...TOURISTS].entries())
      await sql(`INSERT INTO users (id, status, language, display_name) VALUES ($1, 'active', 'uk', $2)`, [
        id,
        `Олена Тестова-${i}`,
      ]);
    await sql(
      `INSERT INTO organizations (id, region_id, name, created_by) VALUES ($1, $2, 'Чани Ворохти', $3)`,
      [ORG, regionId, OWNER],
    );
    const place = await sql(
      `SELECT id FROM places WHERE region_id = $1 AND status = 'published' ORDER BY id LIMIT 1`,
      [regionId],
    );
    placeId = place.rows[0].id as string;
    await sql(`UPDATE places SET organization_id = $1 WHERE id = $2`, [ORG, placeId]);
    for (const [user, role] of [
      [OWNER, "ORG_OWNER"],
      [STAFF, "ORG_STAFF"],
    ] as const)
      await sql(
        `INSERT INTO role_assignments (user_id, role, scope_type, scope_id, region_id)
         VALUES ($1, $2, 'ORGANIZATION', $3, $4)`,
        [user, role, ORG, regionId],
      );
    const resource = await sql(
      `INSERT INTO resources (region_id, organization_id, place_id, name_i18n) VALUES ($1, $2, $3, '{"uk":"Чан"}')
       RETURNING id`,
      [regionId, ORG, placeId],
    );
    resourceId = resource.rows[0].id as string;
    const url = new URL(tdb.container.getConnectionUri());
    url.username = APP_LOGIN;
    url.password = APP_PASSWORD;
    appDb = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
    const rbac = new RbacService(
      new RoleAssignmentsRepository(appDb),
      new ScopeHierarchy(dbScopeParentLoaders(appDb)),
    );
    const analytics = {
      emit: (e: { event: string; props: Record<string, unknown> }) => {
        events.push({ event: e.event, props: e.props });
        return Promise.resolve();
      },
    } as unknown as AnalyticsService;
    reviews = new ReviewsService(
      appDb,
      new ReviewsRepository(appDb),
      new RegionsRepository(appDb),
      rbac,
      new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS),
      { isEnabled: () => Promise.resolve(true) },
      analytics,
    );
  }, 180_000);

  afterAll(async () => {
    await appDb?.destroy();
    await ownerDb?.destroy();
    await stopDatabase(tdb);
  });

  it("миграция 0028: RLS на новых tenant-таблицах, версии — только дописываются", async () => {
    expect(tdb!.applied).toContain("0028_reviews.sql");
    const tables = [
      "review_eligibilities",
      "reviews",
      "review_revisions",
      "review_responses",
      "review_complaints",
      "review_appeals",
      "place_review_ratings",
    ];
    const { rows } = await sql(
      `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity`,
      [tables],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
    const privs = await sql(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'app' AND table_name = 'review_revisions' ORDER BY 1`,
    );
    expect(privs.rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT"]);
  });

  it("право на отзыв — из завершённой брони (триггер), с событием review_eligible; без права — 403", async () => {
    const tourist = TOURISTS[0]!;
    const bookingId = await completedBooking(tourist);
    const e = await eligibilityOf(bookingId);
    expect(e).toMatchObject({ status: "active" });
    const ev = await sql(
      `SELECT count(*)::int AS n FROM analytics_events WHERE event_name = 'review_eligible'`,
    );
    expect(ev.rows[0].n).toBeGreaterThanOrEqual(1);
    const mine = await reviews.myEligibility(regionId, tourist);
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ id: e!.id, placeId, bookingId, status: "active", review: null });
    // Прямой POST без события: несуществующее право и чужое право.
    const none = await failure(submit(tourist, seedUuid("reviews-test:no-eligibility"), 5, "Супер"));
    expect(none).toMatchObject({ status: 403, messageKey: "errors.review.notEligible" });
    const foreign = await failure(submit(TOURISTS[1]!, e!.id, 5, "Супер"));
    expect(foreign).toMatchObject({ status: 403, reason: "not_eligible" });
    expect((await sql(`SELECT count(*)::int AS n FROM reviews`)).rows[0].n).toBe(0);
  });

  it("один отзыв на право: повтор — новая версия, история хранится, показывается последняя", async () => {
    const tourist = TOURISTS[0]!;
    const [item] = (await reviews.myEligibility(regionId, tourist)).items;
    const first = await submit(tourist, item!.id, 4, "Тепла вода, все добре");
    expect(first).toMatchObject({ status: "published", version: 1, rating: 4 });
    expect((await eligibilityOf(item!.bookingId))?.status).toBe("consumed");
    const second = await submit(tourist, item!.id, 5, "Оновлюю: персонал дуже привітний");
    expect(second).toMatchObject({ id: first.id, status: "published", version: 2, rating: 5 });
    const revisions = await sql(
      `SELECT version_no, text FROM review_revisions WHERE review_id = $1 ORDER BY 1`,
      [first.id],
    );
    expect(revisions.rows.map((r) => r.version_no)).toEqual([1, 2]);
    expect(
      (await sql(`SELECT count(*)::int AS n FROM reviews WHERE eligibility_id = $1`, [item!.id])).rows[0].n,
    ).toBe(1);
    const pub = await reviews.placeReviews(regionId, placeId);
    expect(pub.items).toHaveLength(1);
    expect(pub.items[0]).toMatchObject({
      text: "Оновлюю: персонал дуже привітний",
      version: 2,
      authorName: "Олена",
    });
    // Один отзыв — меньше порога: «Мало відгуків» вместо цифры.
    expect(pub.rating).toMatchObject({ reviewCount: 1, fewReviews: true, score: null });
    expect(events.filter((e) => e.event === "review_submitted")).toHaveLength(2);
  });

  it("автофильтр: телефон в тексте → pending_moderation, не публикуется, в очереди модератора", async () => {
    const tourist = TOURISTS[2]!;
    const bookingId = await completedBooking(tourist);
    const e = await eligibilityOf(bookingId);
    const r = await submit(tourist, e!.id, 1, "Дзвоніть мені +380 50 123 45 67");
    expect(r).toMatchObject({ status: "pending_moderation", autoFlags: ["phone"] });
    expect((await reviews.placeReviews(regionId, placeId)).items.map((i) => i.id)).not.toContain(r.id);
    const queue = await reviews.adminList(moderator, {});
    expect(queue.items.map((i) => i.id)).toContain(r.id);
    // Модератор отклоняет (hide на отфильтрованном → rejected) — решение в AuditLog.
    const decided = await reviews.decide(
      moderator,
      r.id,
      { decision: "hide", reason: "Персональні дані" },
      meta(moderator),
    );
    expect(decided.status).toBe("rejected");
    expect((await auditOf(r.id)).map((a) => a.action)).toEqual(["review.submit", "review.moderate"]);
  });

  it("партнёр: видит и отвечает, жалуется; скрыть не может — только модератор, решение в AuditLog", async () => {
    const [published] = (await reviews.placeReviews(regionId, placeId)).items;
    const list = await reviews.partnerList(OWNER);
    expect(list.items.map((i) => i.id)).toContain(published!.id);
    const answered = await reviews.putResponse(OWNER, published!.id, "Дякуємо, чекаємо знову!", meta(OWNER));
    expect(answered.response).toMatchObject({ text: "Дякуємо, чекаємо знову!", version: 1 });
    const edited = await reviews.putResponse(OWNER, published!.id, "Дякуємо! Чекаємо взимку.", meta(OWNER));
    expect(edited.response).toMatchObject({ version: 2 });
    expect(
      await failure(reviews.putResponse(OWNER, published!.id, "Наш сайт chany.com", meta(OWNER))),
    ).toMatchObject({
      status: 422,
      reason: "response_rejected",
    });
    // Кассир — без права ответа.
    expect(await failure(reviews.putResponse(STAFF, published!.id, "Дякуємо", meta(STAFF)))).toMatchObject({
      status: 403,
    });
    // Партнёр не скрывает: решения модератора у него нет.
    const hide = await failure(
      reviews.decide(OWNER, published!.id, { decision: "hide", reason: "Не подобається" }, meta(OWNER)),
    );
    expect(hide).toMatchObject({ status: 403 });
    const complaint = await reviews.complain(
      OWNER,
      published!.id,
      { regionId, reasonCode: "insult", text: "Образливо" },
      meta(OWNER),
    );
    expect(complaint).toMatchObject({ kind: "partner", status: "open" });
    // Жалоба ничего не скрывает (постмодерация).
    expect((await reviews.placeReviews(regionId, placeId)).items.map((i) => i.id)).toContain(published!.id);
    expect(
      await failure(reviews.complain(OWNER, published!.id, { regionId, reasonCode: "spam" }, meta(OWNER))),
    ).toMatchObject({ status: 409, reason: "complaint_exists" });
    // Модератор оставляет отзыв: жалоба отклонена, решение — AuditLog.
    const kept = await reviews.decide(moderator, published!.id, { decision: "publish" }, meta(moderator));
    expect(kept).toMatchObject({ status: "published", lastDecisionBy: moderator });
    expect(kept.complaints[0]).toMatchObject({ status: "dismissed" });
    const audit = await auditOf(published!.id);
    expect(audit.map((a) => a.action)).toContain("review.moderate");
    expect(audit.find((a) => a.action === "review.moderate")).toMatchObject({ actor_user_id: moderator });
  });

  it("апелляция партнёра: решает не тот, кто модерировал; grant → отзыв скрыт, AuditLog", async () => {
    const [published] = (await reviews.placeReviews(regionId, placeId)).items;
    const appeal = await reviews.appeal(
      OWNER,
      { regionId, reviewId: published!.id, text: "Там образи" },
      meta(OWNER),
    );
    expect(appeal).toMatchObject({ kind: "partner", status: "open" });
    expect(
      await failure(
        reviews.appeal(OWNER, { regionId, reviewId: published!.id, text: "Ще раз" }, meta(OWNER)),
      ),
    ).toMatchObject({ status: 409, reason: "appeal_exists" });
    // Пока апелляция открыта — обычное решение недоступно.
    expect(
      await failure(
        reviews.decide(moderator, published!.id, { decision: "hide", reason: "x" }, meta(moderator)),
      ),
    ).toMatchObject({ status: 409, reason: "appeal_pending" });
    const same = await failure(
      reviews.decideAppeal(moderator, published!.id, { decision: "grant" }, meta(moderator)),
    );
    expect(same).toMatchObject({ status: 403, reason: "same_moderator" });
    const granted = await reviews.decideAppeal(
      regionAdmin,
      published!.id,
      { decision: "grant", reason: "Є образи" },
      meta(regionAdmin),
    );
    expect(granted).toMatchObject({ status: "hidden", appeal: { status: "granted" } });
    expect((await reviews.placeReviews(regionId, placeId)).items.map((i) => i.id)).not.toContain(
      published!.id,
    );
    expect((await auditOf(published!.id)).map((a) => a.action)).toContain("appeal.decide");
    expect(events.filter((e) => e.event === "review_moderated").at(-1)?.props).toMatchObject({
      decision: "hidden",
    });
  });

  it("бронь вышла из completed до отзыва — право revoked, отзыв 422", async () => {
    const tourist = TOURISTS[3]!;
    const bookingId = await completedBooking(tourist);
    await sql(`UPDATE bookings SET status = 'cancelled_by_partner' WHERE id = $1`, [bookingId]);
    const e = await eligibilityOf(bookingId);
    expect(e).toMatchObject({ status: "revoked", revoke_reason: "booking_cancelled_by_partner" });
    expect(await failure(submit(tourist, e!.id, 5, "Добре"))).toMatchObject({
      status: 422,
      messageKey: "errors.review.eligibilityRevoked",
    });
  });

  it("окно прошло — expired (422), в списке помечается expired", async () => {
    const tourist = TOURISTS[4]!;
    const bookingId = await completedBooking(tourist, REVIEW_PARAMS.eligibilityWindowDays + 2);
    const e = await eligibilityOf(bookingId);
    expect(await failure(submit(tourist, e!.id, 5, "Добре"))).toMatchObject({
      status: 422,
      reason: "eligibility_expired",
    });
    const mine = await reviews.myEligibility(regionId, tourist);
    expect(mine.items[0]).toMatchObject({ status: "expired" });
    expect((await eligibilityOf(bookingId))?.status).toBe("expired");
  });

  it("рейтинг: от minReviews опубликованных — цифра (сглаженная), кэш с версией формулы", async () => {
    for (const tourist of TOURISTS.slice(5, 5 + RATING_PARAMS.minReviews)) {
      const e = await eligibilityOf(await completedBooking(tourist));
      await submit(tourist, e!.id, 5, "Відмінно");
    }
    const { rating } = await reviews.placeReviews(regionId, placeId);
    expect(rating).toMatchObject({ reviewCount: RATING_PARAMS.minReviews, fewReviews: false });
    expect(rating.score).toBeGreaterThan(4);
    expect(rating.score).toBeLessThan(5);
    const cache = await sql(
      `SELECT formula_version, review_count FROM place_review_ratings WHERE place_id = $1`,
      [placeId],
    );
    expect(cache.rows[0]).toMatchObject({
      formula_version: RATING_PARAMS.formulaVersion,
      review_count: RATING_PARAMS.minReviews,
    });
    const many = await reviews.placeRatings(regionId, placeId);
    expect(many.items[0]).toMatchObject({ placeId, reviewCount: RATING_PARAMS.minReviews });
  });
});
