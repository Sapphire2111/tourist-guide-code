// Маппинг ответа Google Places API (New) в место каталога (без БД и сети): типы → наши категории, часы работы →
// place_schedules, телефон/сайт — в форматы CHECK миграции 0012, выбор населённого пункта (адрес Google, затем
// расстояние), теги места по удобствам Google и категории.
import type { LonLat } from "../db/index.js";
import { LOCALITY_ALIASES } from "../modules/guide/index.js";
import { REGION_POSTCODE_PREFIXES, type ImportLocality, type SearchZone } from "./config.js";

/** Поля места, которые запрашивает импорт (FieldMask в google-client.ts). */
export type GooglePlace = {
  id: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  /** Части адреса (SKU Text Search Pro — как адрес и точка): населённый пункт — тип locality. */
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
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
  // Бари, паби, кальянні — окремо від кафе (04.11.2026); night_club/hookah — ще й «Для дорослих» (extraCategories).
  bar: "bars",
  pub: "bars",
  wine_bar: "bars",
  cocktail_bar: "bars",
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
  sportswear_store: "stores",
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
  // Авто
  gas_station: "fuel",
  parking: "parking",
  parking_lot: "parking",
  parking_garage: "parking",
  towing_service: "tow-trucks",
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
  amusement_park: "entertainment",
  amusement_center: "kids",
  bowling_alley: "adult-fun",
  water_park: "entertainment",
  zoo: "kids",
  aquarium: "kids",
  movie_theater: "entertainment",
  night_club: "adult-fun",
  casino: "adult-fun",
  video_arcade: "kids",
  karaoke: "adult-fun",
  event_venue: "entertainment",
  ski_resort: "ski-resorts",
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
  // «Зона для прогулянок»: Google ставит її видам, альтанкам, гойдалкам, мостам — не активність. Тип слабкий
  // (WEAK_SOURCE_TYPES): назва уточнює, без уточнення — природа й поріг відгуків (WEAK_MIN_REVIEWS).
  hiking_area: "nature",
  aerial_lift: "ski-lifts",
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
  hookah_bar: "bars",
  pizza_delivery: "fast-food",
  playground: "kids",
  florist: "stores",
  building_materials_store: "stores",
  medical_center: "hospitals",
  // Для дітей / для дорослих / Сервіси (03.11.2026)
  indoor_playground: "kids",
  ferris_wheel: "entertainment",
  roller_coaster: "entertainment",
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

/** Лижі: латиниця й русизми («лыж», «горнолыжн», «суперскі») — частина вивісок прокатів російською. */
const SKI = /\bski|ski\b|лиж|лыж|сноуборд|snowboard|бордів|суперск/i;
/** Лыжная точка без типа Google (SeeSki, HAPPY SKI…): в регионе это прокат. */
const t0 = (n: string) => /\bski|ski\b/i.test(n);
const ADVENTURE =
  /джип|jeep|квадро|kvadro|quadro|багі|баггі|buggy|\batv\b|позашлях|off-?road|снігох|снегох|рафтинг|rafting|зіплайн|zipline|тролей|родельбан|rope ?jump|роуп|адреналін|на конях|кінн|конн[іи]|horse/i;
/** Вершина: «Гора Х», «Х гора», «Hora X», «X mountain», «Вершина …», «г.Томас». */
const PEAK = new RegExp(
  `(^|${NOT_LETTER})(гора|hora|mount|mountain|вершина)(${NOT_LETTER}|$)|(^|${NOT_LETTER})г\\.\\s*[а-яіїєґa-z]`,
  "i",
);
/** Природний об'єкт за назвою (водоспад, скеля, джерело, полонина, каньйон, озеро, печера, дерево, потік…). */
const NATURE_NAME =
  /водоспад|водопад|вдсп|водограй|оглядов|скел[яіьи]|waterfall|viewpoint|джерел|криниц|родник|полонин|каньйон|каньон|canyon|озер|печер|cave|смерек|сосн|дерев(?![’'ʼ`]?ян)|струм|потіч|потік|ручей|ручай|річк|river|lake/i;
/** Канатні дороги й підйомники. */
const LIFT =
  /підйомник|витяг|бугел|крісельн|\blift\b|канатн.{0,4}\s*дорог|канатк|aerial ?lift|cable ?car|гондол/i;
/** Таксі за назвою — главнее travel_agency/lodging (Google ставит такси «Туристичне агентство», «Нічліг»). */
const TAXI = /таксі|такси|taxi/i;
/** Кальянні, лаунжі й паби з типом кафе — «Бари». */
const BAR_NAME = new RegExp(
  `кальян|hookah|shisha|lounge|лаунж|(^|${NOT_LETTER})(паб|pub)(${NOT_LETTER}|$)`,
  "i",
);
const REPAIR = /ремонт|сервіс|service|repair|майстерн/i;
const TECH = /телефон|смартфон|ноутбук|комп.ютер|техн|iphone|apple|gsm|побутов|electronics|пральн|холодильн/i;
const OPERATOR = /київстар|kyivstar|vodafone|водафон|lifecell|лайфсел/i;
const POST = /нова пошта|nova poshta|укрпошта|ukrposhta|meest|міст експрес|поштомат/i;
const ADULT =
  /більярд|billiard|боулінг|bowling|караоке|karaoke|квест[- ]?(кімнат|рум)|quest ?room|escape ?room|картинг|karting|пейнтбол|paintball|лазертаг|нічний клуб|night ?club/i;

/** Правила по названию: первое совпавшее; `when` — к каким категориям по типам применимо. */
const NAME_RULES: readonly {
  test: (name: string) => boolean;
  code: string;
  when: (byType?: string) => boolean;
}[] = [
  // Авто: евакуатори (у Google — service/courier_service/car_repair).
  {
    test: (n) => /евакуат|tow ?truck/i.test(n),
    code: "tow-trucks",
    when: (t) => WEAK.has(t) || t === "car-service" || t === "taxi",
  },
  // Таксі: у Google — travel_agency (екскурсії — доп. категорія) или lodging («Приватне таксі Ворохта»).
  {
    test: (n) => TAXI.test(n),
    code: "taxi",
    when: (t) => WEAK.has(t) || t === "excursions" || t === "hotels" || t === "sadyby",
  },
  // Гірські лижі: школи, підйомники, сервіс, магазини, курорти, прокат (основная; прокат — ещё и gear-rental).
  {
    test: (n) => SKI.test(n) && /школ|school|інструктор|instructor/i.test(n),
    code: "ski-schools",
    when: (t) => WEAK.has(t) || t === "ski-resorts" || t === "gear-rental",
  },
  // Канатні дороги й витяги: и при «Зоні для прогулянок»/active (канатна дорога «Захар Беркут»).
  {
    test: (n) => LIFT.test(n),
    code: "ski-lifts",
    when: (t) => WEAK.has(t) || t === "ski-resorts",
  },
  {
    test: (n) => SKI.test(n) && /сервіс|service|заточ|ремонт|tuning/i.test(n) && !RENTAL.test(n),
    code: "ski-service",
    when: (t) => WEAK.has(t) || t === "ski-resorts",
  },
  {
    test: (n) => /гірськолиж|\bski|лиж|лыж|сноуборд|snowboard/i.test(n) && !RENTAL.test(n),
    code: "ski-shops",
    when: (t) => t === "stores",
  },
  {
    test: (n) => /гірськолижн.{0,3}\s+(комплекс|курорт|станці)/i.test(n),
    code: "ski-resorts",
    when: (t) => WEAK.has(t),
  },
  {
    test: (n) => SKI.test(n) && (RENTAL.test(n) || t0(n)),
    code: "ski-rental",
    when: (t) => WEAK.has(t) || t === "gear-rental",
  },
  // Активний відпочинок: джипінг, квадроцикли, рафтинг, зіплайн, родельбан, кінні прогулянки (раньше — прокат,
  // екскурсії или атракціони). Джип-тури з типом car_rental — теж сюди (справжній прокат авто без цих слів —
  // «Прокат авто»).
  {
    test: (n) => ADVENTURE.test(n),
    code: "active",
    when: (t) => WEAK.has(t) || t === "excursions" || t === "gear-rental" || t === "rental",
  },
  // Паркінг без типа (bus_stop и т. п.); «Ринок … стоянка» (store) — не паркінг.
  { test: (n) => /паркінг|parking/i.test(n), code: "parking", when: (t) => t === undefined },
  {
    test: (n) => /колиб|kolyb|kolib/i.test(n),
    code: "kolyby",
    when: (t) =>
      t === "restaurants" ||
      t === "cafes" ||
      t === "fast-food" ||
      t === "bars" ||
      (WEAK.has(t) && t !== "stores"),
  },
  {
    test: (n) => BAR_NAME.test(n),
    code: "bars",
    when: (t) => t === "cafes" || (WEAK.has(t) && t !== "stores"),
  },
  {
    // Вілли латиницею й кирилицею («Villa Leku», «Вілла Прованс»); «Привілля» — не вілла (с начала слова).
    test: (n) =>
      /[сc]адиб|sadyb|котедж|хат[аи]|будин|cottage|chalet|шале/i.test(n) ||
      new RegExp(`(^|${NOT_LETTER})(вілл?[аиі]|вилл?[аы]|villa)`, "i").test(n),
    code: "sadyby",
    when: (t) => t === "hotels",
  },
  { test: (n) => RENTAL.test(n) && GEAR.test(n), code: "gear-rental", when: (t) => WEAK.has(t) },
  { test: (n) => RENTAL.test(n) && CAR.test(n), code: "rental", when: (t) => WEAK.has(t) },
  { test: (n) => CHAN.test(n), code: "chany", when: (t) => WEAK.has(t) || t === "spa" },
  // Вершини — для слабких і природних типів (natural_feature, hiking_area, tourist_attraction); не для магазинів.
  {
    test: (n) => PEAK.test(n),
    code: "peaks",
    when: (t) => t === undefined || t === "nature" || t === "sights" || t === "active",
  },
  {
    test: (n) => NATURE_NAME.test(n),
    code: "nature",
    when: (t) => WEAK.has(t) && t !== "stores",
  },
  {
    test: (n) => /джип|екскурс|excursion|jeep|похід|походи/i.test(n) || GUIDE.test(n),
    code: "excursions",
    when: (t) => WEAK.has(t),
  },
  {
    test: (n) => /луна[ -]парк|колесо огляду|атракціон/i.test(n),
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
    test: (n) => /шиномонтаж|вулканіз|\btires?\b/i.test(n),
    code: "car-service",
    when: (t) => WEAK.has(t) || t === "car-wash",
  },
  // «Мийка килимів» — не автомийка.
  {
    test: (n) => /автомий|мийка|car ?wash/i.test(n) && !/килим/i.test(n),
    code: "car-wash",
    when: (t) => WEAK.has(t),
  },
  { test: (n) => /перукар|барбер|barber|салон краси/i.test(n), code: "beauty", when: (t) => WEAK.has(t) },
  { test: (n) => /пральн|хімчист|laundry/i.test(n), code: "laundry", when: (t) => WEAK.has(t) },
  // Розваги за аудиторією: бар з більярдом/караоке — теж «для дорослих».
  {
    test: (n) => ADULT.test(n),
    code: "adult-fun",
    when: (t) => WEAK.has(t) || t === "cafes" || t === "bars" || t === "kids",
  },
  {
    // Только при типе Google (без типа «дитяч…» — садочки, школи, лікарні); табори, магазини, школи — не розвага.
    test: (n) =>
      /дитяч|для дітей|kids|батут|зоопарк/i.test(n) &&
      !/табір|camp|магазин|одяг|іграш|садок|школ|дюсш|бібліотек|поліклінік|лікарн|стоматолог/i.test(n),
    code: "kids",
    when: (t) => t !== undefined && WEAK.has(t) && t !== "stores",
  },
  { test: (n) => /трансфер|transfer/i.test(n), code: "taxi", when: (t) => t === undefined },
  { test: (n) => /аптек/i.test(n), code: "pharmacies", when: (t) => t === undefined },
  {
    test: (n) => /[сc]адиб|sadyb|котедж|відпочинок в/i.test(n),
    code: "sadyby",
    when: (t) => t === undefined,
  },
  // Прокат без уточнения и лыжные/вело-точки без типа: в регионе это прокат спорядження.
  {
    test: (n) => RENTAL.test(n) || /ski|лиж|лыж|bike|вело|enduro|ендуро/i.test(n),
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
  return undefined;
}

/**
 * Не заведение, а «метка» на карте: название — только название населённого пункта/курорта («БУКОВЕЛЬ ЯРЕМЧЕ»,
 * «Яремче») или платёжного бренда («Mastercard», «Visa») — такие точки пользователи Google ставят с любым типом.
 */
const NOT_A_VENUE =
  /^(((буковель|яремче|татарів|микуличин|поляниця|яблуниця|яблониця|яблоница|ворохта|bukovel|yaremche|vorokhta|tatariv|mykulychyn|polianytsia|yablunytsia|карпати)[\s,.-]*)+|mastercard|visa|приватбанк|monobank)$/i;
/**
 * Природа з назвою лише населеного пункту («Яремче» з natural_feature/park) — мітка. Без «Буковель»/«Карпати»: так
 * звуться й гора, й хребет.
 */
const NATURE_LABEL =
  /^((яремче|татарів|микуличин|поляниця|яблуниця|яблониця|яблоница|ворохта|yaremche|vorokhta|tatariv|mykulychyn|polianytsia|yablunytsia)[\s,.-]*)+$/i;
/** Поштомати (без персоналу, их сотни) засоряют карту — берём только відділення й пункти. */
const PARCEL_LOCKER = /поштомат|parcel ?locker/i;
/** Індекс Укрпошти в назві («Укрпошта 77344»). */
const UKRPOSHTA_INDEX = /(укрпошта|ukrposhta)\D{0,20}(\d{5})/i;
/** Область у назві відділення («… с. Соколівка, Львівська область»): частина назви до «обл.»/«область»/«oblast». */
const OBLAST = /([^,()]*?)\s*(обл\.|область|обл(?![а-яіїєґ])|oblast)/i;
/** Наша область у будь-якому написанні: «Івано-Франківська», «Ів.-Франківська», латинська I, «ІФ», «Франківська». */
const OUR_OBLAST = /франків|frankivsk|ivano|(^|[^а-яіїєґa-z])[іi]ф([^а-яіїєґa-z]|$)/i;

/**
 * Чуже відділення пошти: поштомат, індекс Укрпошти не нашого регіону (REGION_POSTCODE_PREFIXES) або інша область у
 * назві Нової пошти. Google ставить таким відділенням точку на однойменній вулиці в нашому пункті (адреса «вулиця
 * Грушевського, 78А, Пійло», а точка — у Микуличині), тож перевірка радіуса їх не відсіює.
 */
export function isForeignPost(name: string): boolean {
  if (PARCEL_LOCKER.test(name)) return true;
  const index = UKRPOSHTA_INDEX.exec(name)?.[2];
  if (index && !REGION_POSTCODE_PREFIXES.some((p) => index.startsWith(p))) return true;
  const oblast = OBLAST.exec(name);
  return !!oblast && !OUR_OBLAST.test(oblast[1] ?? "");
}
/** Дитячі табори (зміни на тиждень, не розвага для туриста) с типом playground. */
const CAMP = /табір|camp/i;
/**
 * Садочки, ясла, ДЮСШ і загальноосвітні школи (ЗОШ, «школа №», «школа І-ІІІ ступенів», «ліцей №», «гімназія №»,
 * опорний ліцей) — не для туриста, хоч Google і ставить їм tourist_attraction. Сади («Японський садок»), «Стара
 * гімназія», «Готель Ліцей», школи ремесел/лиж («Школа гончарства», лижна школа) сюди не потрапляють.
 */
const NOT_TOURIST_EDU =
  /дитячий садок|дитсадок|садочок|ясла|дюсш|спортивна школа|загальноосвітн|опорний ліцей|(ліцей|гімназія)\s*№|(^|[^а-яіїєґ])(днз|здо|зош)([^а-яіїєґ]|$)|школа\s*(№|n\s*\d|[іi]{1,3}(\s*-\s*[іi]{1,3})?\s+ступ)/i;

/**
 * Родові назви-мітки без імені власного: «Оглядовий майданчик», «Гойдалка», «Джерело», «Садиба», «Бар»… Користувачі
 * Google ставлять такі точки з будь-яким типом; у списку вони нерозрізненні — не імпортуються за будь-якого типу.
 * Порівняння — після labelKey (регістр, лапки, розділові знаки).
 */
const GENERIC_LABELS: ReadonlySet<string> = new Set([
  "оглядовий майданчик",
  "оглядова",
  "оглядова площадка",
  "оглядовий",
  "смотровая площадка",
  "відпочинок",
  "отдых",
  "отдих",
  "місце відпочинку",
  "місце для відпочинку",
  "місце для пікніка",
  "місце для пікніку",
  "місце для туристів",
  "зона відпочинку",
  "пікнік",
  "гойдалка",
  "качеля",
  "качели",
  "альтанка",
  "бесідка",
  "лавочка",
  "джерело",
  "криниця",
  "родник",
  "гора",
  "вершина",
  "водоспад",
  "панорама",
  "вид на гори",
  "краєвид",
  "гарний краєвид",
  "прокат",
  "садиба",
  "приватна садиба",
  "котедж",
  "бар",
  "кафе",
  "cafe",
  "café",
  "ресторан",
  "колиба",
  "магазин",
  "not",
]);

/** Ключ назви для порівняння: нижній регістр, без лапок і розділових знаків, одинарні пробіли. */
export function labelKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[«»"“”„'’ʼ`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Назва-мітка: родова (GENERIC_LABELS) або без імені — менше двох літер («1», «№ 5», «Ж»). */
export function isGenericLabel(name: string): boolean {
  const key = labelKey(name);
  return GENERIC_LABELS.has(key) || (key.match(/\p{L}/gu)?.length ?? 0) < 2;
}

/**
 * Слабкі типи Google, яким у таблиці дано не «слабку» категорію (hiking_area → nature): для правил за назвою вони —
 * як active (назва уточнює: чан, квадроцикли, водоспад, вершина), без уточнення — категорія за таблицею.
 */
const WEAK_SOURCE_TYPES: ReadonlySet<string> = new Set(["hiking_area"]);

/** Категорія місця й звідки вона: `byName` — уточнена за назвою; `type` — тип Google, що дав категорію за таблицею. */
export type Classified = { code: string; byName: boolean; type?: string };

/** Класифікація місця: типи, мітки, правила за назвою (mapCategory — лише код). Нет — undefined. */
export function classifyPlace(
  p: Pick<GooglePlace, "primaryType" | "types">,
  name: string,
): Classified | undefined {
  const trimmed = name.trim();
  if (isGenericLabel(trimmed)) return undefined;
  const { code: byType, type } = categoryByTypes(p);
  // Метка «только пункт/бренд» — лишь при слабом типе: «Буковель» с ski_resort или «Карпати» с hotel — заведения.
  if (LABEL_TYPES.has(byType) && NOT_A_VENUE.test(trimmed)) return undefined;
  // Природа з назвою лише пункту («Яремче» з natural_feature/park) — теж мітка, а не водоспад чи гора.
  if (byType === "nature" && NATURE_LABEL.test(trimmed)) return undefined;
  const ruleKey = type && WEAK_SOURCE_TYPES.has(type) ? "active" : byType;
  // Совпавшее правило, даже если дало ту же категорию (джип-тур при hiking_area → active), — категория по названию.
  const refined = refineByName(trimmed, ruleKey);
  const byName = refined !== undefined && (refined !== byType || ruleKey !== byType);
  const code = refined ?? byType;
  // Слабый тип без уточнения по названию: садочок/школа — не заведение для туриста.
  if (!byName && LABEL_TYPES.has(byType) && NOT_TOURIST_EDU.test(trimmed)) return undefined;
  if (!code) return undefined;
  if (code === "post" && isForeignPost(trimmed)) return undefined;
  if ((code === "kids" || code === "entertainment") && CAMP.test(trimmed)) return undefined;
  return { code, byName, ...(type ? { type } : {}) };
}

/** Наша подкатегория места: primaryType, затем types по порядку, затем уточнение по названию. Нет — undefined. */
export function mapCategory(p: Pick<GooglePlace, "primaryType" | "types">, name: string): string | undefined {
  return classifyPlace(p, name)?.code;
}

/** Слабые категории по типам, при которых название-метка (NOT_A_VENUE) значит «не заведение»; без active. */
const LABEL_TYPES = new Set([...WEAK].filter((t) => t !== "active"));

function categoryByTypes(p: Pick<GooglePlace, "primaryType" | "types">): {
  code: string | undefined;
  type?: string;
} {
  for (const t of [p.primaryType, ...(p.types ?? [])]) {
    const code = t ? categoryOfType(t) : undefined;
    if (code) return { code, type: t };
  }
  return { code: undefined };
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

/**
 * Пункт места: ближайший пункт, в чей радиус попадает точка; вне всех радиусов — зона поиска (SEARCH_ZONES), куда
 * попадает точка, и ближайший к точке пункт из пунктов этой зоны (по центру). Вне пунктов и зон — undefined.
 */
export function localityOf<L extends ImportLocality>(
  at: LonLat,
  localities: readonly L[],
  zones: readonly SearchZone[] = [],
): L | undefined {
  const own = nearestLocality(at, localities);
  if (own) return own;
  let best: { l: L; d: number } | undefined;
  for (const z of zones) {
    if (haversineMeters(at, z.at) > z.radiusM) continue;
    for (const l of localities) {
      if (!z.localities.includes(l.code)) continue;
      const d = haversineMeters(at, l.at);
      if (!best || d < best.d) best = { l, d };
    }
  }
  return best?.l;
}

/** Типи частин адреси Google з назвою населеного пункту (за пріоритетом). */
const LOCALITY_COMPONENT_TYPES = ["locality", "sublocality", "sublocality_level_1", "neighborhood"] as const;
/**
 * Наскільки далеко від центру пункту (у його радіусах) ще віримо адресі Google: Микуличин витягнутий на ~10 км, а
 * «Яремче» в адресі Буковеля (13 км) — назва громади, не пункт.
 */
const GOOGLE_LOCALITY_MAX_RADII = 2;

const localityKey = (s: string) => labelKey(s.replace(/\(.*?\)/g, ""));

/**
 * Пункт за адресою Google (addressComponents: locality, потім sublocality/neighborhood), якщо назва збігається з
 * пунктом регіону (назва, англійська назва, LOCALITY_ALIASES — Буковель → Поляниця) і точка не далі
 * GOOGLE_LOCALITY_MAX_RADII радіусів від його центру. Немає частин адреси чи збігу — undefined.
 */
export function googleLocality<L extends ImportLocality>(
  p: Pick<GooglePlace, "addressComponents">,
  at: LonLat,
  localities: readonly L[],
): L | undefined {
  const comps = p.addressComponents ?? [];
  for (const kind of LOCALITY_COMPONENT_TYPES) {
    for (const c of comps) {
      if (!c.types?.includes(kind)) continue;
      const texts = [c.longText, c.shortText].filter((t): t is string => !!t).map(localityKey);
      for (const l of localities) {
        const names = [l.name.uk, l.name.en ?? "", ...(LOCALITY_ALIASES[l.code] ?? [])]
          .filter(Boolean)
          .map(localityKey);
        if (!texts.some((t) => names.includes(t))) continue;
        if (haversineMeters(at, l.at) <= GOOGLE_LOCALITY_MAX_RADII * l.radiusM) return l;
      }
    }
  }
  return undefined;
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

// --- дополнительные категории ---

/** Типы и названия атракціонів «для всіх»: основная entertainment, дополнительно — «Для дітей» и «Активний відпочинок». */
const ATTRACTION_TYPES = new Set(["water_park", "amusement_park", "ferris_wheel", "roller_coaster"]);
const ATTRACTION = /колесо огляду|аквапарк|атракціон|луна[ -]парк|парк розваг/i;
const QUAD_JEEP = /джип|jeep|квадро|kvadro|quadro|багі|баггі|buggy|\batv\b|позашлях|off-?road|снігох|снегох/i;
/** Нічні клуби й кальянні серед барів — ще й «Для дорослих». */
const ADULT_BAR_TYPES = new Set(["night_club", "hookah_bar"]);
const ADULT_BAR = /кальян|hookah|shisha|нічн|night/i;
const EXCURSION = /екскурс|excursion|тур(и|ів)?([^а-яіїєґa-z]|$)/i;

/**
 * Дополнительные категории места (place_extra_categories): место показывается и в этих разделах. Коды —
 * подкатегории или корень («help» — «Халепа?»). Основная категория в список не входит.
 */
export function extraCategories(
  code: string,
  p: Pick<GooglePlace, "primaryType" | "types">,
  name: string,
): string[] {
  const out = new Set<string>();
  const types = [p.primaryType, ...(p.types ?? [])];
  if (
    code === "entertainment" &&
    (types.some((t) => t && ATTRACTION_TYPES.has(t)) || ATTRACTION.test(name))
  ) {
    out.add("kids");
    out.add("active");
  }
  if (code === "gear-rental" || code === "ski-resorts" || code === "ski-lifts") out.add("active");
  if (code === "ski-rental") out.add("gear-rental");
  const byType = categoryByTypes(p).code;
  if (code === "active" && QUAD_JEEP.test(name)) {
    out.add("adult-fun");
    // Прокат квадроциклів/джипів — и у «Прокаті спорядження»; Google сам назвав місце прокатом (car_rental) — теж.
    if (RENTAL.test(name) || byType === "rental") out.add("gear-rental");
  }
  if (code === "bars" && (types.some((t) => t && ADULT_BAR_TYPES.has(t)) || ADULT_BAR.test(name)))
    out.add("adult-fun");
  // Таксі, що возить і на екскурсії (Google: travel_agency або «екскурсії» в назві).
  if (code === "taxi" && (byType === "excursions" || EXCURSION.test(name))) out.add("excursions");
  if (code === "car-service" || code === "tow-trucks") out.add("help");
  out.delete(code);
  return [...out];
}

/** Паркінг — только с отзывами (платные, охраняемые, у атракціонів), не каждая обочина с меткой. */
export const PARKING_MIN_REVIEWS = 5;

/**
 * Поріг відгуків для слабких «природних» типів без упізнаної назви (hiking_area, park): Google ставить їх альтанкам,
 * лавочкам, «Вид на гори», лісництвам. tourist_attraction сюди не входить — під ним пам'ятники й церкви з 0–2
 * відгуками; там відсіюють лише родові мітки (isGenericLabel).
 */
export const WEAK_MIN_REVIEWS = PARKING_MIN_REVIEWS;
const REVIEWED_TYPES: ReadonlySet<string> = new Set(["hiking_area", "park"]);
/** Назва природного об'єкта, вершини чи парку — місце впізнане, поріг відгуків не потрібен. */
const RECOGNIZED_OUTDOOR = new RegExp(
  `${NATURE_NAME.source}|${PEAK.source}|парк|park|сквер|ботаніч|дендро|заповід|урочищ`,
  "i",
);

/**
 * Суфікс запису типу номера Booking: « - Double Room», « - Two-Bedroom Villa», « - Vacation Home» (латиницею, у
 * кінці назви). Без суфікса назва не змінюється.
 */
const ROOM_SUFFIX =
  /\s+[-–—]\s+(?=[A-Za-z0-9 '’&(),./+-]*\b(Rooms?|House|Villa|Apartments?|Suite|Studio|Townhouse|Chalet|Vacation Home|Cottage|Bungalow|Cabin|Bedroom|Lodge|Loft|Dormitory|Bed)\b)[A-Za-z0-9 '’&(),./+-]+$/;

export function stripRoomSuffix(name: string): string {
  const stripped = name.replace(ROOM_SUFFIX, "").trim();
  return stripped || name;
}

/** Радіус, у якому однакові назви — одне місце (свёртка дублів, dedupePlaces). */
export const DUPLICATE_RADIUS_M = 50;

/**
 * Свёртка дублів: однаковий ключ назви (labelKey) у радіусі DUPLICATE_RADIUS_M — одне місце, якщо категорія та сама
 * або один із записів — тип номера Booking (roomListing; основний запис може бути «Готелі», номер — «Садиби»).
 * Залишається запис без суфікса Booking, потім з більшою кількістю відгуків, потім з меншим id (стабільно між
 * прогонами). Повертає залишені місця (у вхідному порядку) і id відкинутих.
 */
export function dedupePlaces(places: readonly MappedPlace[]): {
  kept: MappedPlace[];
  duplicateIds: string[];
} {
  const rank = [...places].sort(
    (a, b) =>
      Number(!!a.roomListing) - Number(!!b.roomListing) ||
      (b.ratingCount ?? 0) - (a.ratingCount ?? 0) ||
      a.googlePlaceId.localeCompare(b.googlePlaceId),
  );
  const byKey = new Map<string, MappedPlace[]>();
  const dropped = new Set<string>();
  for (const p of rank) {
    const key = labelKey(p.name);
    const group = byKey.get(key) ?? [];
    const twin = group.find(
      (q) =>
        haversineMeters(p.at, q.at) <= DUPLICATE_RADIUS_M &&
        (q.categoryCode === p.categoryCode || !!p.roomListing || !!q.roomListing),
    );
    if (twin) {
      dropped.add(p.googlePlaceId);
      continue;
    }
    group.push(p);
    byKey.set(key, group);
  }
  return {
    kept: places.filter((p) => !dropped.has(p.googlePlaceId)),
    duplicateIds: places.filter((p) => dropped.has(p.googlePlaceId)).map((p) => p.googlePlaceId),
  };
}

// --- теги ---

/** Удобство Google (place_enrichments.google.amenities) → код тега (SEED_TAGS). */
const AMENITY_TAGS: Readonly<Record<string, string>> = {
  good_for_children: "kids",
  kids_menu: "kids",
  dogs_allowed: "pets",
  parking_free: "parking",
  parking_paid: "parking",
  vegetarian: "vegetarian",
};
/** Під дахом — «У дощ»: музеї, SPA, чани й сауни, заклади харчування. */
const RAINY_DAY_CATEGORIES: ReadonlySet<string> = new Set([
  "museums",
  "spa",
  "chany",
  "cafes",
  "restaurants",
  "kolyby",
  "bars",
  "fast-food",
]);
/** Розваги під дахом (категорії розваг змішані: зіплайн і боулінг — обидва «Для дорослих»): за назвою. */
const INDOOR_FUN_CATEGORIES: ReadonlySet<string> = new Set(["entertainment", "adult-fun", "kids"]);
const INDOOR_FUN =
  /боулінг|bowling|більярд|billiard|караоке|karaoke|квест|quest|escape|кінотеатр|кіно|cinema|аквапарк|басейн|ігров|game|аркад|arcade|батутн|лазертаг|музей/i;

/**
 * Теги місця за категорією й удобствами Google (place_enrichments.google.amenities): з дітьми, з тваринами,
 * паркування, вегетаріанське меню, «У дощ» (категорії під дахом; розваги — лише криті за назвою). Коди — з SEED_TAGS;
 * нових тегів не вводить. Сортовано, без повторів.
 */
export function tagsForPlace(category: string, amenities: readonly string[], name = ""): string[] {
  const out = new Set<string>();
  for (const a of amenities) {
    const tag = AMENITY_TAGS[a];
    if (tag) out.add(tag);
  }
  if (RAINY_DAY_CATEGORIES.has(category) || (INDOOR_FUN_CATEGORIES.has(category) && INDOOR_FUN.test(name)))
    out.add("rainy-day");
  return [...out].sort();
}

// --- место целиком ---

export type MappedPlace = {
  googlePlaceId: string;
  categoryCode: string;
  /** Дополнительные категории (extraCategories): место видно и в этих разделах. */
  extraCategoryCodes: string[];
  /** Код населённого пункта; "" — место вне пунктов (вершина, водоспад у точечного импорта), locality_id = null. */
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
  /** Запис типу номера Booking (суфікс « - Double Room» відкинуто) — при свёртці дублів поступається основному. */
  roomListing?: true;
};

export type SkipReason =
  | "closed_permanently"
  | "invalid_id"
  | "no_location"
  | "outside_radius"
  | "no_category"
  | "no_name"
  /** Правило не проверить: в ответе нет нужного поля (паркинг без числа отзывов при маске pro). */
  | "unverified"
  /** Дубль іншого місця прогону (dedupePlaces): однакова назва в радіусі 50 м. */
  | "duplicate";

/**
 * Описание места: краткое описание Google (если есть) или «<тип> у <пункті>.», плюс источник. Тип — Google
 * (primaryTypeDisplayName), а без него — `fallbackType` (название нашей категории; mapPlace передаёт его и тогда, когда
 * категория определена по названию).
 */
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
  /** Категория задана заранее (точечный импорт, targeted.ts) — типы и название Google её не меняют. */
  categoryOverride?: string,
  opts: {
    /** Дополнительные зоны поиска: место вне кругов пунктов, но в зоне — к ближайшему пункту зоны (localityOf). */
    zones?: readonly SearchZone[];
    /**
     * Ответ Google с числом отзывов (маска не pro). Нет — паркинг не проверить по PARKING_MIN_REVIEWS: он
     * пропускается как unverified (не «не наш»: уже импортированный такой паркинг не архивируется).
     */
    ratingsKnown?: boolean;
  } = {},
): { ok: true; place: MappedPlace } | { ok: false; reason: SkipReason } {
  const zones = opts.zones ?? [];
  if (p.businessStatus === "CLOSED_PERMANENTLY") return { ok: false, reason: "closed_permanently" };
  const rawName = p.displayName?.text?.trim();
  if (typeof p.id !== "string" || !GOOGLE_PLACE_ID.test(p.id)) return { ok: false, reason: "invalid_id" };
  if (!rawName) return { ok: false, reason: "no_name" };
  const lat = p.location?.latitude;
  const lon = p.location?.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return { ok: false, reason: "no_location" };
  const at = { lon, lat };
  const byDistance = localityOf(at, localities, zones);
  if (!byDistance) return { ok: false, reason: "outside_radius" };
  // Адреса Google главнее відстані до центру (межі Микуличин/Татарів/Ворохта); відстань — запасний варіант.
  const locality = googleLocality(p, at, localities) ?? byDistance;
  // Записи типів номерів Booking («Садиба X - Double Room»): суфікс відкидається, дублі згортає collect.
  const name = stripRoomSuffix(rawName);
  const roomListing = name !== rawName;
  const classified: Classified | undefined = categoryOverride
    ? { code: categoryOverride, byName: false }
    : classifyPlace(p, name);
  if (!classified) return { ok: false, reason: "no_category" };
  const categoryCode = classified.code;
  if (categoryCode === "parking" && opts.ratingsKnown === false) return { ok: false, reason: "unverified" };
  if (categoryCode === "parking" && (p.userRatingCount ?? 0) < PARKING_MIN_REVIEWS)
    return { ok: false, reason: "no_category" };
  // «Зона для прогулянок»/«Парк» без упізнаної назви (альтанки, лавочки, «Під лісом») — лише з відгуками.
  if (
    !categoryOverride &&
    !classified.byName &&
    classified.type &&
    REVIEWED_TYPES.has(classified.type) &&
    !RECOGNIZED_OUTDOOR.test(name)
  ) {
    if (opts.ratingsKnown === false) return { ok: false, reason: "unverified" };
    if ((p.userRatingCount ?? 0) < WEAK_MIN_REVIEWS) return { ok: false, reason: "no_category" };
  }
  return {
    ok: true,
    place: {
      googlePlaceId: p.id,
      categoryCode,
      extraCategoryCodes: extraCategories(categoryCode, p, name),
      localityCode: locality.code,
      name,
      // Категорія за назвою — у шаблоні опису її назва, а не тип Google («Генеральний підрядник» у чанів).
      description: describe(
        classified.byName ? { ...p, primaryTypeDisplayName: undefined } : p,
        locality,
        categoryNames[categoryCode] ?? "Місце",
      ),
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
      ...(roomListing ? { roomListing: true as const } : {}),
    },
  };
}
