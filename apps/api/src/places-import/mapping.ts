// Маппинг ответа Google Places API (New) в место каталога (без БД и сети): типы → наши категории, часы работы →
// place_schedules, телефон/сайт — в форматы CHECK миграции 0012, выбор населённого пункта по расстоянию.
import type { LonLat } from "../db/index.js";
import type { ImportLocality } from "./config.js";

/** Поля места, которые запрашивает импорт (FieldMask в google-client.ts). */
export type GooglePlace = {
  id: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  businessStatus?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: GoogleOpeningHours;
  rating?: number;
  userRatingCount?: number;
  editorialSummary?: { text?: string };
  photos?: { name?: string; widthPx?: number; heightPx?: number }[];
};

/** Точка периода: proto3 JSON опускает нули (day 0 — воскресенье, hour 0, minute 0). */
export type GooglePoint = { day?: number; hour?: number; minute?: number };
export type GoogleOpeningHours = { periods?: { open?: GooglePoint; close?: GooglePoint }[] };

// --- категории ---

/**
 * Явная таблица: тип Google (primaryType или types, Table A Places API (New)) → код нашей подкатегории. Коды — из
 * демо-seed (seed-catalog.ts) и IMPORT_EXTRA_CATEGORIES. Тип не из таблицы — пробуем следующий тип места; ни один
 * не подошёл — место пропускается (статистика «без категории»).
 */
export const GOOGLE_TYPE_TO_CATEGORY: Readonly<Record<string, string>> = {
  // Житло
  hotel: "hotels",
  resort_hotel: "hotels",
  motel: "hotels",
  hostel: "hotels",
  extended_stay_hotel: "hotels",
  inn: "hotels",
  lodging: "hotels",
  guest_house: "sadyby",
  bed_and_breakfast: "sadyby",
  cottage: "sadyby",
  farmstay: "sadyby",
  private_guest_room: "sadyby",
  camping_cabin: "sadyby",
  campground: "sadyby",
  // Їжа (суффикс *_restaurant — ресторан, кроме фастфуда; см. categoryOfType)
  restaurant: "restaurants",
  fine_dining_restaurant: "restaurants",
  banquet_hall: "restaurants",
  fast_food_restaurant: "fast-food",
  hamburger_restaurant: "fast-food",
  meal_takeaway: "fast-food",
  sandwich_shop: "fast-food",
  food_court: "fast-food",
  hot_dog_stand: "fast-food",
  cafe: "cafes",
  coffee_shop: "cafes",
  cafeteria: "cafes",
  bakery: "cafes",
  tea_house: "cafes",
  dessert_shop: "cafes",
  ice_cream_shop: "cafes",
  confectionery: "cafes",
  juice_shop: "cafes",
  bar: "cafes",
  pub: "cafes",
  wine_bar: "cafes",
  cocktail_bar: "cafes",
  bar_and_grill: "restaurants",
  // Покупки
  gift_shop: "souvenirs",
  market: "markets",
  farmers_market: "markets",
  supermarket: "groceries",
  grocery_store: "groceries",
  convenience_store: "groceries",
  food_store: "groceries",
  liquor_store: "groceries",
  butcher_shop: "groceries",
  store: "stores",
  clothing_store: "stores",
  sporting_goods_store: "stores",
  shoe_store: "stores",
  electronics_store: "stores",
  hardware_store: "stores",
  home_goods_store: "stores",
  home_improvement_store: "stores",
  book_store: "stores",
  shopping_mall: "stores",
  department_store: "stores",
  jewelry_store: "stores",
  bicycle_store: "stores",
  cell_phone_store: "mobile",
  // Халепа
  pharmacy: "pharmacies",
  drugstore: "pharmacies",
  hospital: "hospitals",
  general_hospital: "hospitals",
  medical_clinic: "hospitals",
  doctor: "hospitals",
  dentist: "hospitals",
  dental_clinic: "hospitals",
  medical_lab: "hospitals",
  atm: "atm",
  bank: "atm",
  car_repair: "car-service",
  car_wash: "car-wash",
  auto_parts_store: "car-service",
  tire_shop: "car-service",
  // Транспорт
  gas_station: "fuel",
  electric_vehicle_charging_station: "ev-charging",
  car_rental: "rental",
  taxi_stand: "taxi",
  taxi_service: "taxi",
  // Відпочинок
  spa: "spa",
  massage: "spa",
  wellness_center: "spa",
  sauna: "chany",
  public_bath: "chany",
  // Розваги
  museum: "museums",
  art_gallery: "museums",
  history_museum: "museums",
  tourist_information_center: "excursions",
  travel_agency: "excursions",
  tour_agency: "excursions",
  amusement_park: "kids",
  amusement_center: "kids",
  bowling_alley: "adult-fun",
  water_park: "kids",
  zoo: "kids",
  aquarium: "kids",
  movie_theater: "entertainment",
  night_club: "adult-fun",
  casino: "adult-fun",
  video_arcade: "kids",
  karaoke: "adult-fun",
  event_venue: "entertainment",
  ski_resort: "active",
  adventure_sports_center: "active",
  sports_activity_location: "active",
  sports_complex: "active",
  sports_club: "active",
  swimming_pool: "active",
  fitness_center: "active",
  gym: "active",
  stadium: "active",
  golf_course: "active",
  cycling_park: "active",
  off_roading_area: "active",
  horseback_riding: "active",
  hiking_area: "active",
  // Природа й пам'ятки
  natural_feature: "nature",
  national_park: "nature",
  state_park: "nature",
  park: "nature",
  garden: "nature",
  botanical_garden: "nature",
  observation_deck: "nature",
  beach: "nature",
  tourist_attraction: "sights",
  historical_landmark: "sights",
  historical_place: "sights",
  cultural_landmark: "sights",
  monument: "sights",
  sculpture: "sights",
  church: "sights",
  place_of_worship: "sights",
  plaza: "sights",
  bridge: "sights",
  landmark: "sights",
  scenic_spot: "nature",
  // Дополнения по первой выгрузке (02.11.2026): типы, которые встретились у мест пилота.
  hookah_bar: "cafes",
  pizza_delivery: "fast-food",
  playground: "kids",
  florist: "stores",
  building_materials_store: "stores",
  medical_center: "hospitals",
  // Для дітей / для дорослих / Сервіси (03.11.2026)
  indoor_playground: "kids",
  wildlife_park: "kids",
  go_karting_venue: "adult-fun",
  paintball_center: "adult-fun",
  comedy_club: "adult-fun",
  dance_hall: "adult-fun",
  telecommunications_service_provider: "mobile",
  electronics_repair_shop: "tech-repair",
  post_office: "post",
  laundry: "laundry",
  laundromat: "laundry",
  dry_cleaner: "laundry",
  hair_salon: "beauty",
  hair_care: "beauty",
  barber_shop: "beauty",
  beauty_salon: "beauty",
  nail_salon: "beauty",
  beautician: "beauty",
};

/** Категория по одному типу: таблица, затем общий суффикс *_restaurant. */
export function categoryOfType(type: string): string | undefined {
  const direct = GOOGLE_TYPE_TO_CATEGORY[type];
  if (direct) return direct;
  if (type.endsWith("_restaurant")) return "restaurants";
  return undefined;
}

const RENTAL = /прокат|оренд|rent/i;
const GEAR =
  /лиж|ski|сноуборд|snowboard|велос|bike|квадро|kvadro|quadro|багі|багги|баггі|buggy|\batv\b|снігох|4х4|4x4|спорядж|екіп|\bsup\b/i;
const CAR = /авто|\bcars?\b/i;
/** Граница кириллического слова: `\b` в JS с кириллицей не работает. */
const NOT_LETTER = "[^а-яіїєґa-z]";
/** «чан», «чани» отдельным словом, сауна, баня. */
const CHAN = new RegExp(`(^|${NOT_LETTER})чан|сауна|баня|sauna`, "i");
const GUIDE = new RegExp(`(^|${NOT_LETTER})гід(${NOT_LETTER}|$)`, "i");

/**
 * «Слабые» категории: общие типы Google (tourist_attraction, hiking_area, store…), которые часто ставят чанам,
 * прокатам, турам и водоспадам. Для них (и для мест без категории по типам) название главнее типа.
 */
const WEAK = new Set<string | undefined>([
  undefined,
  "active",
  "sights",
  "stores",
  "entertainment",
  // amusement_park/amusement_center ставят и прокатам квадроциклів, і зіплайнам — название уточняет.
  "kids",
  "adult-fun",
]);

const REPAIR = /ремонт|сервіс|service|repair|майстерн/i;
const TECH = /телефон|смартфон|ноутбук|комп.ютер|техн|iphone|apple|gsm|побутов|electronics|пральн|холодильн/i;
const OPERATOR = /київстар|kyivstar|vodafone|водафон|lifecell|лайфсел/i;
const POST = /нова пошта|nova poshta|укрпошта|ukrposhta|meest|міст експрес|поштомат/i;
const ADULT =
  /більярд|billiard|боулінг|bowling|караоке|karaoke|квест|quest|escape|картинг|karting|пейнтбол|paintball|лазертаг|нічний клуб|night ?club/i;

/** Правила по названию: первое совпавшее; `when` — к каким категориям по типам применимо. */
const NAME_RULES: readonly {
  test: (name: string) => boolean;
  code: string;
  when: (byType?: string) => boolean;
}[] = [
  {
    test: (n) => /колиб/i.test(n),
    code: "kolyby",
    when: (t) => t === "restaurants" || t === "cafes" || t === "fast-food",
  },
  {
    test: (n) => /[сc]адиб|sadyb|котедж|віл[аи]|хат[аи]|будин|cottage|chalet|шале/i.test(n),
    code: "sadyby",
    when: (t) => t === "hotels",
  },
  { test: (n) => RENTAL.test(n) && GEAR.test(n), code: "gear-rental", when: (t) => WEAK.has(t) },
  {
    test: (n) => /квадро|kvadro|quadro|багі|баггі|buggy|atv/i.test(n),
    code: "gear-rental",
    when: (t) => WEAK.has(t),
  },
  { test: (n) => RENTAL.test(n) && CAR.test(n), code: "rental", when: (t) => WEAK.has(t) },
  { test: (n) => CHAN.test(n), code: "chany", when: (t) => WEAK.has(t) || t === "spa" },
  {
    test: (n) => /водоспад|водопад|оглядов|скел[яі]|waterfall|viewpoint/i.test(n),
    code: "nature",
    when: (t) => WEAK.has(t),
  },
  {
    test: (n) => /джип|екскурс|excursion|jeep|похід|походи/i.test(n) || GUIDE.test(n),
    code: "excursions",
    when: (t) => WEAK.has(t),
  },
  {
    test: (n) => /зіплайн|zipline|тролей|родельбан|луна[ -]парк|rope ?jump|роуп|адреналін/i.test(n),
    code: "entertainment",
    when: (t) => WEAK.has(t),
  },
  // Сервіси: ремонт техніки (у Google часто cell_phone_store/electronics_store), оператори, пошта, шиномонтаж.
  {
    test: (n) => REPAIR.test(n) && TECH.test(n),
    code: "tech-repair",
    when: (t) => WEAK.has(t) || t === "mobile" || t === "laundry",
  },
  { test: (n) => OPERATOR.test(n), code: "mobile", when: (t) => WEAK.has(t) },
  // Нова пошта у Google — courier_service, как и евакуатори й перевізники: «пошта» только по названию.
  { test: (n) => POST.test(n), code: "post", when: (t) => WEAK.has(t) },
  {
    test: (n) => /шиномонтаж|вулканіз|tire/i.test(n),
    code: "car-service",
    when: (t) => WEAK.has(t) || t === "car-wash",
  },
  { test: (n) => /автомий|мийка|car ?wash/i.test(n), code: "car-wash", when: (t) => WEAK.has(t) },
  { test: (n) => /перукар|барбер|barber|салон краси/i.test(n), code: "beauty", when: (t) => WEAK.has(t) },
  { test: (n) => /пральн|хімчист|laundry/i.test(n), code: "laundry", when: (t) => WEAK.has(t) },
  // Розваги за аудиторією: бар з більярдом/караоке — теж «для дорослих».
  {
    test: (n) => ADULT.test(n),
    code: "adult-fun",
    when: (t) => WEAK.has(t) || t === "cafes" || t === "kids",
  },
  {
    // Дитячі табори (тижневі зміни) і дитячі магазини — не розвага для туриста.
    test: (n) => /дитяч|для дітей|kids|батут|зоопарк/i.test(n) && !/табір|camp|магазин|одяг|іграш/i.test(n),
    code: "kids",
    when: (t) => WEAK.has(t) && t !== "stores",
  },
  { test: (n) => /таксі|такси|taxi|трансфер/i.test(n), code: "taxi", when: (t) => t === undefined },
  { test: (n) => /аптек/i.test(n), code: "pharmacies", when: (t) => t === undefined },
  {
    test: (n) => /[сc]адиб|sadyb|котедж|відпочинок в/i.test(n),
    code: "sadyby",
    when: (t) => t === undefined,
  },
  // Прокат без уточнения и лыжные/вело-точки без типа: в регионе это прокат спорядження.
  {
    test: (n) => RENTAL.test(n) || /ski|лиж|bike|вело|enduro|ендуро/i.test(n),
    code: "gear-rental",
    when: (t) => t === undefined,
  },
];

/**
 * Уточнение по названию там, где у Google нет своего типа (колиба, чан, садиба, водоспад, прокат спорядження, джип-тур)
 * или тип слишком общий. Применяется к категории, найденной по типам (или вместо неё, если по типам — ничего).
 */
function refineByName(name: string, byType: string | undefined): string | undefined {
  for (const r of NAME_RULES) if (r.when(byType) && r.test(name)) return r.code;
  return byType;
}

/** Наша подкатегория места: primaryType, затем types по порядку, затем уточнение по названию. Нет — undefined. */
export function mapCategory(p: Pick<GooglePlace, "primaryType" | "types">, name: string): string | undefined {
  const candidates = [p.primaryType, ...(p.types ?? [])].filter((t): t is string => !!t);
  let byType: string | undefined;
  for (const t of candidates) {
    byType = categoryOfType(t);
    if (byType) break;
  }
  return refineByName(name, byType);
}

// --- часы работы ---

export type WeeklyRow = { dayOfWeek: number; opensAt: string; closesAt: string };

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Google day (0 — воскресенье … 6 — суббота) → ISO (1 — понедельник … 7 — воскресенье). */
export const isoDay = (googleDay: number): number => (googleDay === 0 ? 7 : googleDay);

const WEEK = 7 * 24 * 60;
const pointMinutes = (p: GooglePoint): number => ((p.day ?? 0) * 24 + (p.hour ?? 0)) * 60 + (p.minute ?? 0);

/**
 * regularOpeningHours.periods → недельный график (place_schedules). Правила:
 * - круглосуточно (один период с open без close, Google: day 0 00:00) — 00:00–23:59 все 7 дней;
 * - период до 24 ч — один интервал в день открытия (через полночь — closes < opens, как в нашей схеме);
 * - период длиннее суток — дни целиком (первый — с часа открытия, последний — до часа закрытия);
 * - пересечения в один день (график нашей схемы их не допускает) — график отбрасывается целиком: лучше «график
 *   неизвестен», чем неверный «Відкрито зараз».
 * - вырожденные интервалы (открытие = закрытие, напр. открытие в 23:59 многодневного периода) — отбрасываются;
 * - день/час/минута вне диапазона — график не разобран.
 * null — графика нет или он не разобран: запись не трогает существующий график места (его могла завести админка).
 */
export function mapOpeningHours(hours: GoogleOpeningHours | undefined): WeeklyRow[] | null {
  const periods = hours?.periods ?? [];
  if (!periods.length) return null;
  const valid = (p: GooglePoint | undefined) =>
    !p ||
    (inRange(p.day ?? 0, 0, 6) &&
      inRange(p.hour ?? 0, 0, 24) &&
      inRange(p.minute ?? 0, 0, 59) &&
      ((p.hour ?? 0) < 24 || (p.minute ?? 0) === 0));
  if (!periods.every((p) => valid(p.open) && valid(p.close))) return null;
  if (periods.length === 1 && periods[0]!.open && !periods[0]!.close)
    return [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, opensAt: "00:00", closesAt: "23:59" }));
  const rows: WeeklyRow[] = [];
  for (const period of periods) {
    if (!period.open || !period.close) return null;
    const start = pointMinutes(period.open);
    let end = pointMinutes(period.close);
    if (end <= start) end += WEEK;
    const duration = end - start;
    if (duration < 24 * 60) {
      const opens = start % (24 * 60);
      const closes = end % (24 * 60);
      if (opens === closes) return null;
      rows.push({ dayOfWeek: isoDay(period.open.day ?? 0), opensAt: hhmm(opens), closesAt: hhmm(closes) });
      continue;
    }
    // Многодневный период: каждый день целиком, края — по часам открытия/закрытия.
    for (let dayStart = start - (start % (24 * 60)); dayStart < end; dayStart += 24 * 60) {
      const from = Math.max(start, dayStart) - dayStart;
      const to = Math.min(end, dayStart + 24 * 60) - dayStart;
      if (to - from <= 0) continue;
      const day = Math.floor(dayStart / (24 * 60)) % 7;
      rows.push({
        dayOfWeek: isoDay(day),
        opensAt: hhmm(from),
        closesAt: to >= 24 * 60 ? "23:59" : hhmm(to),
      });
    }
  }
  const nonEmpty = rows.filter((r) => r.opensAt !== r.closesAt);
  if (!nonEmpty.length || overlapping(nonEmpty)) return null;
  return nonEmpty;
}

const inRange = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/** id места Google — формат CHECK places_google_place_id_format (0016). */
export const GOOGLE_PLACE_ID = /^[A-Za-z0-9_-]{1,255}$/;

/** Пересечение интервалов в один день (то же правило, что catalog-rules scheduleProblems). */
function overlapping(rows: readonly WeeklyRow[]): boolean {
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  for (let day = 1; day <= 7; day++) {
    const spans = rows
      .filter((r) => r.dayOfWeek === day)
      .map((r) => {
        const from = toMin(r.opensAt);
        const to = toMin(r.closesAt);
        return [from, to > from ? to : 24 * 60] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    if (spans.some((s, i) => i > 0 && s[0] < spans[i - 1]![1])) return true;
  }
  return false;
}

// --- контакты ---

/** Телефон Google ("+380 98 793 0729") → E.164 (CHECK places_phone_format); не подходит — null. */
export function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  return /^\+[1-9][0-9]{6,14}$/.test(digits) ? digits : null;
}

/** Сайт: только https и не длиннее 300 (CHECK places_website_format); http и прочее — null. */
export function normalizeWebsite(raw: string | undefined): string | null {
  if (!raw) return null;
  const url = raw.trim();
  return /^https:\/\/\S+$/.test(url) && url.length <= 300 ? url : null;
}

// --- география ---

/** Расстояние по сфере (haversine), м. */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Ближайший пункт, в радиус которого попадает точка; вне всех радиусов — undefined. */
export function nearestLocality<L extends ImportLocality>(
  at: LonLat,
  localities: readonly L[],
): L | undefined {
  let best: { l: L; d: number } | undefined;
  for (const l of localities) {
    const d = haversineMeters(at, l.at);
    if (d <= l.radiusM && (!best || d < best.d)) best = { l, d };
  }
  return best?.l;
}

/** Прямоугольник вокруг круга (locationRestriction Text Search принимает только rectangle); с запасом: 111 км на градус. */
export function boundingBox(center: LonLat, radiusM: number): { low: LonLat; high: LonLat } {
  const dLat = radiusM / 111_000;
  const dLon = radiusM / (111_000 * Math.cos((center.lat * Math.PI) / 180));
  return {
    low: { lon: center.lon - dLon, lat: center.lat - dLat },
    high: { lon: center.lon + dLon, lat: center.lat + dLat },
  };
}

// --- место целиком ---

export type MappedPlace = {
  googlePlaceId: string;
  categoryCode: string;
  localityCode: string;
  name: string;
  description: string;
  address: string;
  at: LonLat;
  phone: string | null;
  website: string | null;
  /** null — графика нет у Google или он не разобран: существующий график места не трогается. */
  week: WeeklyRow[] | null;
  /** Имена фото Google (places/…/photos/…), не больше двух. */
  photos: string[];
  rating: number | null;
  ratingCount: number | null;
};

export type SkipReason =
  | "closed_permanently"
  | "invalid_id"
  | "no_location"
  | "outside_radius"
  | "no_category"
  | "no_name";

/** Описание места: краткое описание Google (если есть) или «<тип> у <пункті>.», плюс источник. */
export function describe(p: GooglePlace, locality: ImportLocality, fallbackType: string): string {
  const summary = p.editorialSummary?.text?.trim();
  const type = p.primaryTypeDisplayName?.text?.trim() || fallbackType;
  const base = summary || `${type} ${locality.inUk}.`;
  return `${base} Джерело: Google Maps.`;
}

/**
 * Место Google → строка импорта или причина пропуска. Категорию названия — `categoryNames` (код → название uk) для
 * описания, если у Google нет primaryTypeDisplayName.
 */
export function mapPlace(
  p: GooglePlace,
  localities: readonly ImportLocality[],
  categoryNames: Readonly<Record<string, string>> = {},
): { ok: true; place: MappedPlace } | { ok: false; reason: SkipReason } {
  if (p.businessStatus === "CLOSED_PERMANENTLY") return { ok: false, reason: "closed_permanently" };
  const name = p.displayName?.text?.trim();
  if (typeof p.id !== "string" || !GOOGLE_PLACE_ID.test(p.id)) return { ok: false, reason: "invalid_id" };
  if (!name) return { ok: false, reason: "no_name" };
  const lat = p.location?.latitude;
  const lon = p.location?.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return { ok: false, reason: "no_location" };
  const at = { lon, lat };
  const locality = nearestLocality(at, localities);
  if (!locality) return { ok: false, reason: "outside_radius" };
  const categoryCode = mapCategory(p, name);
  if (!categoryCode) return { ok: false, reason: "no_category" };
  return {
    ok: true,
    place: {
      googlePlaceId: p.id,
      categoryCode,
      localityCode: locality.code,
      name,
      description: describe(p, locality, categoryNames[categoryCode] ?? "Місце"),
      address: p.shortFormattedAddress?.trim() || p.formattedAddress?.trim() || locality.name.uk,
      at,
      phone: normalizePhone(p.internationalPhoneNumber),
      website: normalizeWebsite(p.websiteUri),
      week: mapOpeningHours(p.regularOpeningHours),
      photos: (p.photos ?? [])
        .map((ph) => ph.name)
        .filter((n): n is string => !!n)
        .slice(0, 2),
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
    },
  };
}
