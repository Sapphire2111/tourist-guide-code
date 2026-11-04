// Демо-каталог (блок 3, D-53: демо-контент готовит агент — вымышленные заведения, без реальных ПДн; D-01 — пилот
// от Яремче до Яблуниці). Категории — разделы главной C02 (ТЗ §4.2) с подкатегориями, теги, населённые пункты,
// 14 мест тестового региона с графиком и одно место региона Б (для проверок изоляции). Идемпотентно: детерминированные
// id (seedUuid) и ON CONFLICT DO NOTHING — повторный запуск ничего не меняет и не перезаписывает правки админки.
// Контакты — тестовые: телефоны из зарезервированного диапазона +380000000…, сайты в домене example.
import {
  point,
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
  type HomeSection,
  type LocalityKind,
  type LonLat,
  type TagGroup,
} from "../db/index.js";
import { IMPORT_EXTRA_CATEGORIES } from "../places-import/config.js";
import { seedUuid } from "./ids.js";
import type { SeedRegionKey } from "./seed.js";

type Text = { uk: string; en?: string };

/** Корневые категории — кнопки главной (home_section), подкатегории — по коду. */
export const SEED_CATEGORIES: readonly {
  code: string;
  name: Text;
  icon: string;
  home: HomeSection;
  /** Порядок корня; без него — по позиции (i × 10). Разделы после 0020 — между старыми (импорт заводит их в БД). */
  sortOrder?: number;
  children: readonly { code: string; name: Text; icon: string }[];
}[] = [
  {
    code: "stay",
    name: { uk: "Де жити", en: "Where to stay" },
    icon: "bed",
    home: "stay",
    children: [
      { code: "hotels", name: { uk: "Готелі", en: "Hotels" }, icon: "hotel" },
      { code: "sadyby", name: { uk: "Садиби", en: "Guest houses" }, icon: "house" },
    ],
  },
  {
    code: "eat",
    name: { uk: "Де поїсти", en: "Where to eat" },
    icon: "utensils",
    home: "eat",
    children: [
      { code: "cafes", name: { uk: "Кафе", en: "Cafes" }, icon: "coffee" },
      { code: "restaurants", name: { uk: "Ресторани", en: "Restaurants" }, icon: "utensils" },
      { code: "kolyby", name: { uk: "Колиби", en: "Kolyba huts" }, icon: "flame" },
    ],
  },
  {
    code: "shop",
    name: { uk: "Де купити", en: "Where to shop" },
    icon: "shopping-bag",
    home: "shop",
    children: [
      { code: "souvenirs", name: { uk: "Сувеніри", en: "Souvenirs" }, icon: "gift" },
      { code: "markets", name: { uk: "Ринки", en: "Markets" }, icon: "store" },
    ],
  },
  {
    code: "relax",
    name: { uk: "Релакс", en: "Relax" },
    icon: "spa",
    home: "relax",
    children: [
      { code: "chany", name: { uk: "Чани та сауни", en: "Hot tubs and saunas" }, icon: "bath" },
      { code: "spa", name: { uk: "SPA", en: "SPA" }, icon: "spa" },
    ],
  },
  {
    code: "fun",
    name: { uk: "Розваги", en: "Fun" },
    icon: "ticket",
    home: "fun",
    children: [
      { code: "excursions", name: { uk: "Екскурсії", en: "Excursions" }, icon: "route" },
      { code: "museums", name: { uk: "Музеї", en: "Museums" }, icon: "landmark" },
      { code: "active", name: { uk: "Активний відпочинок", en: "Outdoor activities" }, icon: "mountain" },
    ],
  },
  {
    // Подкатегории (курорти, підйомники, прокат, сервіс, школи, магазини) заводит импорт мест.
    code: "ski",
    name: { uk: "Гірські лижі", en: "Skiing" },
    icon: "mountain-snow",
    home: "ski",
    sortOrder: 45,
    children: [],
  },
  {
    code: "nearby",
    name: { uk: "Що поруч", en: "Nearby" },
    icon: "map-pin",
    home: "nearby",
    children: [{ code: "nature", name: { uk: "Пам'ятки природи", en: "Nature sights" }, icon: "trees" }],
  },
  {
    // «Авто» (до 03.11.2026 — «Трансфер»; код прежний — ссылки и home_section не ломаются).
    code: "transfer",
    name: { uk: "Авто", en: "Car" },
    icon: "car",
    home: "transfer",
    children: [
      { code: "taxi", name: { uk: "Таксі", en: "Taxi" }, icon: "taxi" },
      { code: "rental", name: { uk: "Прокат авто", en: "Car rental" }, icon: "car" },
      { code: "car-service", name: { uk: "СТО й шиномонтаж", en: "Car service and tyres" }, icon: "wrench" },
    ],
  },
  {
    // Подкатегории (ремонт техніки, зв'язок, автомийки…) заводит импорт мест из Google (IMPORT_EXTRA_CATEGORIES).
    code: "services",
    name: { uk: "Послуги", en: "Services" },
    icon: "wrench",
    home: "services",
    sortOrder: 65,
    children: [],
  },
  {
    code: "help",
    name: { uk: "Халепа?", en: "Trouble?" },
    icon: "alert",
    home: "help",
    children: [
      { code: "pharmacies", name: { uk: "Аптеки", en: "Pharmacies" }, icon: "pill" },
      { code: "hospitals", name: { uk: "Лікарні", en: "Hospitals" }, icon: "hospital" },
    ],
  },
];

/**
 * Подкатегории импорта (IMPORT_EXTRA_CATEGORIES), которые seed заводит сразу, без прогона импорта: «Вершини» (места —
 * peaks:sync и правило импорта по названию) и «Бари». Вставка — ON CONFLICT DO NOTHING по любому ключу, в т. ч.
 * (region_id, code): категория, уже заведённая вручную или импортом (staging: peaks), не дублируется и не меняется.
 */
export const SEED_IMPORT_CATEGORY_CODES: readonly string[] = ["peaks", "bars"];

export const SEED_TAGS: readonly { code: string; name: Text; group: TagGroup }[] = [
  { code: "kids", name: { uk: "З дітьми", en: "Kids friendly" }, group: "audience" },
  { code: "pets", name: { uk: "З тваринами", en: "Pets allowed" }, group: "audience" },
  { code: "parking", name: { uk: "Паркування", en: "Parking" }, group: "amenity" },
  { code: "wifi", name: { uk: "Wi-Fi", en: "Wi-Fi" }, group: "amenity" },
  { code: "hutsul-cuisine", name: { uk: "Гуцульська кухня", en: "Hutsul cuisine" }, group: "cuisine" },
  { code: "vegetarian", name: { uk: "Вегетаріанське меню", en: "Vegetarian menu" }, group: "cuisine" },
  { code: "winter", name: { uk: "Зима", en: "Winter" }, group: "season" },
  { code: "summer", name: { uk: "Літо", en: "Summer" }, group: "season" },
  { code: "rainy-day", name: { uk: "У дощ", en: "Rainy day" }, group: "weather" },
];

/** Населённые пункты D-01 (координаты центров — приблизительные). */
export const SEED_LOCALITIES: readonly { code: string; name: Text; kind: LocalityKind; at: LonLat }[] = [
  {
    code: "yaremche",
    name: { uk: "Яремче", en: "Yaremche" },
    kind: "settlement",
    at: { lon: 24.551, lat: 48.451 },
  },
  {
    code: "tatariv",
    name: { uk: "Татарів", en: "Tatariv" },
    kind: "settlement",
    at: { lon: 24.57, lat: 48.349 },
  },
  {
    code: "mykulychyn",
    name: { uk: "Микуличин", en: "Mykulychyn" },
    kind: "settlement",
    at: { lon: 24.599, lat: 48.397 },
  },
  {
    code: "vorokhta",
    name: { uk: "Ворохта", en: "Vorokhta" },
    kind: "settlement",
    at: { lon: 24.567, lat: 48.284 },
  },
  {
    code: "polianytsia",
    name: { uk: "Поляниця (Буковель)", en: "Polianytsia (Bukovel)" },
    kind: "settlement",
    at: { lon: 24.417, lat: 48.367 },
  },
  {
    code: "yablunytsia",
    name: { uk: "Яблуниця", en: "Yablunytsia" },
    kind: "settlement",
    at: { lon: 24.469, lat: 48.305 },
  },
];

type Week = readonly { days: readonly number[]; from: string; to: string }[];
const DAILY = [1, 2, 3, 4, 5, 6, 7] as const;

export const SEED_PLACES: readonly {
  key: string;
  category: string;
  locality: string;
  name: Text;
  description?: Text;
  address: Text;
  at: LonLat;
  phone?: string;
  website?: string;
  tags?: readonly string[];
  status: "draft" | "published";
  recommended?: boolean;
  week?: Week;
  /** Исключение графика: дата, закрыто или короткий день. */
  exception?: { date: string; closed: boolean; from?: string; to?: string; note?: Text };
}[] = [
  {
    key: "hotel-smereka",
    category: "hotels",
    locality: "tatariv",
    name: { uk: "Готель «Тестова Смерека»", en: "Test Smereka hotel" },
    description: { uk: "Затишний готель біля річки Прут: сніданки, паркування, трансфер до підйомників." },
    address: { uk: "вул. Тестова, 1, Татарів" },
    at: { lon: 24.5712, lat: 48.3478 },
    phone: "+380000000101",
    website: "https://smereka.example",
    tags: ["parking", "wifi", "kids"],
    status: "published",
  },
  {
    key: "sadyba-prut",
    category: "sadyby",
    locality: "yaremche",
    name: { uk: "Садиба «Над Прутом»", en: "Nad Prutom guest house" },
    description: { uk: "Дерев'яна садиба з видом на гори, домашня кухня і чан на подвір'ї." },
    address: { uk: "вул. Річкова, 7, Яремче" },
    at: { lon: 24.5551, lat: 48.4489 },
    phone: "+380000000102",
    tags: ["pets", "parking"],
    status: "published",
  },
  {
    key: "cafe-kava",
    category: "cafes",
    locality: "yaremche",
    name: { uk: "Кафе «Гуцульська кава»", en: "Hutsul Coffee cafe" },
    description: { uk: "Кава на жару, бануш і вергуни. Є дитячий куточок." },
    address: { uk: "вул. Свободи, 12, Яремче" },
    at: { lon: 24.5523, lat: 48.4512 },
    phone: "+380000000103",
    tags: ["kids", "wifi", "hutsul-cuisine", "rainy-day"],
    status: "published",
    week: [{ days: DAILY, from: "08:00", to: "20:00" }],
    exception: {
      date: "2026-12-31",
      closed: false,
      from: "08:00",
      to: "16:00",
      note: { uk: "Скорочений день" },
    },
  },
  {
    key: "kolyba-vatra",
    category: "kolyby",
    locality: "mykulychyn",
    name: { uk: "Колиба «Ватра»", en: "Vatra kolyba" },
    description: { uk: "Страви на відкритому вогні, трембіта ввечері, велика тераса." },
    address: { uk: "траса Яремче — Ворохта, 5 км, Микуличин" },
    at: { lon: 24.6012, lat: 48.3951 },
    phone: "+380000000104",
    tags: ["hutsul-cuisine", "parking", "kids"],
    status: "published",
    recommended: true,
    week: [{ days: DAILY, from: "11:00", to: "23:00" }],
  },
  {
    key: "restaurant-polonyna",
    category: "restaurants",
    locality: "polianytsia",
    name: { uk: "Ресторан «Полонина»", en: "Polonyna restaurant" },
    description: { uk: "Авторська карпатська кухня поруч зі схилами, вегетаріанське меню." },
    address: { uk: "курорт, корпус 3, Поляниця" },
    at: { lon: 24.4182, lat: 48.3655 },
    phone: "+380000000105",
    website: "https://polonyna.example",
    tags: ["vegetarian", "winter"],
    status: "published",
    week: [
      { days: [1, 2, 3, 4, 5], from: "12:00", to: "22:00" },
      { days: [6, 7], from: "10:00", to: "23:00" },
    ],
  },
  {
    key: "shop-pysanka",
    category: "souvenirs",
    locality: "yaremche",
    name: { uk: "Крамниця «Писанка»", en: "Pysanka shop" },
    description: { uk: "Вишиванки, писанки, вироби з дерева від місцевих майстрів." },
    address: { uk: "вул. Свободи, 20, Яремче" },
    at: { lon: 24.5531, lat: 48.4521 },
    phone: "+380000000106",
    status: "published",
    week: [{ days: [1, 2, 3, 4, 5, 6], from: "09:00", to: "18:00" }],
  },
  {
    key: "market-waterfall",
    category: "markets",
    locality: "yaremche",
    name: { uk: "Сувенірний ринок біля водоспаду", en: "Waterfall souvenir market" },
    description: { uk: "Ряди з медом, сиром, травами і сувенірами." },
    address: { uk: "біля водоспаду, Яремче" },
    at: { lon: 24.5468, lat: 48.4453 },
    tags: ["summer"],
    status: "published",
    week: [{ days: DAILY, from: "09:00", to: "19:00" }],
  },
  {
    key: "chan-kupil",
    category: "chany",
    locality: "tatariv",
    name: { uk: "Чани «Гаряча купіль»", en: "Hot Bath tubs" },
    description: { uk: "Чани на дровах з травами, сауна, купіль з гірською водою." },
    address: { uk: "вул. Лісова, 3, Татарів" },
    at: { lon: 24.5668, lat: 48.3512 },
    phone: "+380000000108",
    tags: ["winter", "parking"],
    status: "published",
    week: [{ days: [3, 4, 5, 6, 7], from: "12:00", to: "23:00" }],
  },
  {
    key: "spa-ranok",
    category: "spa",
    locality: "polianytsia",
    name: { uk: "SPA «Карпатський ранок»", en: "Carpathian Morning SPA" },
    // Черновик: нет описания — публикация вернёт 422 (description_missing).
    address: { uk: "курорт, корпус 7, Поляниця" },
    at: { lon: 24.4201, lat: 48.3671 },
    status: "draft",
  },
  {
    key: "museum-khata",
    category: "museums",
    locality: "vorokhta",
    name: { uk: "Музей «Гуцульська хата»", en: "Hutsul House museum" },
    description: { uk: "Побут гуцулів XIX століття, ткацтво, екскурсії щогодини." },
    address: { uk: "вул. Музейна, 2, Ворохта" },
    at: { lon: 24.5654, lat: 48.2851 },
    phone: "+380000000110",
    tags: ["kids", "rainy-day"],
    status: "published",
    week: [{ days: [2, 3, 4, 5, 6, 7], from: "10:00", to: "17:00" }],
    exception: { date: "2027-01-07", closed: true, note: { uk: "Святковий день" } },
  },
  {
    key: "excursions-dovbush",
    category: "excursions",
    locality: "yaremche",
    name: { uk: "Екскурсії «Стежками Довбуша»", en: "Dovbush Trails excursions" },
    description: { uk: "Пішохідні маршрути до скель Довбуша з гідом, 3–5 годин." },
    address: { uk: "старт від центру, Яремче" },
    at: { lon: 24.5502, lat: 48.4532 },
    phone: "+380000000111",
    tags: ["summer", "kids"],
    status: "published",
    week: [{ days: [6, 7], from: "09:00", to: "15:00" }],
  },
  {
    key: "nature-waterfall",
    category: "nature",
    locality: "yaremche",
    name: { uk: "Водоспад «Тестовий»", en: "Test waterfall" },
    description: { uk: "Невеликий водоспад з оглядовим майданчиком, 10 хвилин від центру." },
    address: { uk: "стежка від мосту, Яремче" },
    at: { lon: 24.5459, lat: 48.4449 },
    tags: ["summer", "kids", "pets"],
    status: "published",
  },
  {
    key: "taxi-gory",
    category: "taxi",
    locality: "yaremche",
    name: { uk: "Таксі «Гірський трансфер»", en: "Mountain Transfer taxi" },
    description: { uk: "Трансфер до вокзалу, Буковеля та по селах, цілодобове замовлення." },
    address: { uk: "вул. Вокзальна, 1, Яремче" },
    at: { lon: 24.5578, lat: 48.4567 },
    phone: "+380000000113",
    status: "published",
    week: [{ days: DAILY, from: "06:00", to: "02:00" }],
  },
  {
    key: "pharmacy-vorokhta",
    category: "pharmacies",
    locality: "vorokhta",
    name: { uk: "Аптека «Тестова»", en: "Test pharmacy" },
    description: { uk: "Ліки, засоби від застуди та перша допомога." },
    address: { uk: "вул. Центральна, 10, Ворохта" },
    at: { lon: 24.5662, lat: 48.2839 },
    phone: "+380000000114",
    status: "published",
    week: [{ days: DAILY, from: "08:00", to: "21:00" }],
  },
];

export type SeedCatalogResult = { categories: number; tags: number; localities: number; places: number };

/** Демо-каталог региона A и минимальный каталог региона Б. Повторный запуск ничего не меняет. */
export async function seedCatalog(
  db: Db,
  regions: Record<SeedRegionKey, string>,
): Promise<SeedCatalogResult> {
  await withTenant(db, SYSTEM_CONTEXT, async (trx) => {
    const a = regions.a;
    const ids = (kind: string, code: string, region: SeedRegionKey = "a") =>
      seedUuid(`catalog:${region}:${kind}:${code}`);

    for (const [i, c] of SEED_CATEGORIES.entries()) {
      await trx
        .insertInto("categories")
        .values({
          id: ids("category", c.code),
          region_id: a,
          code: c.code,
          name_i18n: c.name,
          icon: c.icon,
          home_section: c.home,
          sort_order: c.sortOrder ?? i * 10,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      for (const [j, s] of c.children.entries())
        await trx
          .insertInto("categories")
          .values({
            id: ids("category", s.code),
            region_id: a,
            parent_id: ids("category", c.code),
            code: s.code,
            name_i18n: s.name,
            icon: s.icon,
            sort_order: j * 10,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
    }

    for (const code of SEED_IMPORT_CATEGORY_CODES) {
      const def = IMPORT_EXTRA_CATEGORIES.find((c) => c.code === code);
      if (!def) continue;
      const parent = await trx
        .selectFrom("categories")
        .select("id")
        .where("region_id", "=", a)
        .where("code", "=", def.parent)
        .where("parent_id", "is", null)
        .executeTakeFirst();
      if (!parent) continue;
      await trx
        .insertInto("categories")
        .values({
          id: ids("category", def.code),
          region_id: a,
          parent_id: parent.id,
          code: def.code,
          name_i18n: def.name,
          icon: def.icon,
          sort_order: 500 + IMPORT_EXTRA_CATEGORIES.indexOf(def) * 10,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    await trx
      .insertInto("tags")
      .values(
        SEED_TAGS.map((t, i) => ({
          id: ids("tag", t.code),
          region_id: a,
          code: t.code,
          name_i18n: t.name,
          tag_group: t.group,
          sort_order: i * 10,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();

    for (const [i, l] of SEED_LOCALITIES.entries())
      await trx
        .insertInto("localities")
        .values({
          id: ids("locality", l.code),
          region_id: a,
          code: l.code,
          kind: l.kind,
          name_i18n: l.name,
          location: point(l.at),
          sort_order: i * 10,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();

    const published = new Date("2026-11-02T00:00:00Z");
    for (const p of SEED_PLACES) {
      const placeId = ids("place", p.key);
      const inserted = await trx
        .insertInto("places")
        .values({
          id: placeId,
          region_id: a,
          category_id: ids("category", p.category),
          locality_id: ids("locality", p.locality),
          name_i18n: p.name,
          description_i18n: p.description ?? null,
          address_i18n: p.address,
          location: point(p.at),
          phone: p.phone ?? null,
          website: p.website ?? null,
          status: p.status,
          recommended: p.recommended ?? false,
          verified_at: published,
          first_published_at: p.status === "published" ? published : null,
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      // Связи, график и бейдж — только при первой вставке места: повтор не трогает правки админки.
      if (!inserted) continue;
      if (p.tags?.length)
        await trx
          .insertInto("place_tags")
          .values(p.tags.map((t) => ({ region_id: a, place_id: placeId, tag_id: ids("tag", t) })))
          .execute();
      const weekly = (p.week ?? []).flatMap((w) =>
        w.days.map((day) => ({
          region_id: a,
          place_id: placeId,
          day_of_week: day,
          opens_at: w.from,
          closes_at: w.to,
        })),
      );
      if (weekly.length) await trx.insertInto("place_schedules").values(weekly).execute();
      if (p.exception)
        await trx
          .insertInto("place_schedule_exceptions")
          .values({
            region_id: a,
            place_id: placeId,
            date: p.exception.date,
            closed: p.exception.closed,
            opens_at: p.exception.closed ? null : (p.exception.from ?? null),
            closes_at: p.exception.closed ? null : (p.exception.to ?? null),
            note_i18n: p.exception.note ?? null,
          })
          .execute();
      if (p.recommended)
        await trx
          .insertInto("place_badge_events")
          .values({
            region_id: a,
            place_id: placeId,
            action: "grant",
            reason: "Демо-дані: відповідає критеріям якості (seed)",
          })
          .execute();
    }

    // Регион Б: одна категория и одно место — чтобы изоляцию было видно в админке и в E2E.
    const b = regions.b;
    await trx
      .insertInto("categories")
      .values({
        id: ids("category", "eat", "b"),
        region_id: b,
        code: "eat",
        name_i18n: { uk: "Де поїсти", en: "Where to eat" },
        icon: "utensils",
        home_section: "eat",
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx
      .insertInto("places")
      .values({
        id: ids("place", "cafe-b", "b"),
        region_id: b,
        category_id: ids("category", "eat", "b"),
        name_i18n: { uk: "Кафе регіону Б", en: "Region B cafe" },
        description_i18n: { uk: "Місце іншого регіону — регіон-адмін A його не бачить." },
        address_i18n: { uk: "вул. Б, 1" },
        location: point({ lon: 25.0, lat: 48.5 }),
        status: "published",
        first_published_at: published,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  });
  return {
    categories:
      SEED_CATEGORIES.reduce((n, c) => n + 1 + c.children.length, 0) + SEED_IMPORT_CATEGORY_CODES.length,
    tags: SEED_TAGS.length,
    localities: SEED_LOCALITIES.length,
    places: SEED_PLACES.length,
  };
}
