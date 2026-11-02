// Unit (Nest testing, без БД): @RequirePermission + PermissionGuard, глобальный PrincipalGuard и tenant-контекст
// из назначений (RbacTenantContextSource). Назначения и иерархия — в памяти (подмена провайдеров).
import {
  Controller,
  Get,
  Inject,
  Param,
  Req,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ErrorEnvelope } from "@tg/shared";
import { recordingDb } from "../../../test/support/recording-db.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule, WithoutTenantContext } from "../../common/tenancy/index.js";
import { currentTenant, DATABASE, DatabaseModule } from "../../db/index.js";
import { AuditLogRepository, AuditModule } from "../audit/index.js";
import type { Grant } from "./access.js";
import { PermissionGuard, RequirePermission, type RbacRequest } from "./permission.guard.js";
import { PRINCIPAL_SOURCE, type Principal } from "./principal.js";
import { RbacModule } from "./rbac.module.js";
import type { RbacService, RequestAccess } from "./rbac.service.js";
import { RbacTenantContextSource } from "./principal.guard.js";
import { RoleAssignmentsRepository } from "./role-assignments.repository.js";
import { PLATFORM_SCOPE, regionScope, SCOPE_PARENT_LOADERS, type ScopeRef } from "./scope.js";
import { platformScope, scopeFromParam, scopeFromTenant } from "./scope-resolvers.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const ORG_A = "0190f5c2-7d3e-7000-8000-0000000000a1";
const ORG_B = "0190f5c2-7d3e-7000-8000-0000000000b1";
const MISSING = "0190f5c2-7d3e-7000-8000-0000000000ff";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";

function grant(id: string, role: string, s: ScopeRef, regionId: string | null): Grant {
  return {
    id,
    role,
    scopeType: s.type,
    scopeId: s.type === "PLATFORM" ? null : s.id,
    regionId,
    validUntil: null,
  };
}

const REGION_ADMIN_A = grant("0190f5c2-7d3e-7000-8000-000000000101", "TECH_REGION_ADMIN", regionScope(A), A);
const SUPERUSER = grant("0190f5c2-7d3e-7000-8000-000000000102", "TECH_SUPERUSER", PLATFORM_SCOPE, null);
const AUDITOR_B = grant("0190f5c2-7d3e-7000-8000-000000000103", "TECH_AUDITOR", regionScope(B), B);

@Controller("t112")
class ProbeController {
  constructor(@Inject(AuditLogRepository) private readonly audit: AuditLogRepository) {}

  /** Объект из пути; в ответе — что увидел обработчик (tenant, актор, назначение). */
  @Get("orgs/:orgId")
  @RequirePermission("organization.edit", scopeFromParam("ORGANIZATION", "orgId"))
  org(@Param("orgId") _orgId: string, @Req() req: RbacRequest) {
    return { tenant: currentTenant() ?? null, user: req.user, grantId: req.authorization?.grant.id };
  }

  /** Область — tenant-контекст; обработчик читает tenant-таблицу (видно регион транзакции в SQL). */
  @Get("region-audit")
  @RequirePermission("audit.read", scopeFromTenant)
  regionAudit() {
    return this.audit.listRecent(1);
  }

  /** Без @RequirePermission: доступен всем, принципал (если есть) выставлен. */
  @Get("open")
  open(@Req() req: RbacRequest) {
    return { user: req.user ?? null, principal: req.principal ?? null };
  }
}

describe("@RequirePermission / PermissionGuard", () => {
  const { db, queries } = recordingDb();
  let principal: Principal | undefined;
  let grants: Grant[] = [];
  let grantLoads = 0;
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
        RbacModule,
        AuditModule,
      ],
      controllers: [ProbeController],
    })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(PRINCIPAL_SOURCE)
      .useValue({ resolve: () => principal })
      .overrideProvider(RoleAssignmentsRepository)
      .useValue({
        activeGrantsOf: (userId: string) => {
          grantLoads += 1;
          return Promise.resolve(userId === principal?.userId ? grants : []);
        },
      })
      .overrideProvider(SCOPE_PARENT_LOADERS)
      .useValue({
        ORGANIZATION: (id: string) => ({ [ORG_A]: regionScope(A), [ORG_B]: regionScope(B) })[id],
      })
      .compile();
    app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "prod" });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    principal = { userId: USER };
    grants = [];
    grantLoads = 0;
    queries.length = 0;
  });

  const get = (path: string, status: number) => request(app.getHttpServer()).get(path).expect(status);
  const code = (res: { body: unknown }) => (res.body as ErrorEnvelope).error.code;

  it("назначение на REGION A: организация в регионе A — 200, контекст A, актор и назначение выставлены", async () => {
    grants = [REGION_ADMIN_A];
    const res = await get(`/t112/orgs/${ORG_A}`, 200);
    expect(res.body).toEqual({
      tenant: { kind: "region", regionId: A },
      user: { id: USER },
      grantId: REGION_ADMIN_A.id,
    });
    // Назначения загружаются один раз на запрос (guard и источник tenant-контекста делят результат).
    expect(grantLoads).toBe(1);
  });

  it("назначение на REGION A: организация в регионе B — 403", async () => {
    grants = [REGION_ADMIN_A];
    expect(code(await get(`/t112/orgs/${ORG_B}`, 403))).toBe("FORBIDDEN");
  });

  it("нет назначения — 403; нет принципала — 401", async () => {
    expect(code(await get(`/t112/orgs/${ORG_A}`, 403))).toBe("FORBIDDEN");
    principal = undefined;
    expect(code(await get(`/t112/orgs/${ORG_A}`, 401))).toBe("UNAUTHENTICATED");
    expect(grantLoads).toBe(1);
  });

  it("объект не найден или id не uuid — 403 (существование не раскрывается)", async () => {
    grants = [REGION_ADMIN_A];
    expect(code(await get(`/t112/orgs/${MISSING}`, 403))).toBe("FORBIDDEN");
    expect(code(await get("/t112/orgs/not-a-uuid", 403))).toBe("FORBIDDEN");
  });

  it("PLATFORM: организации любого региона, контекст PLATFORM", async () => {
    grants = [SUPERUSER];
    expect((await get(`/t112/orgs/${ORG_B}`, 200)).body).toMatchObject({ tenant: { kind: "platform" } });
    expect((await get(`/t112/orgs/${ORG_A}`, 200)).body).toMatchObject({ grantId: SUPERUSER.id });
  });

  it("выбран регион без назначения в нём — 403 и на защищённом, и на открытом эндпоинте (контекст не выдаётся)", async () => {
    principal = { userId: USER, regionId: B };
    grants = [REGION_ADMIN_A];
    expect(code(await get(`/t112/orgs/${ORG_A}`, 403))).toBe("FORBIDDEN");
    expect(code(await get("/t112/open", 403))).toBe("FORBIDDEN");
  });

  it("право на объект не подтверждается в контексте другого региона (PLATFORM выбрал регион A, объект в B)", async () => {
    principal = { userId: USER, regionId: A };
    grants = [SUPERUSER];
    expect(code(await get(`/t112/orgs/${ORG_B}`, 403))).toBe("FORBIDDEN");
    expect((await get(`/t112/orgs/${ORG_A}`, 200)).body).toMatchObject({
      tenant: { kind: "region", regionId: A },
    });
  });

  it("несколько регионов, регион не выбран (без контекста): объект региона — 403, а не ошибка tenant-контекста", async () => {
    grants = [REGION_ADMIN_A, AUDITOR_B];
    expect(code(await get(`/t112/orgs/${ORG_A}`, 403))).toBe("FORBIDDEN");
    principal = { userId: USER, regionId: A };
    expect((await get(`/t112/orgs/${ORG_A}`, 200)).body).toMatchObject({
      tenant: { kind: "region", regionId: A },
    });
  });

  it("назначения PLATFORM и региона без выбора — контекст PLATFORM", async () => {
    grants = [REGION_ADMIN_A, SUPERUSER];
    expect((await get(`/t112/orgs/${ORG_B}`, 200)).body).toMatchObject({ tenant: { kind: "platform" } });
  });

  it("scopeFromTenant: регион-админ A читает tenant-таблицу в транзакции региона A", async () => {
    grants = [REGION_ADMIN_A];
    await get("/t112/region-audit", 200);
    expect(queries.map((q) => q.sql)).toEqual([
      "SELECT set_config('app.region_id', $1, true), set_config('app.actor', $2, true)",
      'select * from "audit_logs" where "audit_logs"."region_id" = $1 order by "created_at" desc, "id" desc limit $2',
    ]);
    expect(queries[0]!.parameters).toEqual([A, ""]);
  });

  it("scopeFromTenant без назначений — 403, в БД ничего не уходит", async () => {
    expect(code(await get("/t112/region-audit", 403))).toBe("FORBIDDEN");
    expect(queries).toEqual([]);
  });

  it("открытый эндпоинт: без принципала — 200, с принципалом — req.user и req.principal выставлены", async () => {
    principal = undefined;
    expect((await get("/t112/open", 200)).body).toEqual({ user: null, principal: null });
    principal = { userId: USER };
    expect((await get("/t112/open", 200)).body).toEqual({ user: { id: USER }, principal: { userId: USER } });
  });
});

/** Декоратор и на классе, и на методе — метод не должен молча переопределять (ослаблять) требование класса. */
@RequirePermission("audit.read", platformScope)
class DoubleRequirement {
  @RequirePermission("organization.edit", platformScope)
  handler() {}
}

/** @RequirePermission с @WithoutTenantContext: право проверилось бы в контексте, а обработчик шёл бы вне его. */
@WithoutTenantContext()
class RequirementWithoutTenant {
  @RequirePermission("audit.read", platformScope)
  handler() {}
}

class RequirementWithoutTenantOnMethod {
  @RequirePermission("audit.read", platformScope)
  @WithoutTenantContext()
  handler() {}
}

describe("PermissionGuard: конфигурация", () => {
  it("@RequirePermission и на классе, и на методе — ошибка конфигурации, до проверки доступа", async () => {
    const context = {
      getHandler: () => DoubleRequirement.prototype.handler,
      getClass: () => DoubleRequirement,
    } as unknown as ExecutionContext;
    const fail = () => {
      throw new Error("не должно вызываться");
    };
    const guard = new PermissionGuard(
      new Reflector(),
      { state: fail, tenant: fail } as unknown as RequestAccess,
      {} as RbacService,
    );
    await expect(guard.canActivate(context)).rejects.toThrow(
      /и на классе DoubleRequirement, и на методе handler/,
    );
  });

  it("@RequirePermission вместе с @WithoutTenantContext (на классе или методе) — ошибка конфигурации", async () => {
    const fail = () => {
      throw new Error("не должно вызываться");
    };
    const guard = new PermissionGuard(
      new Reflector(),
      { state: fail, tenant: fail } as unknown as RequestAccess,
      {} as RbacService,
    );
    for (const cls of [RequirementWithoutTenant, RequirementWithoutTenantOnMethod]) {
      const context = {
        getHandler: () => cls.prototype.handler,
        getClass: () => cls,
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(context)).rejects.toThrow(
        `вместе с @WithoutTenantContext (${cls.name}.handler)`,
      );
    }
  });
});
