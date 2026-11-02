// Unit: маппинг Google Places → каталог (типы → категории, часы → place_schedules, контакты, пункт по расстоянию).
import { describe, expect, it } from "vitest";
import { scheduleProblems } from "../modules/catalog/index.js";
import { SEED_CATEGORIES } from "../seed/seed-catalog.js";
import { IMPORT_EXTRA_CATEGORIES, IMPORT_LOCALITIES } from "./config.js";
import {
  boundingBox,
  categoryOfType,
  GOOGLE_TYPE_TO_CATEGORY,
  haversineMeters,
  mapCategory,
  mapOpeningHours,
  mapPlace,
  nearestLocality,
  normalizePhone,
  normalizeWebsite,
  type GooglePlace,
} from "./mapping.js";

const CODE = /^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$/;
const seedSub = SEED_CATEGORIES.flatMap((c) => c.children.map((s) => s.code));

describe("таблица типов → категорий", () => {
  it("каждая цель — подкатегория seed или дополнительная категория импорта", () => {
    const known = new Set([...seedSub, ...IMPORT_EXTRA_CATEGORIES.map((c) => c.code)]);
    for (const [type, code] of Object.entries(GOOGLE_TYPE_TO_CATEGORY))
      expect(known.has(code), type).toBe(true);
  });

  it("дополнительные категории — новые коды под корневыми разделами seed", () => {
    const roots = new Set(SEED_CATEGORIES.map((c) => c.code));
    for (const c of IMPORT_EXTRA_CATEGORIES) {
      expect(c.code).toMatch(CODE);
      expect(seedSub).not.toContain(c.code);
      expect(roots.has(c.parent), c.code).toBe(true);
    }
  });

  it.each([
    ["hotel", "hotels"],
    ["guest_house", "sadyby"],
    ["ukrainian_restaurant", "restaurants"],
    ["fast_food_restaurant", "fast-food"],
    ["hamburger_restaurant", "fast-food"],
    ["coffee_shop", "cafes"],
    ["supermarket", "groceries"],
    ["pharmacy", "pharmacies"],
    ["hospital", "hospitals"],
    ["atm", "atm"],
    ["gas_station", "fuel"],
    ["electric_vehicle_charging_station", "ev-charging"],
    ["car_rental", "rental"],
    ["museum", "museums"],
    ["tourist_attraction", "sights"],
    ["ski_resort", "active"],
    ["sauna", "chany"],
  ])("%s → %s", (type, code) => expect(categoryOfType(type)).toBe(code));

  it("служебные типы без категории", () => {
    for (const t of ["point_of_interest", "establishment", "locality", "political", "route"])
      expect(categoryOfType(t)).toBeUndefined();
  });

  it("primaryType главнее types; без primaryType — первый подходящий тип", () => {
    expect(mapCategory({ primaryType: "cafe", types: ["restaurant", "cafe"] }, "X")).toBe("cafes");
    expect(mapCategory({ types: ["point_of_interest", "bar", "restaurant"] }, "X")).toBe("cafes");
    expect(mapCategory({ types: ["point_of_interest", "establishment"] }, "X")).toBeUndefined();
  });

  it("уточнение по названию: колиба, садиба, чани, водоспад, прокат", () => {
    expect(mapCategory({ primaryType: "restaurant" }, "Колиба «Гуцулка»")).toBe("kolyby");
    expect(mapCategory({ primaryType: "lodging" }, "Садиба Над Прутом")).toBe("sadyby");
    expect(mapCategory({ primaryType: "hotel" }, "Готель Карпати")).toBe("hotels");
    expect(mapCategory({ primaryType: "spa" }, "Карпатські чани")).toBe("chany");
    expect(mapCategory({ primaryType: "spa" }, "SPA Печанка")).toBe("spa");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Водоспад Пробій")).toBe("nature");
    expect(mapCategory({ types: ["point_of_interest"] }, "Оглядовий майданчик")).toBe("nature");
    expect(mapCategory({ primaryType: "store" }, "Прокат лиж Bukovel")).toBe("gear-rental");
    expect(mapCategory({ types: ["point_of_interest"] }, "Прокат велосипедів")).toBe("gear-rental");
    expect(mapCategory({ types: ["point_of_interest"] }, "Прокат авто Яремче")).toBe("rental");
    expect(mapCategory({ primaryType: "restaurant" }, "Прокат лиж і кафе")).toBe("restaurants");
  });

  it("название главнее «слабого» типа; слова — целиком, латинская «C» в «Cадиба»", () => {
    expect(mapCategory({ primaryType: "hotel" }, "Cадиба «Карпатське відлуння»")).toBe("sadyby");
    expect(mapCategory({ primaryType: "hiking_area" }, "Водопад Сергій")).toBe("nature");
    expect(mapCategory({ primaryType: "sports_activity_location" }, "Чан Тепло Карпат")).toBe("chany");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Печера Довбуша")).toBe("sights");
    expect(mapCategory({ primaryType: "tour_agency" }, "Прокат квадроциклів")).toBe("excursions");
    expect(mapCategory({ types: ["service"] }, "Квадроцикли KvadroBug")).toBe("gear-rental");
    expect(mapCategory({ types: ["service"] }, "VIP Прокат 4х4")).toBe("gear-rental");
    expect(mapCategory({ types: ["service"] }, "Прокат")).toBe("gear-rental");
    expect(mapCategory({ types: ["service"] }, "Rent The Carpathians")).toBe("gear-rental");
    expect(mapCategory({ types: ["service"] }, "Car rent Bukovel")).toBe("rental");
    expect(mapCategory({ types: ["service"] }, "Горганський гід")).toBe("excursions");
    expect(mapCategory({ types: ["service"] }, "Гідромасаж")).toBeUndefined();
    expect(mapCategory({ types: ["transportation_service"] }, "Таксі Яремче")).toBe("taxi");
    expect(mapCategory({ types: ["transportation_service"] }, "Яремче Аптека")).toBe("pharmacies");
    expect(mapCategory({ types: ["service"] }, "Карпатська рись")).toBeUndefined();
  });
});

describe("часы работы → place_schedules", () => {
  const p = (od: number, oh: number, cd: number, ch: number, om = 0, cm = 0) => ({
    open: { day: od, hour: oh, minute: om },
    close: { day: cd, hour: ch, minute: cm },
  });

  it("обычная неделя: Google day 0 (вс) → ISO 7, 1 (пн) → 1", () => {
    const rows = mapOpeningHours({ periods: [p(0, 10, 0, 22), p(1, 9, 1, 18, 30, 15)] });
    expect(rows).toEqual([
      { dayOfWeek: 7, opensAt: "10:00", closesAt: "22:00" },
      { dayOfWeek: 1, opensAt: "09:30", closesAt: "18:15" },
    ]);
  });

  it("proto3 опускает нули: нет day/hour — воскресенье, 00", () => {
    expect(mapOpeningHours({ periods: [{ open: { hour: 8 }, close: { hour: 20 } }] })).toEqual([
      { dayOfWeek: 7, opensAt: "08:00", closesAt: "20:00" },
    ]);
  });

  it("через полночь: интервал в день открытия, closes < opens", () => {
    expect(mapOpeningHours({ periods: [p(5, 20, 6, 2)] })).toEqual([
      { dayOfWeek: 5, opensAt: "20:00", closesAt: "02:00" },
    ]);
    // Суббота → воскресенье (переход недели).
    expect(mapOpeningHours({ periods: [p(6, 22, 0, 3)] })).toEqual([
      { dayOfWeek: 6, opensAt: "22:00", closesAt: "03:00" },
    ]);
  });

  it("круглосуточно (open без close) — 00:00–23:59 все дни", () => {
    const rows = mapOpeningHours({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] })!;
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.dayOfWeek)).size).toBe(7);
    expect(rows.every((r) => r.opensAt === "00:00" && r.closesAt === "23:59")).toBe(true);
  });

  it("многодневный период — дни целиком, края по часам", () => {
    expect(mapOpeningHours({ periods: [p(1, 8, 3, 20)] })).toEqual([
      { dayOfWeek: 1, opensAt: "08:00", closesAt: "23:59" },
      { dayOfWeek: 2, opensAt: "00:00", closesAt: "23:59" },
      { dayOfWeek: 3, opensAt: "00:00", closesAt: "20:00" },
    ]);
  });

  it("обед (два интервала в день) — допустим; пересечение — график отбрасывается (null)", () => {
    const lunch = mapOpeningHours({ periods: [p(2, 9, 2, 13), p(2, 14, 2, 19)] })!;
    expect(lunch).toHaveLength(2);
    expect(scheduleProblems(lunch, [])).toEqual([]);
    expect(mapOpeningHours({ periods: [p(2, 9, 2, 15), p(2, 14, 2, 19)] })).toBeNull();
  });

  it("нет периодов — null (график неизвестен, существующий не трогается); период без close среди нескольких — null", () => {
    expect(mapOpeningHours(undefined)).toBeNull();
    expect(mapOpeningHours({ periods: [] })).toBeNull();
    expect(mapOpeningHours({ periods: [p(1, 9, 1, 18), { open: { day: 2, hour: 9 } }] })).toBeNull();
  });

  it("вырожденный интервал (открытие в 23:59 многодневного периода) отбрасывается", () => {
    expect(mapOpeningHours({ periods: [p(1, 23, 2, 10, 59)] })).toEqual([
      { dayOfWeek: 1, opensAt: "23:59", closesAt: "10:00" },
    ]);
    expect(mapOpeningHours({ periods: [p(1, 23, 3, 10, 59)] })).toEqual([
      { dayOfWeek: 2, opensAt: "00:00", closesAt: "23:59" },
      { dayOfWeek: 3, opensAt: "00:00", closesAt: "10:00" },
    ]);
  });

  it("день/час/минута вне диапазона — график не разобран", () => {
    expect(mapOpeningHours({ periods: [p(7, 9, 7, 18)] })).toBeNull();
    expect(mapOpeningHours({ periods: [p(1, 25, 1, 26)] })).toBeNull();
    expect(mapOpeningHours({ periods: [p(1, 9, 1, 18, 60)] })).toBeNull();
  });

  it("результат всегда проходит правила графика каталога", () => {
    const rows = mapOpeningHours({
      periods: [0, 1, 2, 3, 4, 5, 6].map((d) => p(d, 11, (d + 1) % 7, 1)),
    })!;
    expect(rows).toHaveLength(7);
    expect(scheduleProblems(rows, [])).toEqual([]);
  });
});

describe("контакты", () => {
  it("телефон → E.164", () => {
    expect(normalizePhone("+380 98 793 0729")).toBe("+380987930729");
    expect(normalizePhone("098 793 0729")).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });

  it("сайт — только https до 300 символов", () => {
    expect(normalizeWebsite("https://vedmezhagora.com/panorama-restoran/")).toBe(
      "https://vedmezhagora.com/panorama-restoran/",
    );
    expect(normalizeWebsite("http://example.com/")).toBeNull();
    expect(normalizeWebsite("HTTPS://EXAMPLE.COM")).toBeNull();
    expect(normalizeWebsite(`https://e.com/${"a".repeat(300)}`)).toBeNull();
  });
});

describe("география", () => {
  const yaremche = IMPORT_LOCALITIES.find((l) => l.code === "yaremche")!;

  it("haversine: 0,01° широты ≈ 1112 м", () => {
    expect(haversineMeters({ lon: 24.5, lat: 48.4 }, { lon: 24.5, lat: 48.41 })).toBeCloseTo(1112, -1);
  });

  it("ближайший пункт в радиусе; вне радиусов — нет", () => {
    expect(nearestLocality(yaremche.at, IMPORT_LOCALITIES)?.code).toBe("yaremche");
    expect(nearestLocality({ lon: 24.71, lat: 48.92 }, IMPORT_LOCALITIES)).toBeUndefined(); // Івано-Франківськ
  });

  it("прямоугольник покрывает круг радиуса", () => {
    const box = boundingBox(yaremche.at, yaremche.radiusM);
    expect(haversineMeters(yaremche.at, { lon: yaremche.at.lon, lat: box.high.lat })).toBeGreaterThanOrEqual(
      yaremche.radiusM,
    );
    expect(haversineMeters(yaremche.at, { lon: box.low.lon, lat: yaremche.at.lat })).toBeGreaterThanOrEqual(
      yaremche.radiusM,
    );
  });

  it("пять пунктов пилота с радиусом", () => {
    expect(IMPORT_LOCALITIES.map((l) => l.code)).toEqual([
      "yaremche",
      "tatariv",
      "mykulychyn",
      "polianytsia",
      "yablunytsia",
    ]);
  });
});

describe("место целиком", () => {
  const base: GooglePlace = {
    id: "ChIJQx6Lec4lN0cR43YEENy1P0c",
    displayName: { text: "Panorama Restaurant" },
    formattedAddress: "вулиця Михайла Грушевського, 29, Яремче, Івано-Франківська область, 78500",
    shortFormattedAddress: "вулиця Михайла Грушевського, 29, Яремче",
    location: { latitude: 48.446291, longitude: 24.5419235 },
    types: ["restaurant", "ukrainian_restaurant", "bar", "food", "point_of_interest"],
    primaryType: "restaurant",
    primaryTypeDisplayName: { text: "Ресторан" },
    businessStatus: "OPERATIONAL",
    internationalPhoneNumber: "+380 98 793 0729",
    websiteUri: "https://vedmezhagora.com/panorama-restoran/",
    regularOpeningHours: { periods: [{ open: { day: 1, hour: 13 }, close: { day: 1, hour: 22 } }] },
    photos: [{ name: "places/a/photos/1" }, { name: "places/a/photos/2" }, { name: "places/a/photos/3" }],
  };

  it("все поля карточки", () => {
    const r = mapPlace(base, IMPORT_LOCALITIES);
    expect(r).toEqual({
      ok: true,
      place: {
        googlePlaceId: base.id,
        categoryCode: "restaurants",
        localityCode: "yaremche",
        name: "Panorama Restaurant",
        description: "Ресторан у Яремчі. Джерело: Google Maps.",
        address: "вулиця Михайла Грушевського, 29, Яремче",
        at: { lon: 24.5419235, lat: 48.446291 },
        phone: "+380987930729",
        website: "https://vedmezhagora.com/panorama-restoran/",
        week: [{ dayOfWeek: 1, opensAt: "13:00", closesAt: "22:00" }],
        photos: ["places/a/photos/1", "places/a/photos/2"],
        rating: null,
        ratingCount: null,
      },
    });
  });

  it("без часов у Google — week null", () => {
    const r = mapPlace({ ...base, regularOpeningHours: undefined }, IMPORT_LOCALITIES);
    expect(r.ok && r.place.week).toBeNull();
  });

  it("описание — editorialSummary, если есть", () => {
    const r = mapPlace({ ...base, editorialSummary: { text: "Панорамний ресторан." } }, IMPORT_LOCALITIES);
    expect(r.ok && r.place.description).toBe("Панорамний ресторан. Джерело: Google Maps.");
  });

  it("причины пропуска", () => {
    const reason = (p: GooglePlace) => {
      const r = mapPlace(p, IMPORT_LOCALITIES);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason({ ...base, businessStatus: "CLOSED_PERMANENTLY" })).toBe("closed_permanently");
    expect(reason({ ...base, businessStatus: "CLOSED_TEMPORARILY" })).toBe("ok");
    expect(reason({ ...base, displayName: { text: " " } })).toBe("no_name");
    expect(reason({ ...base, id: "bad id/../x" })).toBe("invalid_id");
    expect(reason({ ...base, id: "a".repeat(256) })).toBe("invalid_id");
    expect(reason({ ...base, location: undefined })).toBe("no_location");
    expect(reason({ ...base, location: { latitude: 48.92, longitude: 24.71 } })).toBe("outside_radius");
    expect(reason({ ...base, primaryType: undefined, types: ["point_of_interest"] })).toBe("no_category");
  });
});
