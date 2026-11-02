// Unit (без БД): GET /admin/audit-logs — доступ по праву audit.read (T1-12: без принципала 401, без назначения 403,
// PLATFORM — все регионы); фильтры, курсорная пагинация, регион из tenant-контекста (назначения принципала), ПДн в
// ответе нет. На реальной БД — test/integration/audit.test.ts.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { CompiledQuery } from "kysely";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorEnvelope } from "@tg/shared";
import { recordingDb, type Respond } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
  type Grant,
  type Principal,
} from "../rbac/index.js";
import { encodeAuditCursor } from "./audit-cursor.js";
import { AuditModule } from "./audit.module.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const ORG = "0190f5c2-7d3e-7000-8000-0000000000c1";

function grant(
  role: string,
  scopeType: Grant["scopeType"],
  scopeId: string | null,
  regionId: string | null,
): Grant {
  return { id: "0190f5c2-7d3e-7000-8000-0000000001aa", role, scopeType, scopeId, regionId, validUntil: null };
}

const AUDITOR_A = grant("TECH_AUDITOR", "REGION", A, A);

function row(n: number) {
  return {
    id: `0190f5c2-7d3e-7000-8000-${String(n).padStart(12, "0")}`,
    actor_type: "user",
    actor_user_id: USER,
    region_id: A,
    action: "role.assign",
    entity_type: "role_assignment",
    entity_id: `ra-${n}`,
    old_values: null,
    new_values: { role: "X" },
    reason: null,
    request_id: "req",
    role_assignment_id: null,
    created_at: new Date("2026-11-01T10:00:00Z"),
    // Лишнее поле в строке не должно попасть в ответ (ответ собирается явно).
    ip: "203.0.113.7",
  };
}

async function start(opts: { principal?: Principal; grants?: Grant[]; respond?: Respond }) {
  const { db, queries } = recordingDb({}, opts.respond);
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      AuditModule,
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => opts.principal })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve(opts.grants ?? []) })
    .compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "prod" });
  await app.init();
  return { app, queries };
}

const selects = (queries: CompiledQuery[]) => queries.filter((q) => q.sql.startsWith("select"));

describe("GET /admin/audit-logs", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("без принципала (до T1-26) — 401 UNAUTHENTICATED, в БД ничего не уходит", async () => {
    const started = await start({});
    app = started.app;
    const res = await request(app.getHttpServer()).get("/admin/audit-logs").expect(401);
    expect((res.body as ErrorEnvelope).error.code).toBe("UNAUTHENTICATED");
    expect(started.queries).toEqual([]);
  });

  it("403 FORBIDDEN без запросов к аудиту: нет назначения; роль без audit.read; выбран регион без назначения", async () => {
    for (const [principal, grants] of [
      [{ userId: USER }, []],
      [{ userId: USER }, [grant("TECH_ORG_EDITOR", "ORGANIZATION", ORG, A)]],
      [{ userId: USER, regionId: B }, [AUDITOR_A]],
    ] as [Principal, Grant[]][]) {
      const started = await start({ principal, grants });
      app = started.app;
      const res = await request(app.getHttpServer()).get("/admin/audit-logs").expect(403);
      expect((res.body as ErrorEnvelope).error.code, JSON.stringify(grants)).toBe("FORBIDDEN");
      expect(started.queries).toEqual([]);
      await app.close();
      app = undefined;
    }
  });

  it("назначение на PLATFORM — лента всех регионов (без фильтра region_id)", async () => {
    const started = await start({
      principal: { userId: USER },
      grants: [grant("TECH_SUPERUSER", "PLATFORM", null, null)],
    });
    app = started.app;
    await request(app.getHttpServer()).get("/admin/audit-logs").expect(200);
    expect(selects(started.queries).map((q) => q.sql)).toEqual([
      'select * from "audit_logs" order by "id" desc limit $1',
    ]);
  });

  describe("аудитор региона A", () => {
    let queries: CompiledQuery[];

    beforeEach(async () => {
      // Отдаёт limit строк, чтобы проверить nextCursor.
      const started = await start({
        principal: { userId: USER },
        grants: [AUDITOR_A],
        respond: (q) =>
          q.sql.startsWith("select")
            ? Array.from({ length: Number(q.parameters.at(-1)) }, (_, i) => row(100 - i))
            : [],
      });
      app = started.app;
      queries = started.queries;
    });

    it("фильтры и регион контекста в SQL; страница без ПДн; nextCursor — id последней записи", async () => {
      const res = await request(app!.getHttpServer())
        .get("/admin/audit-logs")
        .query({
          entityType: "role_assignment",
          entityId: "ra-1",
          actorUserId: USER,
          from: "2026-10-01T00:00:00Z",
          to: "2026-11-01T00:00:00Z",
          limit: 2,
        })
        .expect(200);
      expect(selects(queries).map((q) => q.sql)).toEqual([
        'select * from "audit_logs" where ("entity_type" = $1 and "entity_id" = $2 and "actor_user_id" = $3 and "created_at" >= $4 and "created_at" < $5) and "audit_logs"."region_id" = $6 order by "id" desc limit $7',
      ]);
      expect(selects(queries)[0]!.parameters).toEqual([
        "role_assignment",
        "ra-1",
        USER,
        new Date("2026-10-01T00:00:00Z"),
        new Date("2026-11-01T00:00:00Z"),
        A,
        3,
      ]);
      const body = res.body as { items: Record<string, unknown>[]; nextCursor: string | null };
      expect(body.items).toHaveLength(2);
      expect(body.items[0]).toEqual({
        id: row(100).id,
        actorType: "user",
        actorUserId: USER,
        regionId: A,
        action: "role.assign",
        entityType: "role_assignment",
        entityId: "ra-100",
        oldValues: null,
        newValues: { role: "X" },
        reason: null,
        requestId: "req",
        roleAssignmentId: null,
        createdAt: "2026-11-01T10:00:00.000Z",
      });
      expect(body.nextCursor).toBe(encodeAuditCursor(row(99).id));
    });

    it("фильтр по коду действия (action)", async () => {
      await request(app!.getHttpServer())
        .get("/admin/audit-logs")
        .query({ action: "qr_point.create" })
        .expect(200);
      expect(selects(queries)[0]!.sql).toBe(
        'select * from "audit_logs" where ("action" = $1) and "audit_logs"."region_id" = $2 order by "id" desc limit $3',
      );
      expect(selects(queries)[0]!.parameters).toEqual(["qr_point.create", A, 21]);
    });

    it("курсор → условие id < курсора; последняя страница — nextCursor null", async () => {
      const cursor = encodeAuditCursor(row(50).id);
      const res = await request(app!.getHttpServer()).get("/admin/audit-logs").query({ cursor }).expect(200);
      expect(selects(queries)[0]!.sql).toBe(
        'select * from "audit_logs" where ("id" < $1) and "audit_logs"."region_id" = $2 order by "id" desc limit $3',
      );
      expect(selects(queries)[0]!.parameters).toEqual([row(50).id, A, 21]);
      // Отдано 21 строка при limit 20 → есть следующая страница.
      expect((res.body as { nextCursor: string | null }).nextCursor).not.toBeNull();
    });

    it("битый курсор и неверные фильтры — 400 VALIDATION_FAILED, в БД не идём", async () => {
      for (const query of [
        { cursor: "не-курсор" },
        { cursor: Buffer.from('{"id":"1"}').toString("base64url") },
        { actorUserId: "не-uuid" },
        { from: "вчера" },
        { from: "2026-W01" },
        { from: "2026-W01-1" },
        { to: "2026-123" },
        { from: "2026-11-01T10:00" },
        { to: "2026-11-01T10:00:00" },
        { limit: 0 },
        { region_id: A },
      ]) {
        const res = await request(app!.getHttpServer()).get("/admin/audit-logs").query(query).expect(400);
        expect((res.body as ErrorEnvelope).error.code, JSON.stringify(query)).toBe("VALIDATION_FAILED");
      }
      expect(selects(queries)).toEqual([]);
    });
  });
});
