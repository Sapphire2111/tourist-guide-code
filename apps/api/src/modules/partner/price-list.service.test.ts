// Unit (без БД): сервис прайса (0030) на репозитории в памяти — право price_list.manage через PartnerService,
// лимиты разделов/позиций (422), версия (409), ▲▼, скрытие, перенос, архив раздела вместе с позициями, AuditLog на
// каждое изменение, архивное место — 409. SQL и RLS — price-list.repository.test.ts и test/integration.
import { describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import {
  regionContext,
  withTenant,
  type Db,
  type PriceListItem,
  type PriceListSection,
} from "../../db/index.js";
import type { AuditService } from "../audit/index.js";
import type { PartnerService, PlaceAccess } from "./partner.service.js";
import { PRICE_LIST_MAX_ITEMS, PRICE_LIST_MAX_SECTIONS } from "./price-list.dto.js";
import type { PriceListRepository } from "./price-list.repository.js";
import { PriceListService } from "./price-list.service.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";
const OWNER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const CASHIER = "0190f5c2-7d3e-7000-8000-0000000000ef";
const meta = { actor: { type: "user" as const, userId: OWNER }, roleAssignmentId: null, requestId: "t" };

function memoryRepo() {
  const sections: PriceListSection[] = [];
  const items: PriceListItem[] = [];
  let n = 0;
  const id = () => `0190f5c2-7d3e-7000-8000-${String(++n).padStart(12, "0")}`;
  const now = new Date("2026-11-05T10:00:00Z");
  const live = <T extends { status: string; place_id: string }>(rows: T[], placeId: string) =>
    rows.filter((r) => r.place_id === placeId && r.status !== "archived");
  const patch = <T extends { id: string; version: number }>(
    rows: T[],
    rowId: string,
    p: Partial<T>,
    expected?: number,
  ) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row || (expected !== undefined && row.version !== expected)) return Promise.resolve(undefined);
    Object.assign(row, p, { version: row.version + 1 });
    return Promise.resolve({ ...row });
  };
  const repo = {
    sections: (placeId: string) => Promise.resolve(live(sections, placeId).map((s) => ({ ...s }))),
    items: (placeId: string) => Promise.resolve(live(items, placeId).map((i) => ({ ...i }))),
    findSection: (placeId: string, sid: string) =>
      Promise.resolve(live(sections, placeId).find((s) => s.id === sid)),
    findItem: (placeId: string, iid: string) =>
      Promise.resolve(live(items, placeId).find((i) => i.id === iid)),
    createSection: (row: Partial<PriceListSection>) => {
      const s = {
        id: id(),
        region_id: REGION,
        status: "active",
        version: 1,
        created_at: now,
        updated_at: now,
        ...row,
      } as PriceListSection;
      sections.push(s);
      return Promise.resolve({ ...s });
    },
    createItem: (row: Partial<PriceListItem>) => {
      const i = {
        id: id(),
        region_id: REGION,
        status: "active",
        version: 1,
        currency: "UAH",
        created_at: now,
        updated_at: now,
        ...row,
        price_minor: String(row.price_minor),
      } as PriceListItem;
      items.push(i);
      return Promise.resolve({ ...i });
    },
    updateSection: (sid: string, p: Partial<PriceListSection>, v?: number) => patch(sections, sid, p, v),
    updateItem: (iid: string, p: Partial<PriceListItem>, v?: number) => patch(items, iid, p, v),
    archiveSectionItems: (placeId: string, sid: string) => {
      const rows = live(items, placeId).filter((i) => i.section_id === sid);
      for (const r of rows) Object.assign(r, { status: "archived", version: r.version + 1 });
      return Promise.resolve(rows.length);
    },
  };
  return { repo: repo as unknown as PriceListRepository, sections, items };
}

function setup(placeStatus = "published") {
  const { db } = recordingDb({});
  const mem = memoryRepo();
  const access: PlaceAccess = {
    placeId: PLACE,
    organizationId: "org",
    regionId: REGION,
    role: "ORG_OWNER",
    grantId: "grant-1",
  };
  const partner = {
    placeAccess: vi.fn((userId: string, _placeId: string, permission: string) => {
      expect(permission).toBe("price_list.manage");
      if (userId === CASHIER)
        return Promise.reject(
          Object.assign(new Error("forbidden"), { status: 403, reason: "role_forbidden" }),
        );
      return Promise.resolve(access);
    }),
    inPlace: <T>(a: PlaceAccess, fn: (place: { status: string }, template: unknown) => Promise<T>) =>
      withTenant(db, regionContext(a.regionId), () => fn({ status: placeStatus }, {})),
  };
  const audit = { record: vi.fn(() => Promise.resolve()) };
  const service = new PriceListService(
    db as unknown as Db,
    mem.repo,
    partner as unknown as PartnerService,
    audit as unknown as AuditService,
  );
  return { service, audit, mem };
}

async function failure(p: Promise<unknown>) {
  const e = (await p.then(
    () => undefined,
    (err: unknown) => err,
  )) as { getStatus?: () => number; messageKey?: string; details?: { reason?: string } } | undefined;
  return { status: e?.getStatus?.(), reason: e?.details?.reason };
}

describe("PriceListService", () => {
  it("раздел → позиции; ответ — прайс целиком по порядку; AuditLog с назначением и регионом", async () => {
    const { service, audit } = setup();
    let list = await service.createSection(OWNER, PLACE, { title: { uk: "  Страви " } }, meta);
    const sectionId = list.sections[0]!.id;
    expect(list.sections[0]!.title).toEqual({ uk: "Страви" });
    list = await service.createItem(
      OWNER,
      PLACE,
      { sectionId, name: { uk: "Банош" }, priceMinor: 18000, unit: { uk: "за порцію" } },
      meta,
    );
    list = await service.createItem(
      OWNER,
      PLACE,
      { sectionId, name: { uk: "Деруни" }, priceMinor: 15000, priceFrom: true },
      meta,
    );
    expect(list.itemCount).toBe(2);
    expect(list.limits).toEqual({ maxItems: PRICE_LIST_MAX_ITEMS, maxSections: PRICE_LIST_MAX_SECTIONS });
    expect(list.sections[0]!.items.map((i) => [i.name.uk, i.priceMinor, i.priceFrom, i.unit])).toEqual([
      ["Банош", 18000, false, { uk: "за порцію" }],
      ["Деруни", 15000, true, null],
    ]);
    expect(audit.record).toHaveBeenCalledTimes(3);
    expect(audit.record.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      expect.objectContaining({
        action: "price_list.section.create",
        entityType: "price_list_section",
        roleAssignmentId: "grant-1",
        regionId: REGION,
      }),
      expect.objectContaining({ action: "price_list.item.create", entityType: "price_list_item" }),
      expect.objectContaining({ action: "price_list.item.create" }),
    ]);
  });

  it("▲▼ позиции внутри раздела; крайняя — без изменений и без аудита", async () => {
    const { service, audit } = setup();
    let list = await service.createSection(OWNER, PLACE, { title: { uk: "Чани" } }, meta);
    const sectionId = list.sections[0]!.id;
    for (const name of ["A", "B", "C"])
      list = await service.createItem(OWNER, PLACE, { sectionId, name: { uk: name }, priceMinor: 100 }, meta);
    const c = list.sections[0]!.items[2]!.id;
    list = await service.moveItem(OWNER, PLACE, c, "up", meta);
    expect(list.sections[0]!.items.map((i) => i.name.uk)).toEqual(["A", "C", "B"]);
    const a = list.sections[0]!.items[0]!.id;
    const calls = audit.record.mock.calls.length;
    list = await service.moveItem(OWNER, PLACE, a, "up", meta);
    expect(list.sections[0]!.items.map((i) => i.name.uk)).toEqual(["A", "C", "B"]);
    expect(audit.record.mock.calls.length).toBe(calls);
  });

  it("версия: устаревшая — 409 version_conflict; скрытие и перенос в другой раздел — в конец", async () => {
    const { service } = setup();
    let list = await service.createSection(OWNER, PLACE, { title: { uk: "Страви" } }, meta);
    list = await service.createSection(OWNER, PLACE, { title: { uk: "Напої" } }, meta);
    const [food, drinks] = list.sections.map((s) => s.id);
    list = await service.createItem(
      OWNER,
      PLACE,
      { sectionId: drinks!, name: { uk: "Чай" }, priceMinor: 40 },
      meta,
    );
    list = await service.createItem(
      OWNER,
      PLACE,
      { sectionId: food!, name: { uk: "Суп" }, priceMinor: 90 },
      meta,
    );
    const soup = list.sections[0]!.items[0]!;
    list = await service.updateItem(OWNER, PLACE, soup.id, { hidden: true, version: soup.version }, meta);
    const hidden = list.sections[0]!.items[0]!;
    expect(hidden).toMatchObject({ hidden: true, version: soup.version + 1 });
    expect(
      await failure(
        service.updateItem(OWNER, PLACE, soup.id, { priceMinor: 1, version: soup.version }, meta),
      ),
    ).toEqual({ status: 409, reason: "version_conflict" });
    list = await service.updateItem(OWNER, PLACE, soup.id, { sectionId: drinks! }, meta);
    expect(list.sections[0]!.items).toEqual([]);
    expect(list.sections[1]!.items.map((i) => i.name.uk)).toEqual(["Чай", "Суп"]);
  });

  it("архив раздела — вместе с позициями; повтор — 404", async () => {
    const { service, audit } = setup();
    let list = await service.createSection(OWNER, PLACE, { title: { uk: "Номери" } }, meta);
    const sectionId = list.sections[0]!.id;
    list = await service.createItem(
      OWNER,
      PLACE,
      { sectionId, name: { uk: "Люкс" }, priceMinor: 250000 },
      meta,
    );
    list = await service.archiveSection(OWNER, PLACE, sectionId, meta);
    expect(list).toMatchObject({ sections: [], itemCount: 0 });
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "price_list.section.archive",
        newValues: { status: "archived", archivedItems: 1 },
      }),
    );
    expect(await failure(service.archiveSection(OWNER, PLACE, sectionId, meta))).toMatchObject({
      status: 404,
    });
  });

  it("лимиты: разделов и позиций на место — 422", async () => {
    const { service, mem } = setup();
    for (let i = 0; i < PRICE_LIST_MAX_SECTIONS; i++)
      await service.createSection(OWNER, PLACE, { title: { uk: `Р${i}` } }, meta);
    expect(await failure(service.createSection(OWNER, PLACE, { title: { uk: "ще" } }, meta))).toEqual({
      status: 422,
      reason: "too_many_sections",
    });
    const sectionId = mem.sections[0]!.id;
    for (let i = 0; i < PRICE_LIST_MAX_ITEMS; i++)
      mem.items.push({
        ...mem.sections[0]!,
        id: `item-${i}`,
        section_id: sectionId,
        name_i18n: { uk: `П${i}` },
        description_i18n: null,
        price_minor: "1",
        currency: "UAH",
        price_from: false,
        unit_i18n: null,
      } as unknown as PriceListItem);
    expect(
      await failure(service.createItem(OWNER, PLACE, { sectionId, name: { uk: "x" }, priceMinor: 1 }, meta)),
    ).toEqual({ status: 422, reason: "too_many_items" });
  });

  it("кассир — отказ PartnerService (403) до транзакции; архивное место — 409", async () => {
    const { service, audit } = setup();
    await expect(service.get(CASHIER, PLACE)).rejects.toMatchObject({ status: 403 });
    const archived = setup("archived");
    expect(
      await failure(archived.service.createSection(OWNER, PLACE, { title: { uk: "Страви" } }, meta)),
    ).toEqual({ status: 409, reason: "not_editable" });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
