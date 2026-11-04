// Unit: раздел «Вершини» — правило сложности, данные вершин (источники, без выдумок), выбор мест peaks:sync.
import { describe, expect, it } from "vitest";
import type { MappedPlace } from "./mapping.js";
import {
  PEAK_DIFFICULTY_RULE,
  PEAKS,
  peakByGooglePlaceId,
  peakDifficulty,
  roundTripKm,
  totalHours,
  type PeakRoute,
} from "./peaks.js";
import {
  isTouchable,
  NAME_MATCH_CATEGORIES,
  nameMatchedOf,
  needsCommonsCover,
  peakNameMatches,
  pickNewPeakPlaces,
  searchQueries,
  type ExistingPlace,
} from "./peaks-sync.js";

const route = (over: Partial<PeakRoute>): PeakRoute => ({
  start: { uk: "Старт", en: "Start" },
  startLocation: null,
  startElevationM: null,
  oneWayKm: null,
  elevationGainM: null,
  gainKind: null,
  upHours: null,
  downHours: null,
  trail: null,
  ...over,
});

describe("peakDifficulty — правило", () => {
  it("набір < 500 м і < 10 км туди-назад — легка", () => {
    expect(peakDifficulty(route({ oneWayKm: 3.5, elevationGainM: 460 }))).toBe("easy");
  });
  it("рівень — найбільший з мір: набір 731 м, 5 год → середня; 10 год → складна", () => {
    expect(peakDifficulty(route({ elevationGainM: 731, upHours: 3, downHours: 2 }))).toBe("moderate");
    expect(peakDifficulty(route({ elevationGainM: 708, upHours: 5.5, downHours: 4.5 }))).toBe("hard");
  });
  it("межі: 500 м — уже середня, 4 год — ще легка, понад 10 год / 22 км / 1300 м — дуже складна", () => {
    expect(peakDifficulty(route({ oneWayKm: 2, elevationGainM: 500 }))).toBe("moderate");
    expect(peakDifficulty(route({ upHours: 2, downHours: 2 }))).toBe("easy");
    expect(peakDifficulty(route({ upHours: 6.5, downHours: 5.5 }))).toBe("expert");
    expect(peakDifficulty(route({ oneWayKm: 11 }))).toBe("expert");
    expect(peakDifficulty(route({ oneWayKm: 5, elevationGainM: 1300 }))).toBe("expert");
  });
  it("без довжини й часу — немає даних (набір сам по собі не маршрут)", () => {
    expect(peakDifficulty(null)).toBeNull();
    expect(peakDifficulty(route({ elevationGainM: 700 }))).toBeNull();
    // Лише підйом без спуску — часу туди-назад немає.
    expect(totalHours(route({ upHours: 2.5 }))).toBeNull();
    expect(peakDifficulty(route({ upHours: 2.5 }))).toBeNull();
  });
  it("туди-назад = 2 × в один бік; правило — по зростанню", () => {
    expect(roundTripKm(route({ oneWayKm: 3.5 }))).toBe(7);
    for (let i = 1; i < PEAK_DIFFICULTY_RULE.length; i++) {
      expect(PEAK_DIFFICULTY_RULE[i]!.maxGainM).toBeGreaterThan(PEAK_DIFFICULTY_RULE[i - 1]!.maxGainM);
      expect(PEAK_DIFFICULTY_RULE[i]!.maxKm).toBeGreaterThan(PEAK_DIFFICULTY_RULE[i - 1]!.maxKm);
      expect(PEAK_DIFFICULTY_RULE[i]!.maxHours).toBeGreaterThan(PEAK_DIFFICULTY_RULE[i - 1]!.maxHours);
    }
  });
});

describe("PEAKS — дані", () => {
  it("унікальні slug і id Google; у кожної вершини є джерело https", () => {
    expect(new Set(PEAKS.map((p) => p.slug)).size).toBe(PEAKS.length);
    const ids = PEAKS.flatMap((p) => (p.googlePlaceId ? [p.googlePlaceId] : []));
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PEAKS) {
      expect(p.sources.length, p.slug).toBeGreaterThan(0);
      for (const s of p.sources) expect(s.url, p.slug).toMatch(/^https:\/\//);
    }
  });
  it("набір «difference» = висота вершини − висота старту (обидві з джерел)", () => {
    for (const p of PEAKS) {
      const r = p.route;
      if (r?.gainKind !== "difference") continue;
      expect(r.startElevationM, p.slug).not.toBeNull();
      expect(r.elevationGainM, p.slug).toBe(Math.round(p.heightM! - r.startElevationM!));
    }
  });
  it("Говерла: середня, з «Заросляка»; пошук вершини за id Google", () => {
    const h = peakByGooglePlaceId("ChIJJ6a4ZTn9NkcRVa_k0Ycfo_c")!;
    expect(h.slug).toBe("hoverla");
    expect(peakDifficulty(h.route)).toBe("moderate");
    expect(h.route?.start.uk).toMatch(/Заросляк/);
    expect(peakByGooglePlaceId(null)).toBeUndefined();
    expect(peakByGooglePlaceId("ChIJ-unknown")).toBeUndefined();
  });
  it("вершини Карпат у межах ~50 км від центру пілоту (без далеких Грофи/Петроса Горганського)", () => {
    for (const p of PEAKS) {
      expect(p.location.lat, p.slug).toBeGreaterThan(48.0);
      expect(p.location.lat, p.slug).toBeLessThan(48.5);
      expect(p.location.lon, p.slug).toBeGreaterThan(24.2);
    }
  });
});

const existing = (over: Partial<ExistingPlace>): ExistingPlace => ({
  id: "p1",
  google_place_id: "g1",
  name: "Гора",
  category_code: "nature",
  status: "published",
  cover_source: null,
  cover_author: null,
  ...over,
});

describe("peaks:sync — вибір", () => {
  const hoverla = PEAKS.find((p) => p.slug === "hoverla")!;
  const turkul = PEAKS.find((p) => p.slug === "turkul")!;

  it("обкладинка Commons: немає / з Google / без автора — так; Wikimedia з автором — ні", () => {
    expect(needsCommonsCover(existing({}), hoverla)).toBe(true);
    expect(needsCommonsCover(existing({ cover_source: "google", cover_author: "Іван" }), hoverla)).toBe(true);
    expect(
      needsCommonsCover(existing({ cover_source: "wikimedia", cover_author: "Own work" }), hoverla),
    ).toBe(true);
    expect(needsCommonsCover(existing({ cover_source: "wikimedia", cover_author: "Olexdj" }), hoverla)).toBe(
      false,
    );
    expect(needsCommonsCover(existing({}), { ...hoverla, commonsFile: null })).toBe(false);
  });

  it("запит Google — лише для вершин без місця й з пошуком; поруч із вершиною", () => {
    const q = searchQueries([
      { peak: hoverla, place: null, matchedBy: null },
      { peak: turkul, place: null, matchedBy: null },
      { peak: turkul, place: existing({}), matchedBy: "google_place_id" },
    ]);
    expect(q.map((x) => x.peak.slug)).toEqual(["turkul"]);
    expect(q[0]!.query).toMatchObject({ category: "peaks", near: turkul.location, take: 1 });
  });

  it("лише вставка: чужа назва й уже наявне в регіоні місце відкидаються", () => {
    const mapped = (id: string, name: string, at = turkul.location): MappedPlace =>
      ({ googlePlaceId: id, name, at }) as MappedPlace;
    const q = searchQueries([{ peak: turkul, place: null, matchedBy: null }]);
    expect(pickNewPeakPlaces([mapped("x", "Готель Карпати")], q, new Set())).toEqual([]);
    expect(pickNewPeakPlaces([mapped("x", "гора Туркул")], q, new Set(["x"]))).toEqual([]);
    expect(pickNewPeakPlaces([mapped("x", "гора Туркул", { lon: 24.9, lat: 48.4 })], q, new Set())).toEqual(
      [],
    );
    expect(
      pickNewPeakPlaces([mapped("y", "гора Туркул")], q, new Set()).map((x) => x.place.googlePlaceId),
    ).toEqual(["y"]);
  });

  it("назва: жильё, еда, сервисы и курорт с именем вершины — не вершина; строгие совпадения", () => {
    const drahobrat = PEAKS.find((p) => p.slug === "drahobrat")!;
    const stih = PEAKS.find((p) => p.slug === "stih")!;
    const dovbushanka = PEAKS.find((p) => p.slug === "dovbushanka")!;
    expect(peakNameMatches(drahobrat, "Готель Драгобрат")).toBe(false);
    expect(peakNameMatches(drahobrat, "Драгобрат")).toBe(false);
    expect(peakNameMatches(drahobrat, "Гора Драгобрат")).toBe(true);
    expect(peakNameMatches(drahobrat, "Жандарм")).toBe(true);
    expect(peakNameMatches(turkul, "гора Туркул")).toBe(true);
    expect(peakNameMatches(turkul, "Колиба Туркул")).toBe(false);
    expect(peakNameMatches(turkul, "Садиба «Туркул»")).toBe(false);
    expect(peakNameMatches(stih, "Гора Стіг")).toBe(true);
    expect(peakNameMatches(stih, "Стогнання")).toBe(false);
    expect(peakNameMatches(dovbushanka, "Музей Довбуша")).toBe(false);
    expect(peakNameMatches(dovbushanka, "Довбушанка")).toBe(true);
    expect(NAME_MATCH_CATEGORIES).not.toContain("hotels");
    expect(NAME_MATCH_CATEGORIES).toContain("nature");
  });

  it("найдено по названию — только в отчёт, не меняется; по id и вставленное — меняется", () => {
    const byName = {
      peak: turkul,
      place: existing({ id: "p1", name: "гора Туркул" }),
      matchedBy: "name" as const,
    };
    const byId = { peak: hoverla, place: existing({ id: "p2" }), matchedBy: "google_place_id" as const };
    expect(isTouchable(byName)).toBe(false);
    expect(isTouchable(byId)).toBe(true);
    expect(isTouchable({ peak: turkul, place: null, matchedBy: null }, new Map([["turkul", "g"]]))).toBe(
      true,
    );
    expect(nameMatchedOf([byName, byId])).toEqual([
      expect.objectContaining({ slug: "turkul", placeId: "p1", name: "гора Туркул" }),
    ]);
  });
});
