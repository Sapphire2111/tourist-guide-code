// Unit (без БД): правила сервиса гида (блок 4, ADR-0019) — граница листания поиска (SEARCH_OFFSET_MAX) и лимит
// избранного (FAVORITES_MAX → 409). Репозиторий подменён; транзакция региона — на recordingDb.
import { describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import type { EmergencyContactsRepository } from "../emergency-contacts/index.js";
import type { MediaService } from "../media/index.js";
import type { RegionsRepository } from "../regions/index.js";
import { SEARCH_OFFSET_MAX } from "./guide.dto.js";
import { FAVORITES_MAX, type GuideRepository, type PlaceRow } from "./guide.repository.js";
import { GuideService } from "./guide.service.js";

const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const PLACE = "0190f5c2-7d3e-7000-8000-0000000000b1";

const row = (n: number): PlaceRow => ({
  id: `0190f5c2-7d3e-7000-8000-${String(n).padStart(12, "0")}`,
  category_id: PLACE,
  name_i18n: { uk: `Місце ${n}` },
  address_i18n: null,
  phone: null,
  recommended: false,
  location: { lon: 24, lat: 48 },
  distance: null,
  google_place_id: null,
  partner: false,
});

function service(repo: Partial<GuideRepository>) {
  const { db } = recordingDb({});
  const base: Partial<GuideRepository> = {
    covers: () => Promise.resolve([]),
    coverMeta: () => Promise.resolve([]),
    adLabels: () => Promise.resolve(new Map()),
    placeIdsWithOffer: () => Promise.resolve(new Set()),
    offers: () => Promise.resolve([]),
    schedules: () => Promise.resolve(new Map()),
  };
  return new GuideService(
    db,
    { ...base, ...repo } as GuideRepository,
    {
      findById: (id: string) => Promise.resolve({ id, status: "active", timezone: "Europe/Kyiv" }),
    } as unknown as RegionsRepository,
    {} as EmergencyContactsRepository,
    { links: () => Promise.resolve([]) } as unknown as MediaService,
  );
}

describe("GuideService.search — nextOffset", () => {
  const search = (offset: number, limit: number) =>
    service({ search: () => Promise.resolve(Array.from({ length: limit + 1 }, (_, i) => row(i))) }).search(
      REGION,
      { limit, offset },
    );

  it("есть ещё строки — следующий offset, пока он допустим валидацией", async () => {
    expect((await search(0, 20)).nextOffset).toBe(20);
    expect((await search(SEARCH_OFFSET_MAX - 20, 20)).nextOffset).toBe(SEARCH_OFFSET_MAX);
  });

  it("следующий offset за SEARCH_OFFSET_MAX — null (клиент получил бы 400)", async () => {
    expect((await search(SEARCH_OFFSET_MAX - 19, 20)).nextOffset).toBeNull();
    expect((await search(SEARCH_OFFSET_MAX, 50)).nextOffset).toBeNull();
  });
});

describe("GuideService.addFavorite — лимит", () => {
  const published = () => Promise.resolve({ ...row(1), region_id: REGION } as never);
  const add = (count: number, already: boolean) =>
    service({
      findPublished: published,
      isFavorite: () => Promise.resolve(already),
      countFavorites: () => Promise.resolve(count),
      addFavorite: () => Promise.resolve({ place_id: PLACE, created_at: new Date("2026-11-02T10:00:00Z") }),
    }).addFavorite(REGION, USER, PLACE);

  it(`${FAVORITES_MAX} мест — новое отклоняется 409 errors.favorites.limitReached`, async () => {
    await expect(add(FAVORITES_MAX, false)).rejects.toMatchObject({
      code: "CONFLICT",
      messageKey: "errors.favorites.limitReached",
    });
  });

  it("ниже лимита — добавляется; повтор уже добавленного при полном списке — без ошибки", async () => {
    expect(await add(FAVORITES_MAX - 1, false)).toEqual({
      placeId: PLACE,
      createdAt: "2026-11-02T10:00:00.000Z",
    });
    expect(await add(FAVORITES_MAX, true)).toMatchObject({ placeId: PLACE });
  });
});

describe("GuideService.localities", () => {
  it("синонимы по коду (Буковель → Поляниця), число мест; без мест — 0", async () => {
    const L = "0190f5c2-7d3e-7000-8000-0000000000c1";
    const res = await service({
      activeLocalities: () =>
        Promise.resolve([
          {
            id: L,
            code: "polianytsia",
            name_i18n: { uk: "Поляниця" },
            sort_order: 1,
            location: { lon: 24.41, lat: 48.36 },
          },
          {
            id: PLACE,
            code: "new-one",
            name_i18n: { uk: "Нове" },
            sort_order: 2,
            location: { lon: 24, lat: 48 },
          },
        ]),
      publishedCountByLocality: () => Promise.resolve(new Map([[L, 7]])),
    }).localities(REGION);
    expect(res.items[0]).toMatchObject({ id: L, placeCount: 7, location: { lon: 24.41, lat: 48.36 } });
    expect(res.items[0]!.aliases).toContain("Буковель");
    expect(res.items[1]).toMatchObject({ aliases: [], placeCount: 0 });
  });
});

describe("GuideService — акции партнёра", () => {
  it("выдача: hasOffer только у мест с действующей акцией", async () => {
    const res = await service({
      search: () => Promise.resolve([row(1), row(2)]),
      placeIdsWithOffer: () => Promise.resolve(new Set([row(2).id])),
    }).search(REGION, { limit: 20, offset: 0 });
    expect(res.items.map((i) => i.hasOffer)).toEqual([false, true]);
  });

  it("карточка: offers в DTO (даты ISO), hasOffer; без акций — пусто и false", async () => {
    const card = (offers: unknown[]) =>
      service({
        findPublished: () => Promise.resolve({ ...row(1), region_id: REGION } as never),
        findCategory: () => Promise.resolve(undefined),
        placeTags: () => Promise.resolve([]),
        photos: () => Promise.resolve([]),
        enrichment: () => Promise.resolve(undefined),
        isFavorite: () => Promise.resolve(false),
        offers: () => Promise.resolve(offers as never),
      }).place(REGION, row(1).id, {});
    const withOffer = await card([
      {
        id: PLACE,
        title_i18n: { uk: "-10%" },
        description_i18n: null,
        starts_at: null,
        ends_at: new Date("2026-11-12T20:59:59Z"),
      },
    ]);
    expect(withOffer).toMatchObject({
      hasOffer: true,
      offers: [{ id: PLACE, title: { uk: "-10%" }, startsAt: null, endsAt: "2026-11-12T20:59:59.000Z" }],
    });
    expect(await card([])).toMatchObject({ hasOffer: false, offers: [] });
  });
});

describe("GuideService — «Партнер гіда»", () => {
  it("выдача и карточка: partner из строки выборки, без доп. запросов", async () => {
    const res = await service({
      search: () => Promise.resolve([row(1), { ...row(2), partner: true }]),
    }).search(REGION, { limit: 20, offset: 0 });
    expect(res.items.map((i) => i.partner)).toEqual([false, true]);
    const card = await service({
      findPublished: () => Promise.resolve({ ...row(1), partner: true, region_id: REGION } as never),
      findCategory: () => Promise.resolve(undefined),
      placeTags: () => Promise.resolve([]),
      photos: () => Promise.resolve([]),
      enrichment: () => Promise.resolve(undefined),
      isFavorite: () => Promise.resolve(false),
    }).place(REGION, row(1).id, {});
    expect(card?.partner).toBe(true);
  });
});

describe("GuideService.place — hasPriceList (прайс, 0030)", () => {
  const card = (organizationId: string | null, has: boolean) => {
    const hasPriceList = vi.fn(() => Promise.resolve(has));
    const svc = service({
      findPublished: () =>
        Promise.resolve({
          ...row(1),
          region_id: REGION,
          description_i18n: null,
          website: null,
          telegram: null,
          verified_at: null,
          source: "manual" as const,
          organization_id: organizationId,
        }),
      findCategory: () => Promise.resolve(undefined),
      placeTags: () => Promise.resolve([]),
      photos: () => Promise.resolve([]),
      isFavorite: () => Promise.resolve(false),
      enrichment: () => Promise.resolve(undefined),
      hasPriceList,
    });
    return { place: svc.place(REGION, row(1).id, {}), hasPriceList };
  };

  it("место партнёра — флаг из БД; не партнёрское — false без запроса", async () => {
    const partner = card(PLACE, true);
    expect((await partner.place)?.hasPriceList).toBe(true);
    expect(partner.hasPriceList).toHaveBeenCalledWith(row(1).id);
    const plain = card(null, true);
    expect((await plain.place)?.hasPriceList).toBe(false);
    expect(plain.hasPriceList).not.toHaveBeenCalled();
  });
});
