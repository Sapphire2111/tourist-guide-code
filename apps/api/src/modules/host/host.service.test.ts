// Unit (без БД): правила HostService (ADR-0020) — комната из QR номера против введённой гостем (D-49), приём вне
// часов (D-55), дубль открытой заявки → 409, переходы персонала (чужой отель — 404, недопустимый — 409, rejected
// без причины — 400), история и аудит каждого перехода, уведомления персоналу. Репозиторий подменён, транзакция —
// recordingDb; на реальной БД с RLS — test/integration/host.test.ts.
import { describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import type { HostModule, ServiceRequest } from "../../db/index.js";
import type { ApiError } from "../../common/http/index.js";
import { regionContext, withTenant } from "../../db/index.js";
import type { AuditService } from "../audit/index.js";
import type { Grant, RbacService } from "../rbac/index.js";
import type { RegionsRepository } from "../regions/index.js";
import type { RoleAssignmentService } from "../role-assignments/index.js";
import type { HostRepository } from "./host.repository.js";
import { HostService } from "./host.service.js";
import type { NotificationsService } from "./notifications.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";
const OTHER_PLACE = "0190f5c2-7d3e-7000-8000-0000000000b2";
const REQ = "0190f5c2-7d3e-7000-8000-0000000000c1";
const ENTRY = "0190f5c2-7d3e-7000-8000-0000000000d1";
const GUEST = "0190f5c2-7d3e-7000-8000-0000000000e1";
const STAFF = "0190f5c2-7d3e-7000-8000-0000000000e2";

const module: HostModule = {
  id: "0190f5c2-7d3e-7000-8000-0000000000f1",
  region_id: REGION,
  place_id: PLACE,
  enabled: true,
  wifi_ssid: "Hotel",
  wifi_password: "secret",
  reception_phone: null,
  hours_from: "08:00:00",
  hours_to: "22:00:00",
  sections: [],
  services: [
    {
      code: "towels",
      title: { uk: "Рушники" },
      description: null,
      slaMinutes: 30,
      enabled: true,
      sortOrder: 0,
    },
    { code: "spa", title: { uk: "СПА" }, description: null, slaMinutes: 60, enabled: false, sortOrder: 1 },
  ],
  updated_by: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const request = (over: Partial<ServiceRequest> = {}): ServiceRequest => ({
  id: REQ,
  region_id: REGION,
  place_id: PLACE,
  user_id: GUEST,
  entry_context_id: null,
  service_code: "towels",
  service_title_i18n: { uk: "Рушники" },
  room_label: "204",
  room_source: "qr",
  comment: null,
  status: "new",
  status_reason: null,
  outside_hours: false,
  process_from: null,
  sla_minutes: 30,
  sla_due_at: null,
  assigned_to: null,
  accepted_at: null,
  started_at: null,
  closed_at: null,
  anonymized_at: null,
  created_at: new Date("2026-11-02T10:00:00Z"),
  updated_at: new Date("2026-11-02T10:00:00Z"),
  ...over,
});

const staffGrant = (place: string): Grant => ({
  id: `0190f5c2-7d3e-7000-8000-0000000000${place === PLACE ? "a1" : "a2"}`,
  role: "ORG_STAFF",
  scopeType: "PLACE",
  scopeId: place,
  regionId: REGION,
  validUntil: null,
});

function setup(repoOver: Partial<Record<keyof HostRepository, unknown>> = {}, grants: Grant[] = []) {
  const { db } = recordingDb({});
  const repo = {
    findPlace: vi.fn(() =>
      Promise.resolve({ id: PLACE, region_id: REGION, name_i18n: { uk: "Готель" }, status: "published" }),
    ),
    findModule: vi.fn(() => Promise.resolve(module)),
    entryRoom: vi.fn(() => Promise.resolve(undefined)),
    findActiveDuplicate: vi.fn(() => Promise.resolve(undefined)),
    insertRequest: vi.fn((row: Partial<ServiceRequest>) => Promise.resolve(request(row))),
    insertEvent: vi.fn(() => Promise.resolve()),
    staffOf: vi.fn(() => Promise.resolve([{ user_id: STAFF }])),
    placeNames: vi.fn(() => Promise.resolve(new Map([[PLACE, { uk: "Готель" }]]))),
    events: vi.fn(() => Promise.resolve(new Map())),
    guestNames: vi.fn(() => Promise.resolve(new Map())),
    findRequest: vi.fn(() => Promise.resolve(request())),
    updateStatus: vi.fn((_id: string, _from: string, patch: Partial<ServiceRequest>) =>
      Promise.resolve(request(patch)),
    ),
    ...repoOver,
  };
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const notifications = {
    enqueue: vi.fn(() => Promise.resolve(["n1"])),
    dispatchInBackground: vi.fn(),
  };
  const service = new HostService(
    db,
    repo as unknown as HostRepository,
    {
      findById: (id: string) => Promise.resolve({ id, status: "active", timezone: "Europe/Kyiv" }),
    } as unknown as RegionsRepository,
    { grantsOf: () => Promise.resolve(grants) } as unknown as RbacService,
    audit as unknown as AuditService,
    notifications as unknown as NotificationsService,
    {} as RoleAssignmentService,
  );
  // 12:00 Киева — часы приёма.
  service.now = () => new Date("2026-11-02T10:00:00Z");
  return { service, repo, audit, notifications };
}

const meta = { actor: { type: "user" as const, userId: STAFF } };
const create = { regionId: REGION, placeId: PLACE, serviceCode: "towels" };

describe("HostService.createRequest", () => {
  it("комната QR номера (контекст этого места) важнее введённой гостем; уведомление персоналу", async () => {
    const { service, repo, notifications } = setup({
      entryRoom: vi.fn(() => Promise.resolve({ room_label: "204", user_id: GUEST })),
    });
    await service.createRequest(GUEST, { ...create, entryContextId: ENTRY, roomLabel: "999" });
    expect(repo.insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        room_label: "204",
        room_source: "qr",
        entry_context_id: ENTRY,
        outside_hours: false,
      }),
    );
    expect(repo.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ from_status: null, to_status: "new", actor_type: "guest" }),
    );
    expect(notifications.enqueue).toHaveBeenCalledWith([
      expect.objectContaining({ recipientUserId: STAFF, template: "service_request.created", entityId: REQ }),
    ]);
    expect(notifications.dispatchInBackground).toHaveBeenCalledWith(REGION, ["n1"]);
  });

  it("общий QR: комната гостя с пометкой guest; контекст другого места не используется", async () => {
    const { service, repo } = setup({
      entryRoom: vi.fn(() => Promise.resolve(undefined)),
    });
    await service.createRequest(GUEST, { ...create, entryContextId: ENTRY, roomLabel: " 305 " });
    expect(repo.insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({ room_label: "305", room_source: "guest", entry_context_id: null }),
    );
  });

  it("вне часов приёма — принимается с outside_hours, SLA от открытия (D-55)", async () => {
    const { service, repo } = setup();
    // 23:30 Киева.
    service.now = () => new Date("2026-11-02T21:30:00Z");
    await service.createRequest(GUEST, create);
    expect(repo.insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        outside_hours: true,
        process_from: new Date("2026-11-03T06:00:00Z"),
        sla_due_at: new Date("2026-11-03T06:30:00Z"),
      }),
    );
  });

  it("выключенная/неизвестная услуга и неопубликованное место — 404; дубль — 409 с existingId", async () => {
    const { service } = setup();
    await expect(service.createRequest(GUEST, { ...create, serviceCode: "spa" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const draft = setup({
      findPlace: vi.fn(() =>
        Promise.resolve({ id: PLACE, region_id: REGION, name_i18n: { uk: "" }, status: "draft" }),
      ),
    });
    await expect(draft.service.createRequest(GUEST, create)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const dup = setup({ findActiveDuplicate: vi.fn(() => Promise.resolve(request())) });
    const err = (await dup.service.createRequest(GUEST, create).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({ reason: "duplicate_request", existingId: REQ });
    expect(dup.repo.insertRequest).not.toHaveBeenCalled();
  });
});

describe("HostService.staffUpdate", () => {
  it("не персонал — 403; заявка другого отеля (в регионе сотрудника) — 404", async () => {
    await expect(setup().service.staffUpdate(STAFF, REQ, { status: "accepted" }, meta)).rejects.toMatchObject(
      {
        code: "FORBIDDEN",
      },
    );
    const other = setup({}, [staffGrant(OTHER_PLACE)]);
    await expect(other.service.staffUpdate(STAFF, REQ, { status: "accepted" }, meta)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(other.repo.updateStatus).not.toHaveBeenCalled();
  });

  it("допустимый переход: история, AuditLog с назначением сотрудника, уведомление гостю", async () => {
    const { service, repo, audit, notifications } = setup({}, [staffGrant(PLACE)]);
    const dto = await service.staffUpdate(STAFF, REQ, { status: "accepted" }, meta);
    expect(dto.status).toBe("accepted");
    expect(dto.allowedTransitions).toEqual(["in_progress", "rejected"]);
    expect(repo.updateStatus).toHaveBeenCalledWith(
      REQ,
      "new",
      expect.objectContaining({ status: "accepted", assigned_to: STAFF }),
    );
    expect(repo.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        from_status: "new",
        to_status: "accepted",
        actor_type: "staff",
        actor_user_id: STAFF,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "service_request.status",
        entityId: REQ,
        oldValues: { status: "new" },
        roleAssignmentId: staffGrant(PLACE).id,
      }),
    );
    expect(notifications.enqueue).toHaveBeenCalledWith([expect.objectContaining({ recipientUserId: GUEST })]);
  });

  it("недопустимый переход — 409 (new → done); гонка (статус уже другой) — 409; rejected без причины — 400", async () => {
    const s = setup({}, [staffGrant(PLACE)]);
    const err = (await s.service
      .staffUpdate(STAFF, REQ, { status: "done" }, meta)
      .catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({ reason: "invalid_transition", from: "new", to: "done" });
    const race = setup({ updateStatus: vi.fn(() => Promise.resolve(undefined)) }, [staffGrant(PLACE)]);
    await expect(race.service.staffUpdate(STAFF, REQ, { status: "accepted" }, meta)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(race.repo.insertEvent).not.toHaveBeenCalled();
    await expect(s.service.staffUpdate(STAFF, REQ, { status: "rejected" }, meta)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

describe("HostService.cancel (гость)", () => {
  it("чужая заявка — 404; в работе — 409; new — cancelled_by_guest с историей", async () => {
    const guestMeta = { actor: { type: "user" as const, userId: GUEST } };
    await expect(setup().service.cancel(REGION, STAFF, REQ, guestMeta)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const busy = setup({ findRequest: vi.fn(() => Promise.resolve(request({ status: "in_progress" }))) });
    await expect(busy.service.cancel(REGION, GUEST, REQ, guestMeta)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const ok = setup();
    const dto = await ok.service.cancel(REGION, GUEST, REQ, guestMeta);
    expect(dto.status).toBe("cancelled_by_guest");
    expect(ok.repo.insertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ to_status: "cancelled_by_guest", actor_type: "guest" }),
    );
  });
});

describe("HostService.guestModule", () => {
  it("пароль Wi-Fi и номер комнаты — только с контекстом QR этого места; выключенные услуги скрыты", async () => {
    const plain = await setup().service.guestModule(REGION, PLACE);
    expect(plain.wifi).toEqual({ ssid: "Hotel", password: null });
    expect(plain.room).toBeNull();
    expect(plain.services.map((s) => s.code)).toEqual(["towels"]);
    expect(plain.acceptingNow).toBe(true);
    const viaQr = await setup({
      entryRoom: vi.fn(() => Promise.resolve({ room_label: "204", user_id: GUEST })),
    }).service.guestModule(REGION, PLACE, ENTRY);
    expect(viaQr.wifi?.password).toBe("secret");
    expect(viaQr.room).toEqual({ label: "204", source: "qr" });
  });
});

describe("правки по проверке", () => {
  it("контекст входа другого пользователя не даёт пароль Wi-Fi и номер комнаты; анонимный контекст — даёт", async () => {
    const foreign = setup({
      entryRoom: vi.fn(() => Promise.resolve({ room_label: "204", user_id: STAFF })),
    });
    const other = await foreign.service.guestModule(REGION, PLACE, ENTRY, GUEST);
    expect(other.wifi?.password).toBeNull();
    expect(other.room).toBeNull();
    await foreign.service.createRequest(GUEST, { ...create, entryContextId: ENTRY, roomLabel: "305" });
    expect(foreign.repo.insertRequest).toHaveBeenCalledWith(
      expect.objectContaining({ room_label: "305", room_source: "guest", entry_context_id: null }),
    );
    const anon = setup({ entryRoom: vi.fn(() => Promise.resolve({ room_label: "204", user_id: null })) });
    expect((await anon.service.guestModule(REGION, PLACE, ENTRY, GUEST)).room).toEqual({
      label: "204",
      source: "qr",
    });
  });

  it("дубль — по ключу уникального индекса (гость, место, услуга), без номера комнаты", async () => {
    const { service, repo } = setup();
    await service.createRequest(GUEST, { ...create, roomLabel: "204" });
    expect(repo.findActiveDuplicate).toHaveBeenCalledWith(PLACE, "towels", GUEST);
  });

  it("гонка: 409 отдаёт текущий статус заявки", async () => {
    const findRequest = vi
      .fn()
      .mockResolvedValueOnce(request())
      .mockResolvedValueOnce(request({ status: "accepted" }));
    const { service } = setup({ findRequest, updateStatus: vi.fn(() => Promise.resolve(undefined)) }, [
      staffGrant(PLACE),
    ]);
    const err = (await service
      .staffUpdate(STAFF, REQ, { status: "accepted" }, meta)
      .catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({ currentStatus: "accepted", to: "accepted" });
  });

  it("админка: без контекста региона (SUPERADMIN) — 403; часы с одинаковыми началом и концом — 422", async () => {
    const { service } = setup();
    const put = { sections: [], services: [], hours: { from: "08:00", to: "08:00" } };
    await expect(service.adminPutModule(PLACE, put, meta)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { reason: "region_context_required" },
    });
    await expect(service.adminAssignStaff(PLACE, { telegramUserId: "1" }, meta)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const { db } = recordingDb({});
    await expect(
      withTenant(db, regionContext(REGION), () => service.adminPutModule(PLACE, put, meta)),
    ).rejects.toMatchObject({ code: "UNPROCESSABLE", details: { reason: "hours_empty" } });
  });
});
