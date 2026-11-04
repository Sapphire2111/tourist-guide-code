// Настройки импорта мест из Google Maps (places:import-google): населённые пункты пилота D-01 с радиусом поиска,
// поисковые запросы и категории, которых нет в демо-seed. Координаты центров — по карте (WGS 84).
import type { LonLat } from "../db/index.js";

type Text = { uk: string; en?: string };

export type ImportLocality = {
  /** Код localities (как в seed: Буковель — посёлок Поляниця). */
  code: string;
  name: Text;
  /** «у Яремчі» — для автоописания места. */
  inUk: string;
  at: LonLat;
  /** Радиус пункта, м: дальше — место не берётся. */
  radiusM: number;
};

export const IMPORT_LOCALITIES: readonly ImportLocality[] = [
  {
    code: "yaremche",
    name: { uk: "Яремче", en: "Yaremche" },
    inUk: "у Яремчі",
    at: { lon: 24.5547, lat: 48.4505 },
    radiusM: 4500,
  },
  {
    code: "tatariv",
    name: { uk: "Татарів", en: "Tatariv" },
    inUk: "у Татарові",
    at: { lon: 24.5735, lat: 48.3497 },
    radiusM: 3000,
  },
  {
    code: "mykulychyn",
    name: { uk: "Микуличин", en: "Mykulychyn" },
    inUk: "у Микуличині",
    at: { lon: 24.598, lat: 48.399 },
    radiusM: 4000,
  },
  {
    code: "polianytsia",
    name: { uk: "Поляниця (Буковель)", en: "Polianytsia (Bukovel)" },
    inUk: "у Буковелі (Поляниця)",
    at: { lon: 24.41, lat: 48.36 },
    radiusM: 5000,
  },
  {
    code: "yablunytsia",
    name: { uk: "Яблуниця", en: "Yablunytsia" },
    inUk: "в Яблуниці",
    at: { lon: 24.47, lat: 48.302 },
    radiusM: 3500,
  },
  {
    // Ворохта (Надвірнянський р-н): до Татарова ~7,3 км, до Яблуниці ~7,2 км — круги почти не пересекаются,
    // общие точки достаются ближайшему пункту (nearestLocality).
    code: "vorokhta",
    name: { uk: "Ворохта", en: "Vorokhta" },
    inUk: "у Ворохті",
    at: { lon: 24.566, lat: 48.285 },
    radiusM: 3500,
  },
];

/**
 * Дополнительная зона поиска (04.11.2026): часть пункта или участок дороги между пунктами вне их кругов. Своего
 * населённого пункта у зоны нет: место в зоне (и вне кругов пунктов) относится к ближайшему по расстоянию до центра
 * пункту из `localities`. Координаты — по Google Places (Дора, урочище Женець, полонина Залім, Н09, Р24).
 */
export type SearchZone = {
  code: string;
  /** Для отчёта: что покрывает зона. */
  label: string;
  at: LonLat;
  radiusM: number;
  /** Коды пунктов, к которым относятся места зоны (ближайший по центру). */
  localities: readonly string[];
};

export const SEARCH_ZONES: readonly SearchZone[] = [
  {
    // Північ Яремча: Дора за колом Яремча (Свободи 22Б — «Нова пошта №1» за 4,8 км від центру).
    code: "dora",
    label: "Яремче: північ Дори (вул. Свободи до Деліятина)",
    at: { lon: 24.59, lat: 48.485 },
    radiusM: 2000,
    localities: ["yaremche"],
  },
  {
    // Урочище Женець (Татарів) уздовж потоку Женець до полонини Залім і стежки на Женецький Гук.
    code: "zhenets",
    label: "Татарів: урочище Женець, полонина Залім",
    at: { lon: 24.53, lat: 48.378 },
    radiusM: 2000,
    localities: ["tatariv"],
  },
  {
    // Н09 між колами Татарова й Яблуниці (~2,5 км дороги без пошуку; Магурки).
    code: "tatariv-yablunytsia",
    label: "Н09 Татарів — Яблуниця",
    at: { lon: 24.525, lat: 48.327 },
    radiusM: 2000,
    localities: ["tatariv", "yablunytsia"],
  },
  {
    // Р24 між колами Татарова й Ворохти (~0,7 км; вул. Вербівська).
    code: "tatariv-vorokhta",
    label: "Р24 Татарів — Ворохта",
    at: { lon: 24.575, lat: 48.318 },
    radiusM: 1500,
    localities: ["tatariv", "vorokhta"],
  },
];

/**
 * Поштові індекси регіону (перші цифри): Яремчанська громада 785xx, Косів 786xx. Google ставить відділенням
 * Укрпошти з інших областей точку на однойменній вулиці в нашому пункті («Укрпошта 77344», «вулиця Грушевського,
 * 78А, Пійло» — точка в Микуличині); індекс у назві видає чуже відділення.
 */
export const REGION_POSTCODE_PREFIXES: readonly string[] = ["785", "786"];

/**
 * Пункты точечного импорта (--queries-file), без широкого поиска по IMPORT_QUERIES: Косів — ринок, музеї, Шешори
 * й Пістинь поруч. Заводятся writer'ом так же, как пункты пилота (ON CONFLICT DO NOTHING по коду).
 */
export const TARGETED_LOCALITIES: readonly ImportLocality[] = [
  {
    code: "kosiv",
    name: { uk: "Косів", en: "Kosiv" },
    inUk: "у Косові",
    at: { lon: 25.0952, lat: 48.3117 },
    radiusM: 4000,
  },
];

/**
 * Поисковые запросы Text Search по каждому пункту. Категорию места определяет не запрос, а типы Google (mapping.ts):
 * запрос лишь находит кандидатов, поэтому один и тот же объект из разных запросов — одна запись (дедуп по id).
 */
export const IMPORT_QUERIES: readonly string[] = [
  // Житло
  "готель",
  "садиба",
  "котедж",
  "хостел",
  // Їжа
  "ресторан",
  "кафе",
  "колиба",
  "кав'ярня",
  "фастфуд",
  "McDonald's",
  "піцерія",
  "бар",
  // Покупки
  "супермаркет",
  "продуктовий магазин",
  "сувеніри",
  "ринок",
  "магазин",
  // Халепа
  "аптека",
  "лікарня",
  "банкомат",
  "банк",
  "СТО",
  // Транспорт
  "АЗС",
  "зарядна станція для електромобілів",
  "прокат авто",
  "таксі",
  // Розваги й активності
  "прокат лиж",
  "прокат велосипедів",
  "прокат квадроциклів",
  "музей",
  "екскурсії",
  "розваги",
  "SPA",
  "чани",
  "сауна",
  // «Для дітей» и «Для дорослих» (03.11.2026)
  "дитячий майданчик",
  "дитячі розваги",
  "зоопарк",
  "аквапарк",
  "боулінг",
  "більярд",
  "караоке",
  "квест кімната",
  "картинг",
  "пейнтбол",
  "нічний клуб",
  // Сервіси (03.11.2026)
  "ремонт телефонів",
  "ремонт техніки",
  "мобільний зв'язок",
  "шиномонтаж",
  "автомийка",
  "Нова пошта",
  "Укрпошта",
  "пральня",
  "перукарня",
  // Авто, активний відпочинок, гірські лижі (03.11.2026)
  "паркінг",
  "евакуатор",
  "джипінг",
  "рафтинг",
  "зіплайн",
  "конні прогулянки",
  "гірськолижний курорт",
  "сервіс лиж",
  "лижна школа",
  "прокат сноубордів",
  // Природа й пам'ятки
  "водоспад",
  "оглядовий майданчик",
  "пам'ятки",
  "визначні місця",
];

/**
 * Подкатегории, которых нет в демо-seed (seed-catalog.ts), а у Google такие места есть. Импорт добавляет их
 * (ON CONFLICT DO NOTHING по коду — правки админки не трогает) под корневой раздел `parent`.
 */
export const IMPORT_EXTRA_CATEGORIES: readonly { code: string; parent: string; name: Text; icon: string }[] =
  [
    { code: "fast-food", parent: "eat", name: { uk: "Фастфуд", en: "Fast food" }, icon: "burger" },
    { code: "groceries", parent: "shop", name: { uk: "Продукти", en: "Groceries" }, icon: "basket" },
    { code: "stores", parent: "shop", name: { uk: "Магазини", en: "Stores" }, icon: "store" },
    {
      code: "atm",
      parent: "help",
      name: { uk: "Банкомати й банки", en: "ATMs and banks" },
      icon: "banknote",
    },
    { code: "fuel", parent: "transfer", name: { uk: "АЗС", en: "Gas stations" }, icon: "fuel" },
    { code: "parking", parent: "transfer", name: { uk: "Паркінги", en: "Parking" }, icon: "parking" },
    { code: "tow-trucks", parent: "transfer", name: { uk: "Евакуатори", en: "Tow trucks" }, icon: "truck" },
    {
      code: "ev-charging",
      parent: "transfer",
      name: { uk: "Електрозарядки", en: "EV charging" },
      icon: "plug",
    },
    {
      code: "gear-rental",
      parent: "fun",
      name: { uk: "Прокат спорядження", en: "Gear rental" },
      icon: "bike",
    },
    {
      code: "entertainment",
      parent: "fun",
      name: { uk: "Атракціони та розваги", en: "Attractions" },
      icon: "ticket",
    },
    { code: "sights", parent: "nearby", name: { uk: "Пам'ятки", en: "Sights" }, icon: "landmark" },
    // Развлечения по аудитории (03.11.2026); entertainment остаётся для аттракционов «для всех»
    // (зиплайн, родельбан, кино) — уже импортированные места переразмечаются при следующем импорте.
    { code: "kids", parent: "fun", name: { uk: "Для дітей", en: "For kids" }, icon: "baby" },
    { code: "adult-fun", parent: "fun", name: { uk: "Для дорослих", en: "For adults" }, icon: "dice" },
    // Раздел «Гірські лижі» (0020)
    {
      code: "ski-resorts",
      parent: "ski",
      name: { uk: "Гірськолижні курорти й траси", en: "Ski resorts and slopes" },
      icon: "mountain-snow",
    },
    { code: "ski-lifts", parent: "ski", name: { uk: "Підйомники", en: "Ski lifts" }, icon: "cable-car" },
    {
      code: "ski-rental",
      parent: "ski",
      name: { uk: "Прокат лиж і сноубордів", en: "Ski and snowboard rental" },
      icon: "snowflake",
    },
    { code: "ski-service", parent: "ski", name: { uk: "Сервіс лиж", en: "Ski service" }, icon: "wrench" },
    {
      code: "ski-schools",
      parent: "ski",
      name: { uk: "Лижні школи й інструктори", en: "Ski schools and instructors" },
      icon: "graduation-cap",
    },
    {
      code: "ski-shops",
      parent: "ski",
      name: { uk: "Магазини лижного спорядження", en: "Ski gear shops" },
      icon: "shopping-bag",
    },
    // Раздел «Сервіси» (0020)
    {
      code: "tech-repair",
      parent: "services",
      name: { uk: "Ремонт техніки", en: "Electronics repair" },
      icon: "wrench",
    },
    {
      code: "mobile",
      parent: "services",
      name: { uk: "Мобільний зв'язок", en: "Mobile operators" },
      icon: "smartphone",
    },
    { code: "car-wash", parent: "transfer", name: { uk: "Автомийки", en: "Car wash" }, icon: "droplets" },
    {
      code: "post",
      parent: "services",
      name: { uk: "Пошта й доставка", en: "Post and delivery" },
      icon: "mail",
    },
    {
      code: "laundry",
      parent: "services",
      name: { uk: "Пральні й хімчистки", en: "Laundry and dry cleaning" },
      icon: "shirt",
    },
    {
      code: "beauty",
      parent: "services",
      name: { uk: "Перукарні й салони краси", en: "Hair and beauty salons" },
      icon: "scissors",
    },
  ];
