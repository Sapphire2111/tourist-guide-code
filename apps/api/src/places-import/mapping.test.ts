// Unit: маппинг Google Places → каталог (типы → категории, часы → place_schedules, контакты, пункт по расстоянию).
import { describe, expect, it } from "vitest";
import { scheduleProblems } from "../modules/catalog/index.js";
import { SEED_CATEGORIES, SEED_IMPORT_CATEGORY_CODES, SEED_TAGS } from "../seed/seed-catalog.js";
import { IMPORT_EXTRA_CATEGORIES, IMPORT_LOCALITIES, SEARCH_ZONES } from "./config.js";
import {
  boundingBox,
  categoryOfType,
  classifyPlace,
  dedupePlaces,
  googleLocality,
  isGenericLabel,
  stripRoomSuffix,
  tagsForPlace,
  WEAK_MIN_REVIEWS,
  GOOGLE_TYPE_TO_CATEGORY,
  haversineMeters,
  extraCategories,
  isForeignPost,
  localityOf,
  mapCategory,
  mapOpeningHours,
  mapPlace,
  nearestLocality,
  normalizePhone,
  normalizeWebsite,
  type GooglePlace,
  type MappedPlace,
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
    ["ski_resort", "ski-resorts"],
    ["sauna", "chany"],
  ])("%s → %s", (type, code) => expect(categoryOfType(type)).toBe(code));

  it.each([
    ["playground", "kids"],
    ["water_park", "entertainment"],
    ["zoo", "kids"],
    ["bowling_alley", "adult-fun"],
    ["karaoke", "adult-fun"],
    ["night_club", "adult-fun"],
    ["cell_phone_store", "mobile"],
    ["car_wash", "car-wash"],
    ["tire_shop", "car-service"],
    ["post_office", "post"],
    ["laundry", "laundry"],
    ["hair_salon", "beauty"],
    ["barber_shop", "beauty"],
  ])("сервіси й розваги: %s → %s", (type, code) => expect(categoryOfType(type)).toBe(code));

  it("сервіси й розваги за назвою", () => {
    expect(mapCategory({ primaryType: "cell_phone_store" }, "Ремонт телефонів «Майстер»")).toBe(
      "tech-repair",
    );
    expect(mapCategory({ primaryType: "store" }, "Сервісний центр: ремонт ноутбуків")).toBe("tech-repair");
    expect(mapCategory({ primaryType: "store" }, "Київстар")).toBe("mobile");
    expect(mapCategory({}, "Нова пошта №1")).toBe("post");
    expect(mapCategory({}, "Шиномонтаж")).toBe("car-service");
    expect(mapCategory({ primaryType: "car_wash" }, "Шиномонтаж і мийка")).toBe("car-service");
    expect(mapCategory({ primaryType: "bar" }, "Караоке-бар «Ніч»")).toBe("adult-fun");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Квест кімната")).toBe("adult-fun");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Дитячий майданчик")).toBe("kids");
    expect(mapCategory({ primaryType: "bar" }, "Бар «Гуцул»")).toBe("bars");
    expect(mapCategory({ primaryType: "hospital" }, "Дитяча лікарня")).toBe("hospitals");
    expect(mapCategory({ primaryType: "courier_service" }, "Нова Пошта №1")).toBe("post");
    expect(mapCategory({ primaryType: "courier_service" }, "Евакуатор Яремче")).toBe("tow-trucks");
    expect(mapCategory({ primaryType: "laundry" }, "Ремонт пральних машин")).toBe("tech-repair");
    expect(mapCategory({ primaryType: "amusement_park" }, "Прокат квадроциклів")).toBe("active");
    expect(mapCategory({ primaryType: "store" }, "Дитячий магазин одягу")).toBe("stores");
    // Метки без заведения, поштомати и табори не импортируются.
    expect(mapCategory({ primaryType: "night_club" }, "Mastercard")).toBeUndefined();
    expect(mapCategory({ primaryType: "paintball_center" }, "БУКОВЕЛЬ ЯРЕМЧЕ")).toBeUndefined();
    expect(mapCategory({ primaryType: "playground" }, "Яремче")).toBeUndefined();
    expect(mapCategory({ primaryType: "playground" }, "Дитячий табір")).toBeUndefined();
    expect(mapCategory({ primaryType: "hotel" }, "Готель Буковель")).toBe("hotels");
    // Сильный тип — заведение, даже если название — только курорт.
    expect(mapCategory({ primaryType: "ski_resort" }, "Буковель")).toBe("ski-resorts");
    expect(mapCategory({ primaryType: "hotel" }, "Карпати")).toBe("hotels");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Polianytsia")).toBeUndefined();
    // kids по названию — только при типе Google; садочки, школи, лікарні — нет.
    expect(mapCategory({}, "Дитячий майданчик")).toBeUndefined();
    // …а садочки, ДЮСШ і загальноосвітні школи з tourist_attraction — не наші (no_category).
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Дитячий садок «Сонечко»")).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "ДЮСШ дитяча")).toBeUndefined();
    expect(
      mapCategory({ primaryType: "tourist_attraction" }, "Яремчанська ЗОШ І-ІІІ ступенів"),
    ).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Школа №2")).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Школа І-ІІІ ступенів")).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Ліцей №1")).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Гімназія № 3")).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Ворохтянський опорний ліцей")).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Загальноосвітня школа")).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Дитсадок «Казка»")).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Ясла-садок «Берізка»")).toBeUndefined();
    // Сади, старі гімназії, готелі «Ліцей», школи ремесел і лиж — не садочки/школи.
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Японський садок")).toBe("sights");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Вишневий садок")).toBe("sights");
    expect(mapCategory({ primaryType: "historical_landmark" }, "Стара гімназія")).toBe("sights");
    expect(mapCategory({ primaryType: "hotel" }, "Готель Ліцей")).toBe("hotels");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Лижна школа")).toBeDefined();
    // Школи ремесел — для туриста.
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Школа гончарства")).toBe("sights");
    // Мелочи: шини, мийка килимів, квест.
    expect(mapCategory({ primaryType: "store" }, "Мийка килимів")).toBe("stores");
    expect(mapCategory({ primaryType: "store" }, "Entire Home")).toBe("stores");
    expect(mapCategory({ primaryType: "store" }, "Tire service")).toBe("car-service");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Квест по Яремчу")).toBe("sights");
    expect(mapCategory({}, "Нова Пошта. Поштомат №35404")).toBeUndefined();
    expect(mapCategory({ primaryType: "post_office" }, "Нова Пошта. Поштове відділення №2")).toBe("post");
    expect(mapCategory({ primaryType: "childrens_camp" }, "Дитячий табір в Карпатах")).toBeUndefined();
    expect(mapCategory({ primaryType: "amusement_park" }, "Roller Coaster Zipline")).toBe("active");
  });

  it("авто, гірські лижі, активний відпочинок — по типам и названию (данные выгрузки 03.11.2026)", () => {
    expect(mapCategory({ primaryType: "ski_resort" }, "Буковель")).toBe("ski-resorts");
    expect(mapCategory({ primaryType: "ski_resort" }, "14 підйомник Буковель")).toBe("ski-lifts");
    expect(mapCategory({ primaryType: "event_venue" }, 'Гірськолижний витяг "Коза"')).toBe("ski-lifts");
    expect(mapCategory({ primaryType: "sports_club" }, "Гірськолижний комплекс «Багрівець»")).toBe(
      "ski-resorts",
    );
    expect(mapCategory({ types: ["ski_resort", "sports_club"] }, "лижна школа")).toBe("ski-schools");
    expect(mapCategory({}, "Bukovel Ski School")).toBe("ski-schools");
    expect(mapCategory({ primaryType: "service" }, "SeeSki Black")).toBe("ski-rental");
    expect(mapCategory({}, "COCOS SKI-RENT прокат лиж та сноубордів")).toBe("ski-rental");
    expect(
      mapCategory({ primaryType: "sportswear_store", types: ["sporting_goods_store"] }, "SkiMarket"),
    ).toBe("ski-shops");
    expect(mapCategory({ primaryType: "clothing_store" }, "Фанатік Спорт гірськолижний магазин")).toBe(
      "ski-shops",
    );
    expect(mapCategory({}, "DZVIN-SKI SERVICE")).toBe("ski-service");
    expect(mapCategory({ primaryType: "hotel", types: ["hotel", "ski_resort"] }, "Скита")).toBe("hotels");
    expect(mapCategory({ primaryType: "bar" }, "БАР APRES-SKI")).toBe("bars");
    expect(mapCategory({}, "Евакуатор цілодобово Яремче Буковель")).toBe("tow-trucks");
    expect(mapCategory({ primaryType: "car_repair" }, "Евакуатор Яремча СТО GOLD")).toBe("tow-trucks");
    expect(mapCategory({ primaryType: "parking_lot" }, "Паркінг 1")).toBe("parking");
    expect(mapCategory({ primaryType: "store" }, "Ринок Яремче стоянка")).toBe("stores");
    expect(mapCategory({ primaryType: "car_wash" }, "Автомийка")).toBe("car-wash");
    expect(mapCategory({ primaryType: "tour_agency" }, "Джип-тури Карпатами")).toBe("active");
    expect(mapCategory({ primaryType: "tour_agency" }, "Прогулянки на конях")).toBe("active");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Зіплайн Яремче")).toBe("active");
    expect(mapCategory({ primaryType: "ferris_wheel" }, "Колесо огляду")).toBe("entertainment");
    expect(mapCategory({ primaryType: "event_venue" }, "Дитячий табір Петрос")).toBeUndefined();
  });

  it("дополнительные категории: место в нескольких разделах", () => {
    const x = (code: string, p: Parameters<typeof extraCategories>[1], name: string) =>
      extraCategories(code, p, name).sort();
    expect(x("entertainment", { primaryType: "water_park" }, "Аквапарк MAVKA")).toEqual(["active", "kids"]);
    expect(x("entertainment", { primaryType: "ferris_wheel" }, "Колесо огляду")).toEqual(["active", "kids"]);
    expect(x("entertainment", { primaryType: "movie_theater" }, "Кінотеатр")).toEqual([]);
    expect(x("gear-rental", {}, "Прокат велосипедів")).toEqual(["active"]);
    expect(x("ski-rental", {}, "Прокат лиж")).toEqual(["gear-rental"]);
    expect(x("ski-resorts", {}, "Буковель")).toEqual(["active"]);
    expect(x("ski-lifts", {}, "Підйомник")).toEqual(["active"]);
    expect(x("active", {}, "Прокат квадроциклів")).toEqual(["adult-fun", "gear-rental"]);
    expect(x("active", {}, "Рафтинг на Пруті")).toEqual([]);
    expect(x("car-service", {}, "СТО")).toEqual(["help"]);
    expect(x("tow-trucks", {}, "Евакуатор")).toEqual(["help"]);
    expect(x("pharmacies", {}, "Аптека")).toEqual([]);
  });

  it("паркінг — только с отзывами (не каждая метка)", () => {
    const p = (n: number): GooglePlace => ({
      id: "ChIJparking",
      displayName: { text: "Паркінг 1" },
      location: { latitude: 48.4505, longitude: 24.5547 },
      primaryType: "parking_lot",
      userRatingCount: n,
    });
    expect(mapPlace(p(50), IMPORT_LOCALITIES)).toMatchObject({
      ok: true,
      place: { categoryCode: "parking" },
    });
    expect(mapPlace(p(2), IMPORT_LOCALITIES)).toEqual({ ok: false, reason: "no_category" });
  });

  it("дополнительные категории импорта — известные коды (подкатегории или корни)", () => {
    const known = new Set([
      ...SEED_CATEGORIES.flatMap((c) => [c.code, ...c.children.map((s) => s.code)]),
      ...IMPORT_EXTRA_CATEGORIES.map((c) => c.code),
    ]);
    for (const code of ["kids", "active", "adult-fun", "gear-rental", "help"])
      expect(known.has(code), code).toBe(true);
  });

  it("корень «Послуги» — в seed без подкатегорий, подкатегории заводит импорт", () => {
    const services = SEED_CATEGORIES.find((c) => c.code === "services")!;
    expect(services.home).toBe("services");
    expect(IMPORT_EXTRA_CATEGORIES.filter((c) => c.parent === "services").map((c) => c.code)).toEqual([
      "tech-repair",
      "mobile",
      "post",
      "laundry",
      "beauty",
    ]);
  });

  it("служебные типы без категории", () => {
    for (const t of ["point_of_interest", "establishment", "locality", "political", "route"])
      expect(categoryOfType(t)).toBeUndefined();
  });

  it("primaryType главнее types; без primaryType — первый подходящий тип", () => {
    expect(mapCategory({ primaryType: "cafe", types: ["restaurant", "cafe"] }, "Смак")).toBe("cafes");
    expect(mapCategory({ types: ["point_of_interest", "bar", "restaurant"] }, "Смак")).toBe("bars");
    expect(mapCategory({ types: ["point_of_interest", "establishment"] }, "Смак")).toBeUndefined();
  });

  it("уточнение по названию: колиба, садиба, чани, водоспад, прокат", () => {
    expect(mapCategory({ primaryType: "restaurant" }, "Колиба «Гуцулка»")).toBe("kolyby");
    expect(mapCategory({ primaryType: "lodging" }, "Садиба Над Прутом")).toBe("sadyby");
    expect(mapCategory({ primaryType: "hotel" }, "Готель Карпати")).toBe("hotels");
    expect(mapCategory({ primaryType: "spa" }, "Карпатські чани")).toBe("chany");
    expect(mapCategory({ primaryType: "spa" }, "SPA Печанка")).toBe("spa");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Водоспад Пробій")).toBe("nature");
    expect(mapCategory({ types: ["point_of_interest"] }, "Оглядовий майданчик Маковиця")).toBe("nature");
    expect(mapCategory({ primaryType: "store" }, "Прокат лиж Bukovel")).toBe("ski-rental");
    expect(mapCategory({ types: ["point_of_interest"] }, "Прокат велосипедів")).toBe("gear-rental");
    expect(mapCategory({ types: ["point_of_interest"] }, "Прокат авто Яремче")).toBe("rental");
    expect(mapCategory({ primaryType: "restaurant" }, "Прокат лиж і кафе")).toBe("restaurants");
  });

  it("название главнее «слабого» типа; слова — целиком, латинская «C» в «Cадиба»", () => {
    expect(mapCategory({ primaryType: "hotel" }, "Cадиба «Карпатське відлуння»")).toBe("sadyby");
    expect(mapCategory({ primaryType: "hiking_area" }, "Водопад Сергій")).toBe("nature");
    expect(mapCategory({ primaryType: "sports_activity_location" }, "Чан Тепло Карпат")).toBe("chany");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Печера Довбуша")).toBe("nature");
    expect(mapCategory({ primaryType: "tour_agency" }, "Прокат квадроциклів")).toBe("active");
    expect(mapCategory({ types: ["service"] }, "Квадроцикли KvadroBug")).toBe("active");
    expect(mapCategory({ types: ["service"] }, "VIP Прокат 4х4")).toBe("gear-rental");
    expect(mapCategory({ types: ["service"] }, "Прокат №2")).toBe("gear-rental");
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

  it("пункты пилота с радиусом (Ворохта — с 03.11.2026)", () => {
    expect(IMPORT_LOCALITIES.map((l) => l.code)).toEqual([
      "yaremche",
      "tatariv",
      "mykulychyn",
      "polianytsia",
      "yablunytsia",
      "vorokhta",
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
        extraCategoryCodes: [],
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

describe("зоны поиска (SEARCH_ZONES) и отнесение к пункту", () => {
  const code = (at: { lon: number; lat: number }) => localityOf(at, IMPORT_LOCALITIES, SEARCH_ZONES)?.code;

  it("зоны ссылаются на существующие пункты и не дальше 10 км от их центров", () => {
    const byCode = new Map(IMPORT_LOCALITIES.map((l) => [l.code, l]));
    expect(new Set(SEARCH_ZONES.map((z) => z.code)).size).toBe(SEARCH_ZONES.length);
    for (const z of SEARCH_ZONES) {
      expect(z.localities.length, z.code).toBeGreaterThan(0);
      for (const c of z.localities) {
        const l = byCode.get(c);
        expect(l, `${z.code} → ${c}`).toBeDefined();
        expect(haversineMeters(z.at, l!.at), `${z.code} → ${c}`).toBeLessThan(10_000);
      }
    }
  });

  it("север Дори (Свободи 22Б, «Нова пошта №1») — вне круга Яремча, но в зоне → Яремче", () => {
    const np1 = { lon: 24.59394, lat: 48.48526 };
    expect(nearestLocality(np1, IMPORT_LOCALITIES)).toBeUndefined();
    expect(code(np1)).toBe("yaremche");
  });

  it("урочище Женець, полонина Залім, Нарінецький водоспад → Татарів", () => {
    expect(code({ lon: 24.5515, lat: 48.3694 })).toBe("tatariv"); // урочище Женець (в круге)
    expect(code({ lon: 24.5147, lat: 48.3859 })).toBe("tatariv"); // полонина Залім (зона)
    expect(code({ lon: 24.5217, lat: 48.3842 })).toBe("tatariv"); // Нарінецький водоспад (зона)
  });

  it("коридор между пунктами — к ближайшему по центру пункту зоны; круг пункта главнее зоны", () => {
    expect(code({ lon: 24.535, lat: 48.33 })).toBe("tatariv"); // Н09 ближе к Татарову
    expect(code({ lon: 24.512, lat: 48.322 })).toBe("yablunytsia"); // Н09 ближе к Яблуниці
    expect(code({ lon: 24.578, lat: 48.3205 })).toBe("tatariv"); // Р24 между Татаровом и Ворохтой
    expect(code({ lon: 24.5547, lat: 48.4505 })).toBe("yaremche");
  });

  it("вне пунктов и зон — нет; без зон — прежнее правило радиуса", () => {
    expect(code({ lon: 24.71, lat: 48.92 })).toBeUndefined();
    expect(localityOf({ lon: 24.59394, lat: 48.48526 }, IMPORT_LOCALITIES)).toBeUndefined();
  });

  it("mapPlace с зонами: «Нова пошта №1» Свободи 22Б → Яремче, пошта", () => {
    const np: GooglePlace = {
      id: "np1",
      displayName: { text: "Нова пошта №1" },
      location: { latitude: 48.48526, longitude: 24.59394 },
      types: ["courier_service", "storage", "post_office"],
      primaryType: "courier_service",
    };
    expect(mapPlace(np, IMPORT_LOCALITIES)).toEqual({ ok: false, reason: "outside_radius" });
    expect(mapPlace(np, IMPORT_LOCALITIES, {}, undefined, { zones: SEARCH_ZONES })).toMatchObject({
      ok: true,
      place: { localityCode: "yaremche", categoryCode: "post" },
    });
  });
});

describe("паркинг и маска без числа отзывов", () => {
  const parking: GooglePlace = {
    id: "pk",
    displayName: { text: "Парковка" },
    location: { latitude: IMPORT_LOCALITIES[0]!.at.lat, longitude: IMPORT_LOCALITIES[0]!.at.lon },
    primaryType: "parking",
  };
  it("число отзывов не запрашивалось (pro) — unverified, а не «не наш»", () => {
    expect(mapPlace(parking, IMPORT_LOCALITIES, {}, undefined, { ratingsKnown: false })).toEqual({
      ok: false,
      reason: "unverified",
    });
  });
  it("запрашивалось — прежнее правило PARKING_MIN_REVIEWS", () => {
    expect(mapPlace(parking, IMPORT_LOCALITIES)).toEqual({ ok: false, reason: "no_category" });
    expect(mapPlace({ ...parking, userRatingCount: 9 }, IMPORT_LOCALITIES)).toMatchObject({
      ok: true,
      place: { categoryCode: "parking" },
    });
  });
});

describe("пошта: чужі відділення й поштомати", () => {
  it("индекс Укрпошти не региона — чужое; 785xx/786xx — наше", () => {
    expect(isForeignPost("Укрпошта 77344")).toBe(true);
    expect(isForeignPost("Укрпошта 78341")).toBe(true);
    expect(isForeignPost("Укрпошта 78590")).toBe(false);
    expect(isForeignPost("Укрпошта 78600")).toBe(false);
    expect(isForeignPost("Укрпошта")).toBe(false);
  });

  it("Нова пошта: другая область — чужое; поштомат — тоже не берём", () => {
    expect(isForeignPost("Нова Пошта. Пункт №1 (до 30 кг) с. Соколівка, Львівська область")).toBe(true);
    expect(
      isForeignPost("Нова Пошта. Вантажне відділення №1 (до 1100 кг) с. Татарів, Івано-Франківська область"),
    ).toBe(false);
    expect(isForeignPost("Нова Пошта. Поштомат №5388 (до 20 кг) м. Яремче, Івано-Франківська область")).toBe(
      true,
    );
    expect(isForeignPost("Нова пошта №1")).toBe(false);
  });

  it("наша область в любом написании: «Ів.-Франківська обл.», латинская I, «ІФ обл.», «Франківська обл.», латиница", () => {
    expect(isForeignPost("Нова Пошта №3 м. Яремче, Ів.-Франківська обл.")).toBe(false);
    expect(isForeignPost("Нова Пошта №3 м. Яремче, Iвано-Франківська область")).toBe(false); // латинская I
    expect(isForeignPost("Нова Пошта №3 м. Яремче, ІФ обл.")).toBe(false);
    expect(isForeignPost("Нова Пошта №3 м. Яремче, Франківська обл.")).toBe(false);
    expect(isForeignPost("Nova Poshta №3 Yaremche, Ivano-Frankivsk Oblast")).toBe(false);
    expect(isForeignPost("Нова Пошта №1 с. Соколівка, Львівська обл.")).toBe(true);
    expect(isForeignPost("Nova Poshta №1 Sokolivka, Lviv Oblast")).toBe(true);
  });

  it("mapCategory: чужое отделение Укрпошти с точкой в Микуличине — без категории", () => {
    const ukr = { primaryType: "post_office", types: ["post_office", "courier_service"] };
    expect(mapCategory(ukr, "Укрпошта 77344")).toBeUndefined();
    expect(mapCategory(ukr, "Укрпошта 78590")).toBe("post");
  });

  it("природа с названием только пункта («Яремче») — метка, не заведение", () => {
    expect(mapCategory({ primaryType: "natural_feature" }, "Яремче")).toBeUndefined();
    expect(mapCategory({ primaryType: "natural_feature" }, "Водоспад Пробій")).toBe("nature");
    expect(mapCategory({ primaryType: "park" }, "Ворохта")).toBeUndefined();
    // «Буковель» і «Карпати» — це й гора/хребет: природа з такою назвою лишається.
    expect(mapCategory({ primaryType: "natural_feature" }, "Буковель")).toBe("nature");
    expect(mapCategory({ primaryType: "natural_feature" }, "Карпати")).toBe("nature");
  });
});

// Аудит категорий staging 04.11.2026 (curated_findings.csv): реальные названия и типы Google мест пилота.
describe("правила импорта по аудиту категорий (04.11.2026)", () => {
  it("1. прокат авто з джип-турами й квадроциклами — активний відпочинок (+ прокат спорядження); прокат авто — ні", () => {
    const rental = { primaryType: "car_rental" };
    expect(mapCategory(rental, "Джип Тури")).toBe("active");
    expect(mapCategory(rental, "Прокат джипів Яремче - Джип Тури")).toBe("active");
    expect(mapCategory(rental, "Toyota Jeep Toor")).toBe("active");
    expect(mapCategory(rental, "Kvadro VIP")).toBe("active");
    expect(mapCategory(rental, "подорожі на позашляховиках")).toBe("active");
    expect(mapCategory(rental, "Прокат снігоходів")).toBe("active");
    expect(mapCategory(rental, "Pride Cars")).toBe("rental");
    expect(mapCategory(rental, "Оренда Авто AVALON")).toBe("rental");
    expect(extraCategories("active", rental, "Джип Тури").sort()).toEqual(["adult-fun", "gear-rental"]);
    expect(extraCategories("active", { primaryType: "tour_agency" }, "Джип Тури")).toEqual(["adult-fun"]);
  });

  it("2. вершини: гора/вершина/hora/mount/г. — для природних і слабких типів; «Вершини» — у config і seed", () => {
    expect(mapCategory({ primaryType: "natural_feature" }, "Hora Synyak")).toBe("peaks");
    expect(mapCategory({ primaryType: "hiking_area" }, "Гора «Білий камінь»")).toBe("peaks");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Вершина гори Магура")).toBe("peaks");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Кедрівка гора")).toBe("peaks");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "г.Томас")).toBe("peaks");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Rebrovatch mountain")).toBe("peaks");
    expect(mapCategory({ primaryType: "hiking_area" }, "Безіменна гора")).toBe("peaks");
    // Не вершини: «Вид на гори», готель і магазин з «горою» в назві.
    expect(mapCategory({ primaryType: "hiking_area" }, "Вид на гори Карпат")).toBe("nature");
    expect(mapCategory({ primaryType: "hotel" }, "Готель Гора")).toBe("hotels");
    expect(mapCategory({ primaryType: "store" }, "Гора подарунків")).toBe("stores");
    const peaks = IMPORT_EXTRA_CATEGORIES.find((c) => c.code === "peaks");
    expect(peaks).toMatchObject({ parent: "nearby", name: { uk: "Вершини" } });
    expect(SEED_IMPORT_CATEGORY_CODES).toContain("peaks");
  });

  it("3. природа за назвою: джерела, криниці, полонини, каньйони, озера, печери, дерева, потоки", () => {
    for (const name of [
      "Вдсп Явірник",
      "Водограй на струмку Багрівець",
      "Чемегівський каньйон",
      "Джерело Довбуша",
      "Криниця Святого Івана",
      "Полонина Поварівка",
      "Озеро з лебедями",
      "Печера Довбуша",
      "300-річна смерека",
      "Найстаріше дерево",
      "Річка Пихти повноводна",
      "Лісний струмок",
      "Ручей Татаровчик",
    ])
      expect(mapCategory({ primaryType: "tourist_attraction" }, name), name).toBe("nature");
    // «Дерев'яний» — не дерево; магазин «Озерце» — не природа.
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Дерев'яна церква")).toBe("sights");
    expect(mapCategory({ primaryType: "store" }, "Озерце")).toBe("stores");
  });

  it("4. «Зона для прогулянок» — природа, не активність; без упізнаної назви — лише з відгуками", () => {
    const at = { latitude: 48.4505, longitude: 24.5547 };
    const hiking = (name: string, n?: number): GooglePlace => ({
      id: "ChIJhiking",
      displayName: { text: name },
      location: at,
      primaryType: "hiking_area",
      ...(n === undefined ? {} : { userRatingCount: n }),
    });
    const r = (p: GooglePlace, ratingsKnown?: boolean) => {
      const m = mapPlace(
        p,
        IMPORT_LOCALITIES,
        {},
        undefined,
        ratingsKnown === undefined ? {} : { ratingsKnown },
      );
      return m.ok ? m.place.categoryCode : m.reason;
    };
    expect(r(hiking("Альтанка в лісі", 1))).toBe("no_category");
    expect(r(hiking("Під лісом"))).toBe("no_category");
    expect(r(hiking("Карусель у Татарові"))).toBe("no_category");
    expect(r(hiking("Карпатське золото", WEAK_MIN_REVIEWS))).toBe("nature");
    expect(r(hiking("Карпатське золото"), false)).toBe("unverified");
    // Упізнана назва — без порогу: водоспад, полонина, вершина; уточнення назвою (квадроцикли, чан) — як раніше.
    expect(r(hiking("Юрин водоспад", 2))).toBe("nature");
    expect(r(hiking("Полонина Поварівка", 2))).toBe("nature");
    expect(r(hiking("Безіменна гора", 1))).toBe("peaks");
    expect(r(hiking("Прокат квадроциклів, екскурсії в гори на джипах"))).toBe("active");
    expect(r(hiking("Карпатський чан"))).toBe("chany");
    // Парк без назви парку — теж з порогом (лісництва, профкоми); «Парк …» — без.
    expect(r({ ...hiking("Микуличинське лісництво", 2), primaryType: "park" })).toBe("no_category");
    expect(r({ ...hiking("Парк Перемоги", 0), primaryType: "park" })).toBe("nature");
    // tourist_attraction порогу не має: пам'ятник без відгуків — пам'ятка.
    expect(r({ ...hiking("Пам'ятник Шевченку"), primaryType: "tourist_attraction" })).toBe("sights");
    // Точечный импорт (категория задана) — без порога.
    expect(mapPlace(hiking("Під лісом"), IMPORT_LOCALITIES, {}, "nature").ok).toBe(true);
  });

  it("5. родові назви-мітки й назви без літер — не імпортуються", () => {
    for (const name of [
      "Оглядовий майданчик",
      "Відпочинок",
      "Гойдалка",
      "Джерело",
      "Гора",
      "Альтанка",
      "Місце для пікніка",
      "Прокат",
      "Садиба",
      "Бар",
      "Café",
      "1",
      "№ 5",
      "not",
    ])
      expect(isGenericLabel(name), name).toBe(true);
    expect(mapCategory({ types: ["point_of_interest"] }, "Оглядовий майданчик")).toBeUndefined();
    expect(mapCategory({ primaryType: "tourist_attraction" }, "«Гойдалка»")).toBeUndefined();
    expect(mapCategory({ primaryType: "lodging" }, "Садиба")).toBeUndefined();
    expect(mapCategory({ primaryType: "bar" }, "Бар")).toBeUndefined();
    expect(mapCategory({ primaryType: "cafe" }, "Café")).toBeUndefined();
    expect(mapCategory({ primaryType: "fast_food_restaurant" }, "1")).toBeUndefined();
    // Подписи пунктов — в т. ч. «Яблониця» (hiking_area → природа).
    expect(mapCategory({ primaryType: "hiking_area" }, "Яблониця")).toBeUndefined();
    // Имя собственное — заведение.
    for (const name of ["Садиба Над Прутом", "Бар «Гуцул»", "АТБ", "Оглядовий майданчик Маковиця"])
      expect(isGenericLabel(name), name).toBe(false);
  });

  it("6–7. латиниця й русизми: Kolyba, Villa, лыжи/горнолыжн/суперскі", () => {
    expect(mapCategory({ primaryType: "restaurant" }, "Royal Kolyba")).toBe("kolyby");
    expect(mapCategory({ primaryType: "restaurant" }, 'Hotel & Restaurant Kolyba "SilverOks"')).toBe(
      "kolyby",
    );
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Наша колиба")).toBe("kolyby");
    expect(mapCategory({ primaryType: "hotel" }, "Villa Leku")).toBe("sadyby");
    expect(mapCategory({ primaryType: "hotel" }, "Arnika Villa")).toBe("sadyby");
    expect(mapCategory({ primaryType: "hotel" }, "Вілла Прованс")).toBe("sadyby");
    expect(mapCategory({ primaryType: "hotel" }, "Готель Привілля")).toBe("hotels");
    expect(mapCategory({}, "Прокат горнолыжного снаряжения")).toBe("ski-rental");
    expect(mapCategory({}, "Прокат суперскі 2")).toBe("ski-rental");
    expect(mapCategory({ primaryType: "sports_club" }, "Прокат лыж")).toBe("ski-rental");
    expect(mapCategory({}, 'Студия проката и подбора горнолыжного снаряжения "Zoom"')).toBe("ski-rental");
  });

  it("8. бари, паби й кальянні — «Бари»; нічні клуби й кальянні — ще й «Для дорослих»", () => {
    expect(categoryOfType("bar")).toBe("bars");
    expect(categoryOfType("pub")).toBe("bars");
    expect(categoryOfType("hookah_bar")).toBe("bars");
    expect(mapCategory({ primaryType: "hookah_bar" }, "Кальянна «Дим»")).toBe("bars");
    expect(mapCategory({ primaryType: "cafe" }, "Lounge Кальянна Буковель")).toBe("bars");
    expect(mapCategory({ primaryType: "cafe" }, "Irish Pub")).toBe("bars");
    expect(mapCategory({ primaryType: "cafe" }, "Кафе-бар Смерічка")).toBe("cafes");
    expect(mapCategory({ primaryType: "bar" }, "Караоке-бар «Ніч»")).toBe("adult-fun");
    expect(extraCategories("bars", { primaryType: "hookah_bar" }, "Кальянна «Дим»")).toEqual(["adult-fun"]);
    expect(extraCategories("bars", { primaryType: "bar", types: ["night_club"] }, "Apres")).toEqual([
      "adult-fun",
    ]);
    expect(extraCategories("bars", { primaryType: "pub" }, "Irish Pub")).toEqual([]);
    const bars = IMPORT_EXTRA_CATEGORIES.find((c) => c.code === "bars");
    expect(bars).toMatchObject({ parent: "eat", name: { uk: "Бари" } });
    expect(SEED_IMPORT_CATEGORY_CODES).toContain("bars");
  });

  it("9. записи номерів Booking: суфікс відкидається; однакова назва в 50 м — одне місце", () => {
    expect(stripRoomSuffix('Садиба "Градний Узвіз" - Superior Double Room')).toBe('Садиба "Градний Узвіз"');
    expect(stripRoomSuffix("Cottage PolyaNitsa окремий котедж з каміном - Three-Bedroom Villa")).toBe(
      "Cottage PolyaNitsa окремий котедж з каміном",
    );
    expect(stripRoomSuffix("Agate Resort SPA - Two-Bedroom Cottage with Sauna")).toBe("Agate Resort SPA");
    expect(stripRoomSuffix("Котедж Яблуниця - Vacation Home")).toBe("Котедж Яблуниця");
    // Кирилиця після тире — частина назви, не суфікс.
    expect(stripRoomSuffix("Прокат джипів Яремче - Джип Тури")).toBe("Прокат джипів Яремче - Джип Тури");
    expect(stripRoomSuffix("Rooms")).toBe("Rooms");

    const room: GooglePlace = {
      id: "ChIJroom1",
      displayName: { text: 'Дерев\'яний котедж "Казка" - Budget Double Room' },
      location: { latitude: 48.4505, longitude: 24.5547 },
      primaryType: "lodging",
    };
    const m = mapPlace(room, IMPORT_LOCALITIES);
    expect(m.ok && [m.place.name, m.place.categoryCode, m.place.roomListing]).toEqual([
      'Дерев\'яний котедж "Казка"',
      "sadyby",
      true,
    ]);

    const mp = (id: string, over: Partial<MappedPlace>): MappedPlace => ({
      googlePlaceId: id,
      categoryCode: "sadyby",
      extraCategoryCodes: [],
      localityCode: "yaremche",
      name: "Садиба Казка",
      description: "",
      address: "",
      at: { lon: 24.5547, lat: 48.4505 },
      phone: null,
      website: null,
      week: null,
      photos: [],
      rating: null,
      ratingCount: null,
      ...over,
    });
    const near = { lon: 24.5547, lat: 48.4508 }; // ~33 м
    const far = { lon: 24.5547, lat: 48.4515 }; // ~110 м
    const r = dedupePlaces([
      mp("r1", { roomListing: true, ratingCount: 50 }),
      mp("main", { categoryCode: "hotels", name: "Садиба «Казка»", at: near }),
      mp("r2", { roomListing: true, at: near }),
      mp("other", { at: far, roomListing: true }),
      mp("cafe", { categoryCode: "cafes" }),
    ]);
    expect(r.kept.map((p) => p.googlePlaceId)).toEqual(["main", "other", "cafe"]);
    expect(r.duplicateIds).toEqual(["r1", "r2"]);
    // Без Booking: однакова назва й категорія в 50 м — одне (більше відгуків); різні категорії — обидва.
    const s = dedupePlaces([
      mp("a", { categoryCode: "nature", name: "Водоспад Капливець", ratingCount: 3 }),
      mp("b", { categoryCode: "nature", name: "Водоспад  Капливець", ratingCount: 90, at: near }),
      mp("c", { categoryCode: "sights", name: "Водоспад Капливець" }),
    ]);
    expect(s.kept.map((p) => p.googlePlaceId)).toEqual(["b", "c"]);
    expect(s.duplicateIds).toEqual(["a"]);
  });

  it("10. населений пункт — з адреси Google (locality), відстань — запасний варіант", () => {
    // Південь Микуличина в колі Татарова: за відстанню — Татарів, за адресою — Микуличин.
    const at = { lon: 24.585, lat: 48.367 };
    expect(localityOf(at, IMPORT_LOCALITIES)?.code).toBe("tatariv");
    const comps = (text: string, type = "locality") => ({
      addressComponents: [
        { longText: "Івано-Франківська область", types: ["administrative_area_level_1", "political"] },
        { longText: text, shortText: text, types: [type, "political"] },
      ],
    });
    expect(googleLocality(comps("Микуличин"), at, IMPORT_LOCALITIES)?.code).toBe("mykulychyn");
    expect(googleLocality(comps("Mykulychyn"), at, IMPORT_LOCALITIES)?.code).toBe("mykulychyn");
    // Буковель — Поляниця.
    const bukovel = { lon: 24.4, lat: 48.36 };
    expect(googleLocality(comps("Буковель"), bukovel, IMPORT_LOCALITIES)?.code).toBe("polianytsia");
    // «Яремче» в адресі Буковеля (громада, 13 км) — не віримо; чужий пункт — теж.
    expect(googleLocality(comps("Яремче"), bukovel, IMPORT_LOCALITIES)).toBeUndefined();
    expect(googleLocality(comps("Делятин"), at, IMPORT_LOCALITIES)).toBeUndefined();
    expect(googleLocality({}, at, IMPORT_LOCALITIES)).toBeUndefined();
    const place = (c: Partial<GooglePlace>): GooglePlace => ({
      id: "ChIJloc",
      displayName: { text: "Готель Орлан" },
      location: { latitude: at.lat, longitude: at.lon },
      primaryType: "hotel",
      ...c,
    });
    const code = (p: GooglePlace) => {
      const m = mapPlace(p, IMPORT_LOCALITIES);
      return m.ok ? m.place.localityCode : m.reason;
    };
    expect(code(place(comps("Микуличин")))).toBe("mykulychyn");
    expect(code(place({}))).toBe("tatariv");
    // Поза колами й зонами адреса не допомагає.
    expect(code(place({ ...comps("Яремче"), location: { latitude: 48.92, longitude: 24.71 } }))).toBe(
      "outside_radius",
    );
  });

  it("11. опис: категорія за назвою — назва нашої категорії, не тип Google", () => {
    const p: GooglePlace = {
      id: "ChIJchan",
      displayName: { text: "Чани Мур" },
      location: { latitude: 48.4505, longitude: 24.5547 },
      primaryType: "general_contractor",
      types: ["general_contractor", "tourist_attraction"],
      primaryTypeDisplayName: { text: "Генеральний підрядник" },
    };
    const m = mapPlace(p, IMPORT_LOCALITIES, { chany: "Чани та сауни" });
    expect(m.ok && m.place.description).toBe("Чани та сауни у Яремчі. Джерело: Google Maps.");
    // Категорія за типом — тип Google, як і раніше.
    const r = mapPlace(
      {
        ...p,
        displayName: { text: "Ресторан Гуцулка" },
        primaryType: "restaurant",
        types: [],
        primaryTypeDisplayName: { text: "Ресторан" },
      },
      IMPORT_LOCALITIES,
      { restaurants: "Ресторани" },
    );
    expect(r.ok && r.place.description).toBe("Ресторан у Яремчі. Джерело: Google Maps.");
    expect(
      classifyPlace({ primaryType: "general_contractor", types: ["tourist_attraction"] }, "Чани Мур"),
    ).toEqual({ code: "chany", byName: true, type: "tourist_attraction" });
  });

  it("12. таксі за назвою главнее туристичного агентства й житла; екскурсії — доп. категорія", () => {
    expect(mapCategory({ primaryType: "lodging" }, "Приватне таксі Ворохта")).toBe("taxi");
    expect(mapCategory({ primaryType: "travel_agency" }, "БУКОВЕЛЬ ТАКСІ+ЕКСКУРСІЇ")).toBe("taxi");
    expect(mapCategory({ primaryType: "travel_agency" }, "ТАКСІ WOLF")).toBe("taxi");
    expect(mapCategory({}, "Таксі Татарів Заросляк Говерла Водоспад Гук Трансфер")).toBe("taxi");
    expect(mapCategory({ primaryType: "hotel" }, "Готель з трансфером")).toBe("hotels");
    expect(extraCategories("taxi", { primaryType: "travel_agency" }, "ТАКСІ WOLF")).toEqual(["excursions"]);
    expect(extraCategories("taxi", {}, "БУКОВЕЛЬ ТАКСІ+ЕКСКУРСІЇ")).toEqual(["excursions"]);
    expect(extraCategories("taxi", {}, "Таксі Яремче")).toEqual([]);
  });

  it("13. підйомники: канатна дорога, витяг, крісельний; aerial_lift; і при «Зоні для прогулянок»", () => {
    expect(mapCategory({}, 'канатна дорога "Захар Беркут"')).toBe("ski-lifts");
    expect(mapCategory({ primaryType: "hiking_area" }, "Канатна дорога Яремче")).toBe("ski-lifts");
    expect(mapCategory({ primaryType: "sports_complex" }, "Крісельний підйомник R1")).toBe("ski-lifts");
    expect(mapCategory({ primaryType: "tourist_attraction" }, "Витяг на Маковицю")).toBe("ski-lifts");
    expect(mapCategory({ primaryType: "aerial_lift" }, "Гондола Буковель")).toBe("ski-lifts");
  });

  it("14. теги: удобства Google й категорія (tagsForPlace)", () => {
    expect(
      tagsForPlace("restaurants", ["good_for_children", "dogs_allowed", "parking_free", "vegetarian"]),
    ).toEqual(["kids", "parking", "pets", "rainy-day", "vegetarian"]);
    expect(tagsForPlace("hotels", ["parking_paid", "kids_menu", "wheelchair_entrance"])).toEqual([
      "kids",
      "parking",
    ]);
    for (const c of ["museums", "spa", "chany", "cafes", "kolyby", "bars"])
      expect(tagsForPlace(c, []), c).toEqual(["rainy-day"]);
    expect(tagsForPlace("nature", [])).toEqual([]);
    expect(tagsForPlace("active", [])).toEqual([]);
    // Розваги — «У дощ» лише криті за назвою.
    expect(tagsForPlace("adult-fun", [], "Боулінг Strike")).toEqual(["rainy-day"]);
    expect(tagsForPlace("entertainment", [], "Кінотеатр")).toEqual(["rainy-day"]);
    expect(tagsForPlace("entertainment", [], "Родельбан")).toEqual([]);
    // Коды — только теги seed.
    const seedTags = new Set(SEED_TAGS.map((t) => t.code));
    for (const t of tagsForPlace("cafes", [
      "good_for_children",
      "dogs_allowed",
      "parking_free",
      "vegetarian",
    ]))
      expect(seedTags.has(t), t).toBe(true);
  });
});
