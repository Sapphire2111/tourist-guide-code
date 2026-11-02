// Unit (без БД): правила сервиса гида (блок 4, ADR-0019) — граница листания поиска (SEARCH_OFFSET_MAX) и лимит
// избранного (FAVORITES_MAX → 409). Репозиторий подменён; транзакция региона — на recordingDb.
import { describe, expect, it } from "vitest";
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
});

function service(repo: Partial<GuideRepository>) {
  const { db } = recordingDb({});
  const base: Partial<GuideRepository> = {
    covers: () => Promise.resolve([]),
    coverMeta: () => Promise.resolve([]),
    adLabels: () => Promise.resolve(new Map()),
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
