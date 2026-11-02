// Unit (без БД): экстренные контакты — админка /admin/emergency-contacts (право emergency_contact.manage, изоляция
// региона: чужой контакт — 404, в SQL — фильтр region_id контекста; аудит изменений) и публичный
// GET /regions/{id}/emergency-contacts (без сессии, только active, по порядку; неактивный/неизвестный регион — 404).
// Таблица — в памяти по SQL (sql-table-fake); RLS и гранты — test/integration/admin-core.test.ts.
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { ErrorEnvelope } from "@tg/shared";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { SqlTableFake } from "../../../test/support/sql-table-fake.js";
import { configureApp } from "../../bootstrap/configure-app.js";
import { TenancyModule } from "../../common/tenancy/index.js";
import { DATABASE, DatabaseModule } from "../../db/index.js";
import {
  PRINCIPAL_SOURCE,
  RbacModule,
  RbacTenantContextSource,
  RoleAssignmentsRepository,
  type Grant,
} from "../rbac/index.js";
import { RegionsRepository } from "../regions/index.js";
import { EmergencyContactsModule } from "./emergency-contacts.module.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const SUSPENDED = "0190f5c2-7d3e-7000-8000-00000000000c";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const grant = (role: string, regionId: string | null): Grant => ({
  id: "0190f5c2-7d3e-7000-8000-0000000001aa",
  role,
  scopeType: regionId ? "REGION" : "PLATFORM",
  scopeId: regionId,
  regionId,
  validUntil: null,
});

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const contact = (regionId: string, n: number, extra: Record<string, unknown> = {}) => ({
  region_id: regionId,
  kind: "police",
  name_i18n: { uk: `Контакт ${n}` },
  phone: "102",
  description_i18n: null,
  sort_order: n,
  active: true,
  created_at: new Date(),
  updated_at: new Date(),
  ...extra,
});

async function start(opts: { grants?: Grant[]; authenticated?: boolean } = {}) {
  const fake = new SqlTableFake({
    table: "emergency_contacts",
    defaults: () => ({ description_i18n: null, sort_order: 0, active: true }),
  });
  const { db } = recordingDb({}, fake.respond);
  const moduleRef = await Test.createTestingModule({
    imports: [
      DatabaseModule.forRoot({ connectionString: "postgres://u:p@127.0.0.1:1/db" }),
      TenancyModule.forRoot({ source: RbacTenantContextSource, imports: [RbacModule] }),
      EmergencyContactsModule,
    ],
  })
    .overrideProvider(DATABASE)
    .useValue(db)
    .overrideProvider(PRINCIPAL_SOURCE)
    .useValue({ resolve: () => (opts.authenticated === false ? undefined : { userId: USER }) })
    .overrideProvider(RoleAssignmentsRepository)
    .useValue({ activeGrantsOf: () => Promise.resolve(opts.grants ?? [grant("REGION_ADMIN", A)]) })
    .overrideProvider(RegionsRepository)
    .useValue({
      findById: (id: string) =>
        Promise.resolve(
          id === A || id === B
            ? { id, status: "active" }
            : id === SUSPENDED
              ? { id, status: "suspended" }
              : undefined,
        ),
    })
    .compile();
  app = configureApp(moduleRef.createNestApplication({ logger: false }), { appEnv: "local" });
  await app.init();
  return { http: () => request(app!.getHttpServer()), fake };
}

type Contact = { id: string; regionId: string; phone: string; sortOrder: number; active: boolean };

describe("/admin/emergency-contacts", () => {
  it("без сессии — 401; MODERATOR — 403", async () => {
    let s = await start({ authenticated: false });
    await s.http().get("/admin/emergency-contacts").expect(401);
    await app!.close();
    s = await start({ grants: [grant("MODERATOR", A)] });
    const res = await s.http().get("/admin/emergency-contacts").expect(403);
    expect((res.body as ErrorEnvelope).error.code).toBe("FORBIDDEN");
    expect(s.fake.tableQueries()).toEqual([]);
  });

  it("CRUD в своём регионе с аудитом; телефон E.164 или короткий номер; неверный — 400", async () => {
    const { http, fake } = await start();
    const created = (
      await http()
        .post("/admin/emergency-contacts")
        .send({ kind: "general", name: { uk: "Єдиний номер", en: "Emergency" }, phone: "112", sortOrder: 1 })
        .expect(201)
    ).body as Contact;
    expect(created).toMatchObject({ regionId: A, phone: "112", sortOrder: 1, active: true });
    expect(fake.audit.at(-1)).toMatchObject({ action: "emergency_contact.create", region_id: A });
    for (const phone of ["+380", "1", "+0501234567", "1234567", "112 "])
      await http()
        .post("/admin/emergency-contacts")
        .send({ kind: "police", name: { uk: "П" }, phone })
        .expect(400);
    await http()
      .post("/admin/emergency-contacts")
      .send({ kind: "fire", name: { uk: "П" }, phone: "101" })
      .expect(400);

    const patched = (
      await http()
        .patch(`/admin/emergency-contacts/${created.id}`)
        .send({ phone: "+380501234567", active: false, description: { uk: "Опис" } })
        .expect(200)
    ).body as Contact;
    expect(patched).toMatchObject({ phone: "+380501234567", active: false });
    expect(fake.audit.at(-1)).toMatchObject({
      action: "emergency_contact.update",
      old_values: { phone: "112", active: true, description: null },
    });
    expect((await http().get(`/admin/emergency-contacts/${created.id}`).expect(200)).body).toMatchObject({
      id: created.id,
    });
    const list = (await http().get("/admin/emergency-contacts").query({ active: "false" }).expect(200))
      .body as { items: Contact[] };
    expect(list.items.map((c) => c.id)).toEqual([created.id]);
    await http().delete(`/admin/emergency-contacts/${created.id}`).expect(204);
    expect(fake.audit.at(-1)).toMatchObject({ action: "emergency_contact.delete", new_values: null });
    await http().delete(`/admin/emergency-contacts/${created.id}`).expect(404);
  });

  it("изоляция: контакт региона Б админу A не виден — список пуст, чтение/правка/удаление — 404", async () => {
    const { http, fake } = await start();
    const b = fake.put(contact(B, 1));
    expect(
      ((await http().get("/admin/emergency-contacts").expect(200)).body as { items: unknown[] }).items,
    ).toEqual([]);
    await http()
      .get(`/admin/emergency-contacts/${b.id as string}`)
      .expect(404);
    await http()
      .patch(`/admin/emergency-contacts/${b.id as string}`)
      .send({ phone: "101" })
      .expect(404);
    await http()
      .delete(`/admin/emergency-contacts/${b.id as string}`)
      .expect(404);
    expect(fake.rows.get(b.id as string)).toMatchObject({ phone: "102" });
    for (const q of fake.tableQueries()) {
      expect(q.sql, q.sql).toContain('"emergency_contacts"."region_id" = $');
      expect(q.parameters, q.sql).toContain(A);
    }
    expect(fake.audit).toEqual([]);
  });

  it("SUPERADMIN без выбранного региона: создание — 403 region_context_required", async () => {
    const { http } = await start({ grants: [grant("SUPERADMIN", null)] });
    const res = await http()
      .post("/admin/emergency-contacts")
      .send({ kind: "police", name: { uk: "П" }, phone: "102" })
      .expect(403);
    expect((res.body as ErrorEnvelope).error.details).toEqual({ reason: "region_context_required" });
  });
});

describe("GET /regions/{regionId}/emergency-contacts (публичный, «Халепа?»)", () => {
  it("без сессии: только активные контакты региона, по порядку; без служебных полей", async () => {
    const { http, fake } = await start({ authenticated: false });
    const second = fake.put(contact(A, 20, { kind: "ambulance", phone: "103" }));
    const first = fake.put(contact(A, 10, { kind: "general", phone: "112" }));
    fake.put(contact(A, 5, { active: false }));
    fake.put(contact(B, 1));
    const res = await http().get(`/regions/${A}/emergency-contacts`).expect(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    const items = (res.body as { items: Record<string, unknown>[] }).items;
    expect(items.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(Object.keys(items[0]!).sort()).toEqual([
      "description",
      "id",
      "kind",
      "name",
      "phone",
      "sortOrder",
    ]);
    for (const q of fake.tableQueries()) expect(q.parameters).toContain(A);
  });

  it("неизвестный или неактивный регион — 404, неверный id — 400", async () => {
    const { http, fake } = await start({ authenticated: false });
    fake.put(contact(SUSPENDED, 1));
    await http().get(`/regions/${SUSPENDED}/emergency-contacts`).expect(404);
    await http().get(`/regions/${USER}/emergency-contacts`).expect(404);
    await http().get("/regions/abc/emergency-contacts").expect(400);
    expect(fake.tableQueries()).toEqual([]);
  });
});
