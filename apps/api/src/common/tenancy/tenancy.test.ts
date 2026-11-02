// Unit (без БД): tenant-контекст HTTP-запроса доходит до SQL. Регион-админ A запрашивает запись по id и
// список — в БД уходят только запросы с фильтром региона A (ТЗ §16.2; на реальной БД с RLS и записями
// региона B — test/integration/tenancy.test.ts).
import { Controller, Get, Inject, NotFoundException, Param, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import {
  currentTenant,
  DATABASE,
  DatabaseModule,
  regionContext,
  type TenantContext,
} from "../../db/index.js";
import { AuditLogRepository, AuditModule } from "../../modules/audit/index.js";
import {
  TenancyModule,
  TENANT_CONTEXT_SOURCE,
  WithoutTenantContext,
  type TenantContextSource,
} from "./index.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";

@Controller("t110/audit-logs")
class ProbeController {
  constructor(@Inject(AuditLogRepository) private readonly audit: AuditLogRepository) {}

  @Get()
  list() {
    return this.audit.listRecent();
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const row = await this.audit.findById(id);
    if (!row) throw new NotFoundException();
    return row;
  }
}

/** @WithoutTenantContext (T1-26): источник не вызывается, транзакции нет. */
@Controller("t110/no-tenant")
@WithoutTenantContext()
class NoTenantController {
  @Get()
  get() {
    return { tenant: currentTenant() ?? null };
  }
}

describe("TenantContextInterceptor", () => {
  const { db, queries } = recordingDb();
  let tenant: TenantContext | undefined;
  let resolved = 0;
  const source: TenantContextSource = {
    resolve: () => {
      resolved++;
      return tenant;
    },
  };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
        TenancyModule,
        AuditModule,
      ],
      controllers: [ProbeController, NoTenantController],
    })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(TENANT_CONTEXT_SOURCE)
      .useValue(source)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    queries.length = 0;
    resolved = 0;
  });

  it("регион-админ A: запись по id → 404, список → 0 записей; SQL — только с регионом A", async () => {
    tenant = regionContext(A);
    await request(app.getHttpServer())
      .get("/t110/audit-logs/0190f5c2-7d3e-7000-8000-0000000000bb")
      .expect(404);
    const list = await request(app.getHttpServer()).get("/t110/audit-logs").expect(200);
    expect(list.body).toEqual([]);

    // На каждый запрос: set_config в начале транзакции, затем запрос с фильтром региона.
    expect(queries.map((q) => q.sql)).toEqual([
      "SELECT set_config('app.region_id', $1, true), set_config('app.actor', $2, true)",
      'select * from "audit_logs" where ("id" = $1) and "audit_logs"."region_id" = $2',
      "SELECT set_config('app.region_id', $1, true), set_config('app.actor', $2, true)",
      'select * from "audit_logs" where "audit_logs"."region_id" = $1 order by "created_at" desc, "id" desc limit $2',
    ]);
    expect(queries[0]?.parameters).toEqual([A, ""]);
    expect(queries[1]?.parameters).toEqual(["0190f5c2-7d3e-7000-8000-0000000000bb", A]);
  });

  it("без tenant-контекста запрос к tenant-таблице не выполняется (ошибка), в БД ничего не уходит", async () => {
    tenant = undefined;
    await request(app.getHttpServer()).get("/t110/audit-logs").expect(500);
    expect(queries).toEqual([]);
  });

  it("@WithoutTenantContext: источник не вызывается, обработчик вне транзакции", async () => {
    tenant = regionContext(A);
    const res = await request(app.getHttpServer()).get("/t110/no-tenant").expect(200);
    expect(res.body).toEqual({ tenant: null });
    expect(resolved).toBe(0);
    expect(queries).toEqual([]);
  });
});
