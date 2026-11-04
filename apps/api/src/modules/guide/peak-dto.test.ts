// Unit: выдача вершин (PeakDto) и поле peak в списке мест GuideService.search.
import { describe, expect, it } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { PEAKS } from "../../places-import/peaks.js";
import type { EmergencyContactsRepository } from "../emergency-contacts/index.js";
import type { MediaService } from "../media/index.js";
import type { RegionsRepository } from "../regions/index.js";
import type { GuideRepository, PlaceRow } from "./guide.repository.js";
import { GuideService } from "./guide.service.js";
import { peakDto, peakOfPlace } from "./peak-dto.js";

const peak = (slug: string) => PEAKS.find((p) => p.slug === slug)!;

describe("peakDto", () => {
  it("Говерла: сложность, время туда-назад, старт (lat/lng), погода с горной точки hoverla", () => {
    const d = peakDto(peak("hoverla"));
    expect(d).toMatchObject({
      slug: "hoverla",
      heightM: 2061,
      range: "chornohora",
      difficulty: "moderate",
      route: { roundTripKm: null, elevationGainM: 731, upHours: 3, downHours: 2, totalHours: 5 },
      weatherPoint: { lat: 48.1602, lng: 24.5003 },
    });
    expect(d.route?.startLocation).toEqual({ lat: 48.164167, lng: 24.5375 });
    expect(d.warnings.length).toBeGreaterThan(0);
    expect(d.sources[0]!.url).toMatch(/^https:\/\/uk\.wikipedia\.org\/w\/index\.php\?oldid=\d+$/);
  });
  it("Маковиця: легка, 7 км туда-назад; горной точки рядом нет — weatherPoint null", () => {
    expect(peakDto(peak("makovytsia"))).toMatchObject({
      difficulty: "easy",
      route: { roundTripKm: 7, totalHours: null },
      weatherPoint: null,
    });
  });
  it("без маршрута — difficulty null, route null", () => {
    expect(peakDto(peak("syniak"))).toMatchObject({ difficulty: null, route: null });
  });
  it("не вершина — null", () => {
    expect(peakOfPlace("ChIJ-other")).toBeNull();
    expect(peakOfPlace(null)).toBeNull();
  });
});

describe("GuideService.search — поле peak", () => {
  const REGION = "0190f5c2-7d3e-7000-8000-00000000000a";
  const row = (id: string, gid: string | null): PlaceRow => ({
    id,
    category_id: REGION,
    name_i18n: { uk: "Місце" },
    address_i18n: null,
    phone: null,
    recommended: false,
    location: { lon: 24.5, lat: 48.16 },
    distance: null,
    google_place_id: gid,
  });
  it("место-вершина — с данными вершины, остальные — peak: null", async () => {
    const { db } = recordingDb({});
    const repo: Partial<GuideRepository> = {
      search: () =>
        Promise.resolve([
          row("0190f5c2-7d3e-7000-8000-000000000001", "ChIJJ6a4ZTn9NkcRVa_k0Ycfo_c"),
          row("0190f5c2-7d3e-7000-8000-000000000002", null),
        ]),
      covers: () => Promise.resolve([]),
      coverMeta: () => Promise.resolve([]),
      adLabels: () => Promise.resolve(new Map()),
      schedules: () => Promise.resolve(new Map()),
    };
    const svc = new GuideService(
      db,
      repo as GuideRepository,
      {
        findById: (id: string) => Promise.resolve({ id, status: "active", timezone: "Europe/Kyiv" }),
      } as unknown as RegionsRepository,
      {} as EmergencyContactsRepository,
      { links: () => Promise.resolve([]) } as unknown as MediaService,
    );
    const res = await svc.search(REGION, { limit: 20, offset: 0 });
    expect(res.items[0]!.peak).toMatchObject({ slug: "hoverla", difficulty: "moderate" });
    expect(res.items[1]!.peak).toBeNull();
  });
});
