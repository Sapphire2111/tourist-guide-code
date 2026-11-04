import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  InjectDb,
  type AppealKind,
  type AppealStatus,
  type ComplaintKind,
  type ComplaintReason,
  type ComplaintStatus,
  type Db,
  type LocalizedText,
  type PlaceReviewRating,
  type Review,
  type ReviewAppeal,
  type ReviewAutoFlag,
  type ReviewComplaint,
  type ReviewEligibility,
  type ReviewResponse,
  type ReviewRevision,
  type ReviewStatus,
} from "../../db/index.js";
import type { RatingInput, RatingResult } from "./review-rules.js";

// Данные блока 10 (миграция 0028). Вызывается в withTenant(региона): TenantGuardPlugin фильтрует region_id, второй
// рубеж — RLS. Пользовательские фильтры (автор, места партнёра) ставит сервис. Без JOIN — связанные строки отдельными
// запросами (как в bookings.repository).

export type PlaceRef = {
  id: string;
  organization_id: string | null;
  category_id: string;
  status: string;
  name_i18n: LocalizedText;
};

export type ReviewPatch = {
  rating?: number;
  text?: string;
  current_version?: number;
  auto_flags?: ReviewAutoFlag[];
  status?: ReviewStatus;
  published_at?: Date | null;
  hidden_reason?: string | null;
  last_decision_by?: string | null;
  last_decision_at?: Date | null;
};

@Injectable()
export class ReviewsRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  private get q(): Db {
    return currentDb(this.db);
  }

  // --- места, пользователи ---

  findPlace(id: string): Promise<PlaceRef | undefined> {
    return this.q
      .selectFrom("places")
      .select(["id", "organization_id", "category_id", "status", "name_i18n"])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  async placeNames(ids: readonly string[]): Promise<Map<string, LocalizedText>> {
    if (ids.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("places")
      .select(["id", "name_i18n"])
      .where("id", "in", [...new Set(ids)])
      .execute();
    return new Map(rows.map((r) => [r.id, r.name_i18n]));
  }

  /** Из списка — id опубликованных мест региона (один запрос). */
  async publishedPlaceIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.q
      .selectFrom("places")
      .select("id")
      .where("id", "in", [...new Set(ids)])
      .where("status", "=", "published")
      .execute();
    return new Set(rows.map((r) => r.id));
  }

  async placesOfOrganizations(
    organizationIds: readonly string[],
  ): Promise<{ id: string; organization_id: string }[]> {
    if (organizationIds.length === 0) return [];
    const rows = await this.q
      .selectFrom("places")
      .select(["id", "organization_id"])
      .where("organization_id", "in", [...new Set(organizationIds)])
      .execute();
    return rows.flatMap((r) => (r.organization_id ? [{ id: r.id, organization_id: r.organization_id }] : []));
  }

  async users(
    ids: readonly string[],
  ): Promise<Map<string, { id: string; display_name: string | null; analytics_id: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("users")
      .select(["id", "display_name", "analytics_id"])
      .where("id", "in", [...new Set(ids)])
      .execute();
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Регион отзыва по id (функция 0028, режим SYSTEM) — вне tenant-контекста. */
  async reviewRegion(reviewId: string): Promise<string | undefined> {
    const row = await this.q
      .selectNoFrom(sql<string | null>`app_review_region(${reviewId}::uuid)`.as("region_id"))
      .executeTakeFirst();
    return row?.region_id ?? undefined;
  }

  // --- право на отзыв ---

  eligibilitiesOfUser(userId: string): Promise<ReviewEligibility[]> {
    return this.q
      .selectFrom("review_eligibilities")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("issued_at", "desc")
      .orderBy("id", "desc")
      .limit(200)
      .execute();
  }

  findEligibility(id: string, lock = false): Promise<ReviewEligibility | undefined> {
    let q = this.q.selectFrom("review_eligibilities").selectAll().where("id", "=", id);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async expireEligibilities(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.q
      .updateTable("review_eligibilities")
      .set({ status: "expired", closed_at: new Date() })
      .where("id", "in", [...ids])
      .where("status", "=", "active")
      .execute();
  }

  async consumeEligibility(id: string, at: Date): Promise<boolean> {
    const r = await this.q
      .updateTable("review_eligibilities")
      .set({ status: "consumed", consumed_at: at, closed_at: at })
      .where("id", "=", id)
      .where("status", "=", "active")
      .executeTakeFirst();
    return Number(r.numUpdatedRows) === 1;
  }

  // --- отзывы и версии ---

  findReview(id: string, lock = false): Promise<Review | undefined> {
    let q = this.q.selectFrom("reviews").selectAll().where("id", "=", id);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  reviewByEligibility(eligibilityId: string, lock = false): Promise<Review | undefined> {
    let q = this.q.selectFrom("reviews").selectAll().where("eligibility_id", "=", eligibilityId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async reviewsByEligibilities(ids: readonly string[]): Promise<Map<string, Review>> {
    if (ids.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("reviews")
      .selectAll()
      .where("eligibility_id", "in", [...new Set(ids)])
      .execute();
    return new Map(rows.map((r) => [r.eligibility_id, r]));
  }

  insertReview(row: {
    place_id: string;
    organization_id: string | null;
    author_user_id: string;
    eligibility_id: string;
    rating: number;
    text: string;
    auto_flags: ReviewAutoFlag[];
    status: ReviewStatus;
    published_at: Date | null;
  }): Promise<Review> {
    return this.q
      .insertInto("reviews")
      .values({ ...row, verification_level: "verified_booking", current_version: 1 })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updateReview(id: string, patch: ReviewPatch): Promise<Review | undefined> {
    return this.q
      .updateTable("reviews")
      .set({ ...patch, version: sql<number>`version + 1` })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  async insertRevision(row: {
    review_id: string;
    version_no: number;
    rating: number;
    text: string;
    auto_flags: ReviewAutoFlag[];
  }): Promise<void> {
    await this.q.insertInto("review_revisions").values(row).execute();
  }

  async revisions(reviewIds: readonly string[]): Promise<Map<string, ReviewRevision[]>> {
    const out = new Map<string, ReviewRevision[]>();
    if (reviewIds.length === 0) return out;
    const rows = await this.q
      .selectFrom("review_revisions")
      .selectAll()
      .where("review_id", "in", [...new Set(reviewIds)])
      .orderBy("version_no")
      .execute();
    for (const r of rows) out.set(r.review_id, [...(out.get(r.review_id) ?? []), r]);
    return out;
  }

  /** Опубликованные отзывы места, новые сверху. */
  publishedOfPlace(placeId: string, limit: number): Promise<Review[]> {
    return this.q
      .selectFrom("reviews")
      .selectAll()
      .where("place_id", "=", placeId)
      .where("status", "=", "published")
      .orderBy("published_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
  }

  reviewsOfPlaces(placeIds: readonly string[], limit: number): Promise<Review[]> {
    if (placeIds.length === 0) return Promise.resolve([]);
    return this.q
      .selectFrom("reviews")
      .selectAll()
      .where("place_id", "in", [...new Set(placeIds)])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
  }

  reviewsByIds(ids: readonly string[]): Promise<Review[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.q
      .selectFrom("reviews")
      .selectAll()
      .where("id", "in", [...new Set(ids)])
      .execute();
  }

  reviewsByStatus(status: ReviewStatus | undefined, limit: number): Promise<Review[]> {
    let q = this.q.selectFrom("reviews").selectAll();
    if (status) q = q.where("status", "=", status);
    return q.orderBy("created_at", "desc").orderBy("id", "desc").limit(limit).execute();
  }

  /** Очередь модерации: отфильтрованные, с открытой жалобой или открытой апелляцией (старые сверху). */
  async queueIds(limit: number): Promise<string[]> {
    const [pending, complaints, appeals] = await Promise.all([
      this.q
        .selectFrom("reviews")
        .select(["id", "created_at"])
        .where("status", "=", "pending_moderation")
        .orderBy("created_at")
        .limit(limit)
        .execute(),
      this.q
        .selectFrom("review_complaints")
        .select(["review_id as id", "created_at"])
        .where("status", "=", "open")
        .orderBy("created_at")
        .limit(limit)
        .execute(),
      this.q
        .selectFrom("review_appeals")
        .select(["review_id as id", "created_at"])
        .where("status", "=", "open")
        .orderBy("created_at")
        .limit(limit)
        .execute(),
    ]);
    const first = new Map<string, number>();
    for (const r of [...pending, ...complaints, ...appeals]) {
      const t = r.created_at.getTime();
      if (!first.has(r.id) || first.get(r.id)! > t) first.set(r.id, t);
    }
    return [...first.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([id]) => id);
  }

  // --- ответ партнёра ---

  async responses(reviewIds: readonly string[]): Promise<Map<string, ReviewResponse>> {
    if (reviewIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("review_responses")
      .selectAll()
      .where("review_id", "in", [...new Set(reviewIds)])
      .execute();
    return new Map(rows.map((r) => [r.review_id, r]));
  }

  findResponse(reviewId: string): Promise<ReviewResponse | undefined> {
    return this.q
      .selectFrom("review_responses")
      .selectAll()
      .where("review_id", "=", reviewId)
      .forUpdate()
      .executeTakeFirst();
  }

  insertResponse(row: { review_id: string; author_user_id: string; text: string }): Promise<ReviewResponse> {
    return this.q.insertInto("review_responses").values(row).returningAll().executeTakeFirstOrThrow();
  }

  updateResponse(id: string, patch: { author_user_id: string; text: string }): Promise<ReviewResponse> {
    return this.q
      .updateTable("review_responses")
      .set({ ...patch, version: sql<number>`version + 1` })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  // --- жалобы ---

  async complaints(reviewIds: readonly string[]): Promise<Map<string, ReviewComplaint[]>> {
    const out = new Map<string, ReviewComplaint[]>();
    if (reviewIds.length === 0) return out;
    const rows = await this.q
      .selectFrom("review_complaints")
      .selectAll()
      .where("review_id", "in", [...new Set(reviewIds)])
      .orderBy("created_at")
      .execute();
    for (const r of rows) out.set(r.review_id, [...(out.get(r.review_id) ?? []), r]);
    return out;
  }

  insertComplaint(row: {
    review_id: string;
    complainant_user_id: string;
    complainant_kind: ComplaintKind;
    reason_code: ComplaintReason;
    text: string | null;
  }): Promise<ReviewComplaint> {
    return this.q.insertInto("review_complaints").values(row).returningAll().executeTakeFirstOrThrow();
  }

  /** Решение по отзыву закрывает его открытые жалобы; возвращает закрытые. */
  closeComplaints(reviewId: string, status: Exclude<ComplaintStatus, "open">, by: string, at: Date) {
    return this.q
      .updateTable("review_complaints")
      .set({ status, decided_by: by, decided_at: at })
      .where("review_id", "=", reviewId)
      .where("status", "=", "open")
      .returning(["id", "complainant_user_id", "complainant_kind"])
      .execute();
  }

  // --- апелляции ---

  async appeals(reviewIds: readonly string[]): Promise<Map<string, ReviewAppeal>> {
    if (reviewIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("review_appeals")
      .selectAll()
      .where("review_id", "in", [...new Set(reviewIds)])
      .execute();
    return new Map(rows.map((r) => [r.review_id, r]));
  }

  appealOf(reviewId: string, lock = false): Promise<ReviewAppeal | undefined> {
    let q = this.q.selectFrom("review_appeals").selectAll().where("review_id", "=", reviewId);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  insertAppeal(row: {
    review_id: string;
    appellant_user_id: string;
    appellant_kind: AppealKind;
    text: string;
    appealed_decision_by: string;
    appealed_review_status: ReviewStatus;
  }): Promise<ReviewAppeal> {
    return this.q.insertInto("review_appeals").values(row).returningAll().executeTakeFirstOrThrow();
  }

  decideAppeal(
    id: string,
    patch: {
      status: Exclude<AppealStatus, "open">;
      decided_by: string;
      decided_at: Date;
      decision_note: string | null;
    },
  ): Promise<ReviewAppeal | undefined> {
    return this.q
      .updateTable("review_appeals")
      .set(patch)
      .where("id", "=", id)
      .where("status", "=", "open")
      .returningAll()
      .executeTakeFirst();
  }

  // --- рейтинг ---

  async ratingInputs(placeId: string): Promise<RatingInput[]> {
    const rows = await this.q
      .selectFrom("reviews")
      .select(["rating", "published_at"])
      .where("place_id", "=", placeId)
      .where("status", "=", "published")
      .execute();
    return rows.map((r) => ({ rating: r.rating, publishedAt: r.published_at ?? new Date(0) }));
  }

  /** Опубликованные отзывы мест категории (для априорного среднего). */
  async categoryStats(categoryId: string): Promise<{ count: number; sum: number }> {
    const places = this.q.selectFrom("places").select("id").where("category_id", "=", categoryId);
    const row = await this.q
      .selectFrom("reviews")
      .select([sql<string>`count(*)`.as("count"), sql<string | null>`sum(rating)`.as("sum")])
      .where("status", "=", "published")
      .where("place_id", "in", places)
      .executeTakeFirst();
    return { count: Number(row?.count ?? 0), sum: Number(row?.sum ?? 0) };
  }

  /** Блокировка пересчёта рейтинга места до конца транзакции (advisory, по hashtext ключа). */
  async lockRating(placeId: string): Promise<void> {
    await this.q
      .selectNoFrom(
        sql<string>`pg_advisory_xact_lock(hashtext(${`review_rating:${placeId}`}))::text`.as("locked"),
      )
      .execute();
  }

  async ratings(placeIds: readonly string[]): Promise<Map<string, PlaceReviewRating>> {
    if (placeIds.length === 0) return new Map();
    const rows = await this.q
      .selectFrom("place_review_ratings")
      .selectAll()
      .where("place_id", "in", [...new Set(placeIds)])
      .execute();
    return new Map(rows.map((r) => [r.place_id, r]));
  }

  upsertRating(placeId: string, r: RatingResult, at: Date): Promise<PlaceReviewRating> {
    const values = {
      formula_version: r.formulaVersion,
      review_count: r.reviewCount,
      average: r.average,
      score: r.score,
      computed_at: at,
    };
    return this.q
      .insertInto("place_review_ratings")
      .values({ place_id: placeId, ...values })
      .onConflict((oc) => oc.columns(["region_id", "place_id"]).doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
