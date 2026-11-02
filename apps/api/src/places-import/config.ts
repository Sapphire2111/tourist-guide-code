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
  ];
