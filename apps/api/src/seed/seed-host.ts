// Seed блока 5 (ADR-0020): «Про заклад» и персонал демо-отеля, QR номера, демо-сценарии «Мій план». Только на
// существующих демо-местах каталога (seed-catalog.ts, по ключу места): реальные места региона загрузят позже — тогда
// сценарии и модуль отеля перестраиваются по ключам без привязки к числу мест (пункт с отсутствующим или
// неопубликованным местом пропускается; сценарий без доступных мест остаётся черновиком). D-53: тексты — демо.
import {
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
  type HostSectionRecord,
  type HostServiceRecord,
  type LocalizedText,
} from "../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../modules/audit/index.js";
import {
  placeParentLoader,
  RoleAssignmentsRepository,
  ScopeHierarchy,
  scope,
} from "../modules/rbac/index.js";
import { RoleAssignmentError, RoleAssignmentService } from "../modules/role-assignments/index.js";
import { seedUuid } from "./ids.js";
import type { SeedRegionKey } from "./seed.js";

/** Место-отель демо-QR demoHotel01 («Тестовий готель») — ключ места каталога. */
export const SEED_HOTEL_PLACE_KEY = "hotel-smereka";
export const SEED_HOTEL_QR_CODE = "demoHotel01";
/** QR номера 204 того же отеля (D-49: номер — контекст QR, не ПДн). */
export const SEED_ROOM_QR = { code: "demoRoom204a", room: "204" } as const;

/** Демо-сотрудник отеля: вход — dev-логин (local) или Telegram с этим id невозможен (id вымышленный). */
export const SEED_HOTEL_STAFF = {
  key: "hotel-staff-a",
  telegramUserId: "990000000101",
  username: "demo_hotel_staff",
  firstName: "Олена (демо)",
} as const;

const placeId = (key: string, region: SeedRegionKey = "a") => seedUuid(`catalog:${region}:place:${key}`);
export const seedHotelStaffUserId = () => seedUuid(`user:${SEED_HOTEL_STAFF.key}`);

const SECTIONS: HostSectionRecord[] = [
  {
    kind: "rules",
    title: { uk: "Правила проживання", en: "House rules" },
    content: {
      uk: "Заїзд з 14:00, виїзд до 12:00. Тиша з 22:00 до 08:00. Паління лише у визначених місцях. (Демо)",
      en: "Check-in from 14:00, check-out by 12:00. Quiet hours 22:00–08:00. (Demo)",
    },
    sortOrder: 0,
  },
  {
    kind: "breakfast",
    title: { uk: "Сніданок", en: "Breakfast" },
    content: { uk: "Щодня 08:00–10:30 у ресторані на першому поверсі. (Демо)" },
    sortOrder: 10,
  },
  {
    kind: "checkout",
    title: { uk: "Виїзд", en: "Check-out" },
    content: { uk: "Ключ залиште на рецепції. Пізній виїзд — за запитом через заявку. (Демо)" },
    sortOrder: 20,
  },
  {
    kind: "contacts",
    title: { uk: "Контакти рецепції", en: "Reception" },
    content: { uk: "Рецепція працює цілодобово, телефон — кнопка «Подзвонити». (Демо)" },
    sortOrder: 30,
  },
];

const SERVICES: HostServiceRecord[] = [
  {
    code: "cleaning",
    title: { uk: "Прибирання номера", en: "Room cleaning" },
    description: { uk: "Прибирання у зручний час протягом дня" },
    slaMinutes: 120,
    enabled: true,
    sortOrder: 0,
  },
  {
    code: "towels",
    title: { uk: "Заміна рушників", en: "Fresh towels" },
    description: null,
    slaMinutes: 30,
    enabled: true,
    sortOrder: 10,
  },
  {
    code: "breakfast-room",
    title: { uk: "Сніданок у номер", en: "Breakfast to the room" },
    description: { uk: "Замовлення до 10:00" },
    slaMinutes: 45,
    enabled: true,
    sortOrder: 20,
  },
  {
    code: "late-checkout",
    title: { uk: "Пізній виїзд", en: "Late check-out" },
    description: { uk: "До 14:00, за наявності" },
    slaMinutes: 60,
    enabled: true,
    sortOrder: 30,
  },
  {
    code: "pool",
    title: { uk: "Басейн / чан", en: "Pool / hot tub" },
    description: { uk: "Бронювання часу" },
    slaMinutes: 60,
    enabled: true,
    sortOrder: 40,
  },
];

type ScenarioItemSeed = {
  day: number;
  place: string;
  time?: string;
  duration?: number;
  note?: LocalizedText;
  alternatives?: readonly string[];
};

/** Демо-сценарии (C09): ключи мест — из seed каталога; тексты — вымышленные (D-53). */
export const SEED_SCENARIOS: readonly {
  code: string;
  title: LocalizedText;
  description: LocalizedText;
  days: number;
  tags: readonly string[];
  items: readonly ScenarioItemSeed[];
}[] = [
  {
    code: "one-day-yaremche",
    title: { uk: "Яремче за один день", en: "Yaremche in one day" },
    description: { uk: "Водоспад, сувеніри, кава і вечеря в колибі — головне за день. (Демо)" },
    days: 1,
    tags: ["one_day", "no_car"],
    items: [
      { day: 1, place: "cafe-kava", time: "09:00", duration: 45, alternatives: ["restaurant-polonyna"] },
      {
        day: 1,
        place: "nature-waterfall",
        time: "10:00",
        duration: 90,
        alternatives: ["excursions-dovbush"],
      },
      { day: 1, place: "market-waterfall", time: "12:00", duration: 60, alternatives: ["shop-pysanka"] },
      { day: 1, place: "kolyba-vatra", time: "18:00", duration: 90, alternatives: ["restaurant-polonyna"] },
    ],
  },
  {
    code: "with-kids",
    title: { uk: "З дітьми", en: "With kids" },
    description: { uk: "Неспішний день без довгих переїздів: природа, музей і смачний обід. (Демо)" },
    days: 1,
    tags: ["one_day", "kids"],
    items: [
      {
        day: 1,
        place: "nature-waterfall",
        time: "10:00",
        duration: 60,
        alternatives: ["excursions-dovbush"],
      },
      { day: 1, place: "museum-khata", time: "12:00", duration: 60, alternatives: ["shop-pysanka"] },
      { day: 1, place: "kolyba-vatra", time: "14:00", duration: 60, alternatives: ["cafe-kava"] },
    ],
  },
  {
    code: "rainy-day",
    title: { uk: "Якщо дощ", en: "Rainy day" },
    description: { uk: "Під дахом: музей, майстер-клас писанки, чан і тепла кава. (Демо)" },
    days: 1,
    tags: ["one_day", "rain"],
    items: [
      { day: 1, place: "museum-khata", time: "10:00", duration: 90 },
      { day: 1, place: "shop-pysanka", time: "12:00", duration: 60, alternatives: ["market-waterfall"] },
      { day: 1, place: "cafe-kava", time: "13:30", duration: 45, alternatives: ["restaurant-polonyna"] },
      { day: 1, place: "chan-kupil", time: "16:00", duration: 120, alternatives: ["spa-ranok"] },
    ],
  },
  {
    code: "no-car",
    title: { uk: "Без авто", en: "No car" },
    description: { uk: "Усе пішки або на таксі в межах Яремче. (Демо)" },
    days: 1,
    tags: ["one_day", "no_car", "budget"],
    items: [
      { day: 1, place: "market-waterfall", time: "10:00", duration: 60 },
      {
        day: 1,
        place: "nature-waterfall",
        time: "11:00",
        duration: 60,
        alternatives: ["excursions-dovbush"],
      },
      { day: 1, place: "cafe-kava", time: "13:00", duration: 45, alternatives: ["kolyba-vatra"] },
      { day: 1, place: "taxi-gory", note: { uk: "Таксі до готелю, якщо втомились" } },
    ],
  },
  {
    code: "romantic",
    title: { uk: "Романтичний вечір", en: "Romantic evening" },
    description: { uk: "Прогулянка, чан під зорями і вечеря з видом на гори. (Демо)" },
    days: 1,
    tags: ["one_day", "romantic", "premium"],
    items: [
      {
        day: 1,
        place: "excursions-dovbush",
        time: "15:00",
        duration: 90,
        alternatives: ["nature-waterfall"],
      },
      { day: 1, place: "chan-kupil", time: "18:00", duration: 120, alternatives: ["spa-ranok"] },
      { day: 1, place: "restaurant-polonyna", time: "20:30", duration: 90, alternatives: ["kolyba-vatra"] },
    ],
  },
  {
    code: "two-days-active",
    title: { uk: "Два дні активно", en: "Two active days" },
    description: { uk: "Похід до скель Довбуша, водоспад, а ввечері — відновлення в чані. (Демо)" },
    days: 2,
    tags: ["multi_day", "active"],
    items: [
      { day: 1, place: "excursions-dovbush", time: "09:00", duration: 240 },
      { day: 1, place: "kolyba-vatra", time: "14:00", duration: 60, alternatives: ["cafe-kava"] },
      { day: 1, place: "chan-kupil", time: "18:00", duration: 120 },
      { day: 2, place: "nature-waterfall", time: "10:00", duration: 90 },
      { day: 2, place: "restaurant-polonyna", time: "13:00", duration: 90, alternatives: ["kolyba-vatra"] },
    ],
  },
];

export type SeedHostResult = { hostModules: number; scenarios: number; staffAssigned: boolean };

/** «Про заклад», QR номера, демо-сотрудник и сценарии региона A. Повторный запуск ничего не меняет. */
export async function seedHost(db: Db, regions: Record<SeedRegionKey, string>): Promise<SeedHostResult> {
  const a = regions.a;
  const hotel = placeId(SEED_HOTEL_PLACE_KEY);
  const result = await withTenant(db, SYSTEM_CONTEXT, async (trx) => {
    const places = await trx
      .selectFrom("places")
      .select(["id", "status"])
      .where("region_id", "=", a)
      .execute();
    const published = new Set(places.filter((p) => p.status === "published").map((p) => p.id));
    const exists = new Set(places.map((p) => p.id));
    let hostModules = 0;
    if (exists.has(hotel)) {
      // demoHotel01 → место-отель (только если точка ещё не привязана: правки админки не трогаем).
      await trx
        .updateTable("qr_points")
        .set({ place_id: hotel })
        .where("code", "=", SEED_HOTEL_QR_CODE)
        .where("place_id", "is", null)
        .execute();
      await trx
        .insertInto("qr_points")
        .values({
          id: seedUuid("qr:room-204"),
          region_id: a,
          code: SEED_ROOM_QR.code,
          type: "hotel",
          place_id: hotel,
          active: true,
          label: `Тестовий готель — номер ${SEED_ROOM_QR.room}`,
          source: "sticker",
          room_label: SEED_ROOM_QR.room,
          venue_name_i18n: { uk: "Тестовий готель", en: "Test hotel" },
        })
        .onConflict((oc) => oc.column("code").doNothing())
        .execute();
      const inserted = await trx
        .insertInto("host_modules")
        .values({
          id: seedUuid("host-module:a:hotel"),
          region_id: a,
          place_id: hotel,
          wifi_ssid: "TestHotel-Guest",
          wifi_password: "demo-wifi-2026",
          reception_phone: "+380000000101",
          hours_from: "08:00",
          hours_to: "22:00",
          sections: JSON.stringify(SECTIONS),
          services: JSON.stringify(SERVICES),
        })
        .onConflict((oc) => oc.column("place_id").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (inserted) hostModules++;
      // Демо-сотрудник: пользователь, привязка Telegram и согласие на сервисные сообщения (уведомления о заявках).
      const staffId = seedHotelStaffUserId();
      await trx
        .insertInto("users")
        .values({ id: staffId, status: "active", language: "uk" })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
      await trx
        .insertInto("telegram_accounts")
        .values({
          user_id: staffId,
          telegram_user_id: SEED_HOTEL_STAFF.telegramUserId,
          username: SEED_HOTEL_STAFF.username,
          first_name: SEED_HOTEL_STAFF.firstName,
          last_name: null,
          language_code: "uk",
          photo_url: null,
          last_auth_date: new Date("2026-11-02T00:00:00Z"),
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx
        .insertInto("messaging_consents")
        .values({
          user_id: staffId,
          purpose: "service",
          granted: true,
          source: "settings",
          granted_at: new Date("2026-11-02T00:00:00Z"),
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    let scenarios = 0;
    for (const [i, s] of SEED_SCENARIOS.entries()) {
      const items = s.items.filter((it) => exists.has(placeId(it.place)));
      if (items.length === 0) continue;
      const anyPublished = items.some((it) => published.has(placeId(it.place)));
      const id = seedUuid(`scenario:a:${s.code}`);
      const inserted = await trx
        .insertInto("scenarios")
        .values({
          id,
          region_id: a,
          code: s.code,
          title_i18n: s.title,
          description_i18n: s.description,
          days: s.days,
          tags: [...s.tags],
          status: anyPublished ? "published" : "draft",
          sort_order: i * 10,
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) continue;
      scenarios++;
      const pos = new Map<number, number>();
      await trx
        .insertInto("scenario_items")
        .values(
          items.map((it) => {
            const position = pos.get(it.day) ?? 0;
            pos.set(it.day, position + 1);
            return {
              region_id: a,
              scenario_id: id,
              day_no: it.day,
              position,
              place_id: placeId(it.place),
              time_hint: it.time ?? null,
              duration_min: it.duration ?? null,
              note_i18n: it.note ?? null,
              alternatives: (it.alternatives ?? []).map((k) => placeId(k)).filter((p) => exists.has(p)),
            };
          }),
        )
        .execute();
    }
    return { hostModules, scenarios, hotelExists: exists.has(hotel) };
  });

  let staffAssigned = false;
  if (result.hotelExists) staffAssigned = await assignStaff(db, hotel);
  return { hostModules: result.hostModules, scenarios: result.scenarios, staffAssigned };
}

/** ORG_STAFF демо-сотрудника на отель (отдельная транзакция, как assignOnce в seed.ts). */
export async function assignStaff(db: Db, hotel: string): Promise<boolean> {
  const service = new RoleAssignmentService(
    new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS),
    new ScopeHierarchy({ PLACE: placeParentLoader(db) }),
  );
  const userId = seedHotelStaffUserId();
  try {
    return await withTenant(db, SYSTEM_CONTEXT, async (trx) => {
      if (await new RoleAssignmentsRepository(trx).findUnrevoked(userId, "ORG_STAFF", "PLACE", hotel))
        return false;
      await service.assign(trx, {
        userId,
        role: "ORG_STAFF",
        scope: scope("PLACE", hotel),
        actor: { type: "system" },
        reason: "seed",
      });
      return true;
    });
  } catch (e) {
    if (e instanceof RoleAssignmentError && e.reason === "already_assigned") return false;
    throw e;
  }
}
