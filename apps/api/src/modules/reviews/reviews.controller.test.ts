// Unit (без БД): HTTP-контракт отзывов — прямой POST /reviews без своего активного права на отзыв отклоняется (ТЗ §16.2:
// 403 без eligibility, 422 — истёкшее/отозванное), флаг module.reviews, 401, валидация; партнёр не может принять
// решение модератора (скрыть отзыв). Сервис настоящий, репозиторий подменён; на БД — test/integration/reviews.test.ts.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule, type ReviewEligibility } from "../../db/index.js";
import { FeatureFlagsModule, FeatureFlagsService } from "../feature-flags/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
  type Grant,
} from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import { REVIEW_PARAMS } from "./review-rules.js";
import { ReviewsModule } from "./reviews.module.js";
import { ReviewsRepository } from "./reviews.repository.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const OTHER = "0190f5c2-7d3e-7000-8000-0000000000ef";
const ELIG = "0190f5c2-7d3e-7000-8000-0000000000e1";
const REVIEW = "0190f5c2-7d3e-7000-8000-0000000000a1";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";
const ORG = "0190f5c2-7d3e-7000-8000-0000000000c1";
const DAY = 24 * 3_600_000;

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const eligibility = (patch: Partial<ReviewEligibility> = {}): ReviewEligibility => ({
  id: ELIG,
  region_id: REGION,
  user_id: USER,
  place_id: PLACE,
  organization_id: ORG,
  level: "verified_booking",
  source_type: "booking",
  booking_id: "0190f5c2-7d3e-7000-8000-0000000000b9",
  source_ended_at: new Date(Date.now() - DAY),
  status: "active",
  issued_at: new Date(),
  consumed_at: null,
  closed_at: null,
  revoke_reason: null,
  created_at: new Date(),
  updated_at: new Date(),
  ...patch,
});

async function start(opts: {
  user?: string | null;
  grants?: Grant[];
  flag?: boolean;
  elig?: ReviewEligibility;
}) {
  const repo = {
    findEligibility: vi.fn(() => Promise.resolve(opts.elig)),
    consumeEligibility: vi.fn(() => Promise.resolve(true)),
    insertReview: vi.fn(() => Promise.reject(new Error("не должен вызываться"))),
    reviewRegion: vi.fn(() => Promise.resolve(REGION)),
  };
  const { db } = recordingDb({});
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      FeatureFlagsModule.forRoot({ appEnv: "local" }),
      ReviewsModule,
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({
      resolve: () => (opts.user ? { userId: opts.user, sessionId: "s1", regionId: null } : undefined),
    })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve(opts.grants ?? []) })
    .overrideProvider(FeatureFlagsService)
    .useValue({ isEnabled: () => Promise.resolve(opts.flag ?? true), effective: () => Promise.resolve({}) })
    .overrideProvider(RegionsRepository)
    .useValue({
      findById: (id: string) => Promise.resolve({ id, status: "active", timezone: "Europe/Kyiv" }),
    })
    .overrideProvider(ReviewsRepository)
    .useValue(repo)
    .compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  return { http: request(app.getHttpServer()), repo };
}

const body = { regionId: REGION, eligibilityId: ELIG, rating: 5, text: "Чудово!" };

describe("POST /reviews — только по своему активному праву (ТЗ §16.2)", () => {
  it("без сессии — 401", async () => {
    const { http } = await start({ user: null });
    await http.post("/reviews").send(body).expect(401);
  });

  it("права нет — 403 errors.review.notEligible, отзыв не создаётся", async () => {
    const { http, repo } = await start({ user: USER });
    const res = await http.post("/reviews").send(body).expect(403);
    expect(res.body.error).toMatchObject({
      messageKey: "errors.review.notEligible",
      details: { reason: "not_eligible" },
    });
    expect(repo.insertReview).not.toHaveBeenCalled();
    expect(repo.consumeEligibility).not.toHaveBeenCalled();
  });

  it("чужое право — 403", async () => {
    const { http, repo } = await start({ user: USER, elig: eligibility({ user_id: OTHER }) });
    await http.post("/reviews").send(body).expect(403);
    expect(repo.insertReview).not.toHaveBeenCalled();
  });

  it("окно прошло — 422 eligibilityExpired; бронь отменена — 422 eligibilityRevoked", async () => {
    const expired = eligibility({
      source_ended_at: new Date(Date.now() - (REVIEW_PARAMS.eligibilityWindowDays + 1) * DAY),
    });
    let s = await start({ user: USER, elig: expired });
    let res = await s.http.post("/reviews").send(body).expect(422);
    expect(res.body.error.messageKey).toBe("errors.review.eligibilityExpired");
    await app?.close();
    s = await start({
      user: USER,
      elig: eligibility({ status: "revoked", revoke_reason: "booking_cancelled_by_partner" }),
    });
    res = await s.http.post("/reviews").send(body).expect(422);
    expect(res.body.error.messageKey).toBe("errors.review.eligibilityRevoked");
    expect(s.repo.insertReview).not.toHaveBeenCalled();
  });

  it("валидация: оценка 1–5, текст до лимита", async () => {
    const { http } = await start({ user: USER });
    await http
      .post("/reviews")
      .send({ ...body, rating: 6 })
      .expect(400);
    await http
      .post("/reviews")
      .send({ ...body, rating: 0 })
      .expect(400);
    await http
      .post("/reviews")
      .send({ ...body, text: "а".repeat(REVIEW_PARAMS.textMax + 1) })
      .expect(400);
    await http
      .post("/reviews")
      .send({ ...body, eligibilityId: "x" })
      .expect(400);
  });

  it("флаг module.reviews выключен в регионе — 404", async () => {
    const { http } = await start({ user: USER, flag: false });
    await http.post("/reviews").send(body).expect(404);
    await http.get(`/reviews?regionId=${REGION}&placeId=${PLACE}`).expect(404);
  });
});

describe("партнёр не скрывает отзыв", () => {
  const owner: Grant = {
    id: "0190f5c2-7d3e-7000-8000-0000000001aa",
    role: "ORG_OWNER",
    scopeType: "ORGANIZATION",
    scopeId: ORG,
    regionId: REGION,
    validUntil: null,
  };

  it("решение модератора от владельца заведения — 403 (права review.moderate нет)", async () => {
    const { http } = await start({ user: USER, grants: [owner] });
    const res = await http
      .post(`/admin/reviews/${REVIEW}/decision`)
      .send({ decision: "hide", reason: "Не подобається" });
    expect(res.status).toBe(403);
    await http.get("/admin/reviews").expect(403);
  });

  it("решение без причины скрытия — 400", async () => {
    const moderator: Grant = { ...owner, role: "MODERATOR", scopeType: "REGION", scopeId: REGION };
    const { http } = await start({ user: USER, grants: [moderator] });
    await http.post(`/admin/reviews/${REVIEW}/decision`).send({ decision: "hide" }).expect(400);
    await http.post(`/admin/reviews/${REVIEW}/decision`).send({ decision: "delete" }).expect(400);
  });
});
