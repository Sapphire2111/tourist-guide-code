// Unit (без БД): правила ReviewsService поверх репозитория в памяти — скрытый отзыв не возвращается в публикацию
// правками, BR-12 для автора, повтор без изменений без версии, окно правки, финальность апелляции, апелляция только по
// своей отклонённой жалобе, пустой текст апелляции, рейтинги пачкой без записи. На БД — test/integration/reviews.test.ts.
import { describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import type { Review, ReviewAppeal, ReviewComplaint, ReviewEligibility } from "../../db/index.js";
import type { AuditService } from "../audit/index.js";
import { roleHasPermission, type Grant, type RbacService } from "../rbac/index.js";
import type { RegionsRepository } from "../regions/index.js";
import { REVIEW_PARAMS } from "./review-rules.js";
import type { ReviewsRepository } from "./reviews.repository.js";
import { ReviewsService } from "./reviews.service.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const AUTHOR = "0190f5c2-7d3e-7000-8000-0000000000ee";
const OWNER = "0190f5c2-7d3e-7000-8000-0000000000e2";
const MANAGER = "0190f5c2-7d3e-7000-8000-0000000000e3";
const MOD_A = "0190f5c2-7d3e-7000-8000-0000000000d1";
const MOD_B = "0190f5c2-7d3e-7000-8000-0000000000d2";
const ELIG = "0190f5c2-7d3e-7000-8000-0000000000e1";
const REVIEW = "0190f5c2-7d3e-7000-8000-0000000000a1";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";
const ORG = "0190f5c2-7d3e-7000-8000-0000000000c1";
const DAY = 24 * 3_600_000;

const grant = (role: string, scopeType: Grant["scopeType"], scopeId: string): Grant => ({
  id: `0190f5c2-7d3e-7000-8000-${String(role.length).padStart(12, "0")}`,
  role,
  scopeType,
  scopeId,
  regionId: REGION,
  validUntil: null,
});
const GRANTS: Record<string, Grant[]> = {
  [AUTHOR]: [],
  [OWNER]: [grant("ORG_OWNER", "ORGANIZATION", ORG)],
  [MANAGER]: [grant("ORG_MANAGER", "ORGANIZATION", ORG)],
  [MOD_A]: [grant("MODERATOR", "REGION", REGION)],
  [MOD_B]: [grant("REGION_ADMIN", "REGION", REGION)],
};

function setup(opts: { reviewCreatedAt?: Date; authorGrants?: Grant[] } = {}) {
  const now = new Date();
  const eligibility: ReviewEligibility = {
    id: ELIG,
    region_id: REGION,
    user_id: AUTHOR,
    place_id: PLACE,
    organization_id: ORG,
    level: "verified_booking",
    source_type: "booking",
    booking_id: "0190f5c2-7d3e-7000-8000-0000000000b9",
    source_ended_at: new Date(now.getTime() - DAY),
    status: "consumed",
    issued_at: now,
    consumed_at: now,
    closed_at: now,
    revoke_reason: null,
    created_at: now,
    updated_at: now,
  };
  const review: Review = {
    id: REVIEW,
    region_id: REGION,
    place_id: PLACE,
    organization_id: ORG,
    author_user_id: AUTHOR,
    eligibility_id: ELIG,
    verification_level: "verified_booking",
    rating: 4,
    text: "Добре",
    current_version: 1,
    auto_flags: [],
    status: "published",
    published_at: now,
    hidden_reason: null,
    last_decision_by: null,
    last_decision_at: null,
    version: 1,
    created_at: opts.reviewCreatedAt ?? now,
    updated_at: now,
  };
  const complaints: ReviewComplaint[] = [];
  let appeal: ReviewAppeal | undefined;
  const revisions: number[] = [];
  const repo = {
    findEligibility: () => Promise.resolve(eligibility),
    consumeEligibility: () => Promise.resolve(true),
    reviewByEligibility: () => Promise.resolve({ ...review }),
    findReview: () => Promise.resolve({ ...review }),
    reviewRegion: () => Promise.resolve(REGION),
    updateReview: (_id: string, patch: Partial<Review>) => {
      Object.assign(review, patch, { version: review.version + 1 });
      return Promise.resolve({ ...review });
    },
    insertRevision: (row: { version_no: number }) => {
      revisions.push(row.version_no);
      return Promise.resolve();
    },
    responses: () => Promise.resolve(new Map()),
    appeals: () => Promise.resolve(new Map(appeal ? [[REVIEW, appeal]] : [])),
    appealOf: () => Promise.resolve(appeal),
    insertAppeal: (row: Partial<ReviewAppeal>) => {
      appeal = { ...row, id: "ap1", status: "open", created_at: now } as ReviewAppeal;
      return Promise.resolve(appeal);
    },
    decideAppeal: (_id: string, patch: Partial<ReviewAppeal>) => {
      Object.assign(appeal!, patch);
      return Promise.resolve(appeal);
    },
    complaints: () => Promise.resolve(new Map([[REVIEW, complaints]])),
    closeComplaints: (_id: string, status: ReviewComplaint["status"], by: string) => {
      for (const c of complaints)
        if (c.status === "open") Object.assign(c, { status, decided_by: by, decided_at: now });
      return Promise.resolve([]);
    },
    revisions: () => Promise.resolve(new Map()),
    placeNames: () => Promise.resolve(new Map()),
    users: () => Promise.resolve(new Map()),
    findPlace: () =>
      Promise.resolve({
        id: PLACE,
        organization_id: ORG,
        category_id: "c",
        status: "published",
        name_i18n: { uk: "" },
      }),
    lockRating: vi.fn(() => Promise.resolve()),
    ratingInputs: () => Promise.resolve([]),
    categoryStats: () => Promise.resolve({ count: 0, sum: 0 }),
    upsertRating: vi.fn(() => Promise.resolve({})),
    publishedPlaceIds: vi.fn((ids: string[]) => Promise.resolve(new Set(ids.slice(0, 1)))),
    ratings: vi.fn(() => Promise.resolve(new Map())),
  };
  const grantsOf = (u: string) =>
    Promise.resolve(u === AUTHOR && opts.authorGrants ? opts.authorGrants : GRANTS[u]!);
  const rbac = {
    grantsOf,
    authorize: async (grants: Grant[], permission: Parameters<typeof roleHasPermission>[1]) => {
      const g = grants.find((x) => roleHasPermission(x.role, permission));
      return g && { grant: g };
    },
  } as unknown as RbacService;
  const { db } = recordingDb({});
  const service = new ReviewsService(
    db,
    repo as unknown as ReviewsRepository,
    { findById: (id: string) => Promise.resolve({ id, status: "active" }) } as unknown as RegionsRepository,
    rbac,
    { record: vi.fn(() => Promise.resolve()) } as unknown as AuditService,
    { isEnabled: () => Promise.resolve(true) },
  );
  const meta = (userId: string) => ({ actor: { type: "user" as const, userId }, roleAssignmentId: null });
  const submit = (rating: number, text: string) =>
    service.submit(AUTHOR, { regionId: REGION, eligibilityId: ELIG, rating, text }, meta(AUTHOR));
  return { service, repo, review, complaints, revisions, submit, meta, getAppeal: () => appeal };
}

async function failure(p: Promise<unknown>) {
  const e = (await p.then(
    () => undefined,
    (err: unknown) => err,
  )) as { getStatus?: () => number; details?: { reason?: unknown } } | undefined;
  if (!e?.getStatus) throw new Error(`Ожидалась ApiError, получено: ${String(e)}`);
  return { status: e.getStatus(), reason: e.details?.reason };
}

describe("ReviewsService: правки отзыва", () => {
  it("скрытый модератором отзыв не возвращается в публикацию ни одной, ни двумя правками", async () => {
    const t = setup();
    await t.service.decide(MOD_A, REVIEW, { decision: "hide", reason: "Образи" }, t.meta(MOD_A));
    expect(t.review.status).toBe("hidden");
    expect((await t.submit(5, "Виправила текст")).status).toBe("pending_moderation");
    expect((await t.submit(5, "Ще раз виправила")).status).toBe("pending_moderation");
    // Только решение модератора возвращает отзыв.
    await t.service.decide(MOD_A, REVIEW, { decision: "publish" }, t.meta(MOD_A));
    expect(t.review).toMatchObject({ status: "published", hidden_reason: null });
    expect((await t.submit(4, "Тепер усе добре")).status).toBe("published");
  });

  it("повтор без изменений — без новой версии; окно правки прошло — 422", async () => {
    const t = setup();
    const same = await t.submit(4, "  Добре ");
    expect(same.version).toBe(1);
    expect(t.revisions).toEqual([]);
    const old = setup({ reviewCreatedAt: new Date(Date.now() - (REVIEW_PARAMS.editWindowDays + 1) * DAY) });
    expect(await failure(old.submit(5, "Нове"))).toEqual({ status: 422, reason: "edit_window_closed" });
  });

  it("BR-12: сотрудник/владелец организации места не пишет отзыв о своём заведении — 403", async () => {
    const t = setup({ authorGrants: [grant("ORG_STAFF", "PLACE", PLACE)] });
    expect(await failure(t.submit(5, "Найкращий заклад"))).toEqual({
      status: 403,
      reason: "own_organization",
    });
  });
});

describe("ReviewsService: апелляции", () => {
  const complaint = (by: string): ReviewComplaint => ({
    id: `c-${by}`,
    region_id: REGION,
    review_id: REVIEW,
    complainant_user_id: by,
    complainant_kind: "partner",
    reason_code: "insult",
    text: null,
    status: "open",
    decided_by: null,
    decided_at: null,
    created_at: new Date(),
  });

  it("партнёр апеллирует только по своей отклонённой жалобе", async () => {
    const t = setup();
    t.complaints.push(complaint(MANAGER));
    await t.service.decide(MOD_A, REVIEW, { decision: "publish" }, t.meta(MOD_A));
    // Жалобу подавал менеджер, апеллирует владелец — нельзя.
    expect(
      await failure(
        t.service.appeal(OWNER, { regionId: REGION, reviewId: REVIEW, text: "Перегляньте" }, t.meta(OWNER)),
      ),
    ).toMatchObject({ status: 422, reason: "appeal_not_allowed" });
    t.complaints.push({
      ...complaint(OWNER),
      status: "dismissed",
      decided_by: MOD_A,
      decided_at: new Date(),
    });
    const ok = await t.service.appeal(
      OWNER,
      { regionId: REGION, reviewId: REVIEW, text: "Перегляньте" },
      t.meta(OWNER),
    );
    expect(ok).toMatchObject({ kind: "partner", status: "open" });
  });

  it("текст апелляции из пробелов — 400", async () => {
    const t = setup();
    expect(
      await failure(
        t.service.appeal(AUTHOR, { regionId: REGION, reviewId: REVIEW, text: "   " }, t.meta(AUTHOR)),
      ),
    ).toMatchObject({ status: 400 });
  });

  it("решение по апелляции финально: модератор обжалованного решения не переигрывает его", async () => {
    const t = setup();
    await t.service.decide(MOD_A, REVIEW, { decision: "hide", reason: "Образи" }, t.meta(MOD_A));
    await t.service.appeal(
      AUTHOR,
      { regionId: REGION, reviewId: REVIEW, text: "Образ немає" },
      t.meta(AUTHOR),
    );
    expect(await failure(t.service.decideAppeal(MOD_A, REVIEW, { decision: "deny" }, t.meta(MOD_A)))).toEqual(
      {
        status: 403,
        reason: "same_moderator",
      },
    );
    await t.service.decideAppeal(MOD_B, REVIEW, { decision: "deny" }, t.meta(MOD_B));
    expect(t.getAppeal()?.status).toBe("denied");
    expect(await failure(t.service.decide(MOD_A, REVIEW, { decision: "publish" }, t.meta(MOD_A)))).toEqual({
      status: 403,
      reason: "appeal_final",
    });
  });
});

describe("ReviewsService: рейтинг", () => {
  it("пересчёт при решении — под блокировкой места; GET пачкой — без записи и без запроса на каждое место", async () => {
    const t = setup();
    await t.service.decide(MOD_A, REVIEW, { decision: "hide", reason: "Образи" }, t.meta(MOD_A));
    expect(t.repo.lockRating).toHaveBeenCalledWith(PLACE);
    t.repo.upsertRating.mockClear();
    const other = "0190f5c2-7d3e-7000-8000-0000000000b2";
    const list = await t.service.placeRatings(REGION, `${PLACE},${other}`);
    expect(list.items).toEqual([
      expect.objectContaining({ placeId: PLACE, reviewCount: 0, fewReviews: true }),
    ]);
    expect(t.repo.publishedPlaceIds).toHaveBeenCalledTimes(1);
    expect(t.repo.ratings).toHaveBeenCalledTimes(1);
    expect(t.repo.upsertRating).not.toHaveBeenCalled();
  });
});
