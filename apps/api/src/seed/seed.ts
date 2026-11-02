// Seed (T1-23): тестовый регион и второй tenant для проверок изоляции, пользователи с техническими ролями,
// синтетический объём (ТЗ §13). Идемпотентность: записи имеют детерминированные id (seedUuid) или естественный
// ключ (regions.code) и вставляются через ON CONFLICT DO NOTHING; назначения ролей проверяются заранее.
import {
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
  type EmergencyContactKind,
  type LocalizedText,
  type NewQrPoint,
  type QrPointType,
} from "../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../modules/audit/index.js";
import {
  PLATFORM_SCOPE,
  regionScope,
  RoleAssignmentsRepository,
  ScopeHierarchy,
  type RoleCode,
  type ScopeRef,
} from "../modules/rbac/index.js";
import { RoleAssignmentError, RoleAssignmentService } from "../modules/role-assignments/index.js";
import { seedUuid } from "./ids.js";

/** Реальный пилотный регион определит D-01 (замена в блоке 3); это условный регион для разработки. */
export const SEED_REGIONS = [
  { key: "a", code: "test-region", name: { uk: "Прикарпаття", en: "Prykarpattia" } },
  { key: "b", code: "test-region-b", name: { uk: "Тестовий регіон Б", en: "Test region B" } },
] as const;
export type SeedRegionKey = (typeof SEED_REGIONS)[number]["key"];

type SeedAssignment = { role: RoleCode; scope: "platform" | SeedRegionKey };

/**
 * Пользователи с ролями (roles.ts): технические и бизнес-роли админки. TECH_ORG_EDITOR не назначается: таблиц
 * организаций ещё нет. Учёток входа по паролю seed не создаёт (пароль в коде недопустим) — CLI admin:create.
 */
export const SEED_USERS = [
  { key: "superuser", assignments: [{ role: "TECH_SUPERUSER", scope: "platform" }] },
  { key: "admin-a", assignments: [{ role: "TECH_REGION_ADMIN", scope: "a" }] },
  { key: "admin-b", assignments: [{ role: "TECH_REGION_ADMIN", scope: "b" }] },
  { key: "auditor-a", assignments: [{ role: "TECH_AUDITOR", scope: "a" }] },
  { key: "auditor-platform", assignments: [{ role: "TECH_AUDITOR", scope: "platform" }] },
  // Бизнес-роли админки (блок 3) — для dev-входа в local; пароля нет: вход по паролю — учётка из CLI admin:create.
  { key: "region-admin-a", assignments: [{ role: "REGION_ADMIN", scope: "a" }] },
  { key: "region-admin-b", assignments: [{ role: "REGION_ADMIN", scope: "b" }] },
  { key: "moderator-a", assignments: [{ role: "MODERATOR", scope: "a" }] },
] as const satisfies readonly { key: string; assignments: readonly SeedAssignment[] }[];
export type SeedUserKey = (typeof SEED_USERS)[number]["key"];

export const seedUserId = (key: SeedUserKey): string => seedUuid(`user:${key}`);

export type SeedBaseResult = {
  regions: Record<SeedRegionKey, string>;
  users: Record<SeedUserKey, string>;
  /** Сколько назначений создано этим запуском (повторный запуск — 0). */
  assignmentsCreated: number;
};

/** Регионы, пользователи и назначения ролей. Повторный запуск ничего не меняет. */
export async function seedBase(db: Db): Promise<SeedBaseResult> {
  const regions = {} as Record<SeedRegionKey, string>;
  const users = {} as Record<SeedUserKey, string>;
  await withTenant(db, SYSTEM_CONTEXT, async (trx) => {
    for (const r of SEED_REGIONS) {
      await trx
        .insertInto("regions")
        .values({ id: seedUuid(`region:${r.key}`), code: r.code, name_i18n: r.name, status: "active" })
        .onConflict((oc) => oc.column("code").doNothing())
        .execute();
      // id берём из БД: регион с таким кодом мог быть создан раньше с другим id.
      regions[r.key] = (
        await trx.selectFrom("regions").select("id").where("code", "=", r.code).executeTakeFirstOrThrow()
      ).id;
    }
    await trx
      .insertInto("users")
      .values(SEED_USERS.map((u) => ({ id: seedUserId(u.key), status: "active" as const, language: "uk" })))
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    for (const u of SEED_USERS) users[u.key] = seedUserId(u.key);
  });

  const service = new RoleAssignmentService(
    new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS),
    new ScopeHierarchy(),
  );
  let assignmentsCreated = 0;
  for (const u of SEED_USERS) {
    for (const a of u.assignments as readonly SeedAssignment[]) {
      const scope: ScopeRef = a.scope === "platform" ? PLATFORM_SCOPE : regionScope(regions[a.scope]);
      if (await assignOnce(db, service, users[u.key], a.role, scope)) assignmentsCreated++;
    }
  }
  return { regions, users, assignmentsCreated };
}

/**
 * Назначение в отдельной транзакции: ошибка БД (23505 при гонке двух seed) прерывает транзакцию, продолжать в
 * ней нельзя — withTenant откатывает её, а «уже назначено» здесь не ошибка. Возвращает true, если создано.
 */
async function assignOnce(
  db: Db,
  service: RoleAssignmentService,
  userId: string,
  role: RoleCode,
  scope: ScopeRef,
): Promise<boolean> {
  try {
    return await withTenant(db, SYSTEM_CONTEXT, async (trx) => {
      const scopeId = scope.type === "PLATFORM" ? null : scope.id;
      if (await new RoleAssignmentsRepository(trx).findUnrevoked(userId, role, scope.type, scopeId))
        return false;
      await service.assign(trx, { userId, role, scope, actor: { type: "system" }, reason: "seed" });
      return true;
    });
  } catch (e) {
    if (e instanceof RoleAssignmentError && e.reason === "already_assigned") return false;
    throw e;
  }
}

/**
 * Демо-QR (блок 2, ADR-0016) с фиксированными кодами для E2E: ссылка t.me/<bot>/<app>?startapp=<code>.
 * Заклады вымышленные (D-53), контакты — тестовые (телефон из зарезервированного диапазона, домен example).
 */
export const SEED_QR_POINTS = [
  {
    key: "hotel",
    region: "a",
    code: "demoHotel01",
    type: "hotel",
    active: true,
    label: "Тестовий готель — ресепшн",
    source: "sticker",
    venue: {
      venue_name_i18n: { uk: "Тестовий готель", en: "Test hotel" },
      venue_description_i18n: {
        uk: "Затишний готель у тестовому регіоні: сніданки, парковка, трансфер до підйомників.",
        en: "A cosy hotel in the test region: breakfast, parking, ski-lift transfer.",
      },
      venue_address_i18n: { uk: "вул. Тестова, 1, Тестове", en: "1 Testova St, Testove" },
      venue_phone: "+380000000001",
      venue_website: "https://hotel.example",
      venue_telegram: "test_hotel_demo",
    },
  },
  {
    key: "hotel-inactive",
    region: "a",
    code: "demoHotelOff1",
    type: "hotel",
    active: false,
    label: "Тестовий готель — старий QR (деактивовано)",
    source: "sticker",
    venue: { venue_name_i18n: { uk: "Тестовий готель (старий QR)" } },
  },
  {
    key: "region",
    region: "a",
    code: "demoRegion01",
    type: "region",
    active: true,
    label: "Стенд на вокзалі",
    source: "stand",
  },
  {
    key: "campaign",
    region: "a",
    code: "demoCampaign1",
    type: "campaign",
    active: true,
    label: "Листівка «Літо 2026»",
    source: "flyer",
    campaign: "summer-2026",
  },
  {
    key: "hotel-b",
    region: "b",
    code: "demoHotelB01",
    type: "hotel",
    active: true,
    label: "Готель регіону Б",
    source: "sticker",
    venue: { venue_name_i18n: { uk: "Готель регіону Б", en: "Region B hotel" } },
  },
] as const satisfies readonly {
  key: string;
  region: SeedRegionKey;
  code: string;
  type: QrPointType;
  active: boolean;
  label: string;
  source: string;
  campaign?: string;
  venue?: Partial<Pick<NewQrPoint, VenueColumn>>;
}[];
type VenueColumn =
  | "venue_name_i18n"
  | "venue_description_i18n"
  | "venue_address_i18n"
  | "venue_phone"
  | "venue_website"
  | "venue_telegram";
export type SeedQrPointKey = (typeof SEED_QR_POINTS)[number]["key"];

/** Демо-QR; повторный запуск ничего не меняет (ON CONFLICT по коду). Возвращает код → id. */
export async function seedQrPoints(
  db: Db,
  regions: Record<SeedRegionKey, string>,
): Promise<Record<SeedQrPointKey, string>> {
  const ids = {} as Record<SeedQrPointKey, string>;
  await withTenant(db, SYSTEM_CONTEXT, async (trx) => {
    for (const p of SEED_QR_POINTS) {
      const venue: Partial<Pick<NewQrPoint, VenueColumn>> = "venue" in p ? p.venue : {};
      await trx
        .insertInto("qr_points")
        .values({
          id: seedUuid(`qr:${p.key}`),
          region_id: regions[p.region],
          code: p.code,
          type: p.type,
          active: p.active,
          label: p.label,
          source: p.source,
          campaign: "campaign" in p ? p.campaign : null,
          ...venue,
        })
        .onConflict((oc) => oc.column("code").doNothing())
        .execute();
      ids[p.key] = (
        await trx.selectFrom("qr_points").select("id").where("code", "=", p.code).executeTakeFirstOrThrow()
      ).id;
    }
  });
  return ids;
}

/**
 * Экстренные контакты «Халепа?» тестового региона (блок 3/4). ДЕМО: общеукраинские номера служб (112, 101, 102,
 * 103) настоящие, горные спасатели — вымышленный номер (+38000…, не выделен оператору); реальные контакты
 * пилотного региона заводит ответственный OPS (D-53) в админке. Пометка «Демо» — в описании каждого контакта.
 */
export const SEED_EMERGENCY_CONTACTS = [
  {
    key: "general",
    kind: "general",
    phone: "112",
    name: { uk: "Єдиний номер екстрених служб", en: "Emergency number" },
    sortOrder: 10,
  },
  {
    key: "rescue",
    kind: "rescue",
    phone: "101",
    name: { uk: "Рятувальники (ДСНС)", en: "Rescue service" },
    sortOrder: 20,
  },
  { key: "police", kind: "police", phone: "102", name: { uk: "Поліція", en: "Police" }, sortOrder: 30 },
  {
    key: "ambulance",
    kind: "ambulance",
    phone: "103",
    name: { uk: "Швидка допомога", en: "Ambulance" },
    sortOrder: 40,
  },
  {
    key: "mountain-rescue",
    kind: "mountain_rescue",
    phone: "+380000000199",
    name: { uk: "Гірські рятувальники", en: "Mountain rescue" },
    sortOrder: 50,
  },
] as const satisfies readonly {
  key: string;
  kind: EmergencyContactKind;
  phone: string;
  name: LocalizedText;
  sortOrder: number;
}[];

const DEMO_NOTE: LocalizedText = {
  uk: "Демо-дані тестового регіону: перевірте номер перед пілотом.",
  en: "Demo data of the test region: verify the number before the pilot.",
};

/** Экстренные контакты тестового региона a; повторный запуск ничего не меняет (ON CONFLICT по id). */
export async function seedEmergencyContacts(db: Db, regions: Record<SeedRegionKey, string>): Promise<number> {
  return withTenant(db, SYSTEM_CONTEXT, async (trx) => {
    const res = await trx
      .insertInto("emergency_contacts")
      .values(
        SEED_EMERGENCY_CONTACTS.map((c) => ({
          id: seedUuid(`emergency:a:${c.key}`),
          region_id: regions.a,
          kind: c.kind,
          phone: c.phone,
          name_i18n: c.name,
          description_i18n: DEMO_NOTE,
          sort_order: c.sortOrder,
        })),
      )
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    return res.reduce((n, r) => n + Number(r.numInsertedOrUpdatedRows ?? 0), 0);
  });
}

/** Масштаб ТЗ §13 (F-156): 100 тыс. пользователей, 1 млн событий в месяц. Мест (10 тыс.) пока нет — таблицы нет. */
export const VOLUME_PRESETS = {
  small: { users: 100, events: 1_000 },
  tz: { users: 100_000, events: 1_000_000 },
} as const;
export type VolumeOptions = { users: number; events: number };
/** Верхняя граница --users/--events: защита от опечатки (лишний ноль) и переполнения диска. */
export const MAX_VOLUME = 10_000_000;
/** Прогресс печатается каждые PROGRESS_EVERY вставленных строк. */
const PROGRESS_EVERY = 100_000;

/** Объём больше small вне local (например, на Neon free 0,5 ГБ) - только с явным --allow-large. */
export function assertVolumeAllowed(volume: VolumeOptions, appEnv: string, allowLarge: boolean): void {
  const large = volume.users > VOLUME_PRESETS.small.users || volume.events > VOLUME_PRESETS.small.events;
  if (large && appEnv !== "local" && !allowLarge)
    throw new Error(
      `seed: объём ${volume.users} пользователей / ${volume.events} событий больше small при APP_ENV=${appEnv}; ` +
        "1 млн событий - сотни МБ, можно исчерпать квоту free-тарифа. Добавьте --allow-large, если это намеренно.",
    );
}

export const EVENT_NAMES = ["app_opened", "place_viewed", "search_performed", "booking_started"] as const;
const BATCH = 1000;
/** Фиксированное начало периода: оно же делает occurred_at детерминированным от номера события. */
const EVENTS_EPOCH_MS = Date.UTC(2026, 0, 1);
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Синтетические пользователи и аналитические события (без ПДн). Записи детерминированы по номеру: повторный
 * запуск ничего не дублирует. События делятся поровну между регионами и «гостем без региона» (NULL).
 * Время события зависит от общего числа событий (равномерно за 30 дней): при другом `events` уже вставленные
 * строки не пересчитываются, а пропускаются по id.
 */
export async function seedVolume(
  db: Db,
  regions: Record<SeedRegionKey, string>,
  { users, events }: VolumeOptions,
  onProgress: (message: string) => void = () => {},
): Promise<void> {
  const regionIds: (string | null)[] = [...SEED_REGIONS.map((r) => regions[r.key]), null];
  for (let from = 0; from < users; from += BATCH) {
    const to = Math.min(from + BATCH, users);
    await withTenant(db, SYSTEM_CONTEXT, (trx) =>
      trx
        .insertInto("users")
        .values(
          range(from, to).map((i) => ({
            id: seedUuid(`volume-user:${i}`),
            status: "active" as const,
            language: "uk",
          })),
        )
        .onConflict((oc) => oc.column("id").doNothing())
        .execute(),
    );
    reportProgress(onProgress, "пользователей", from, to, users);
  }
  for (let from = 0; from < events; from += BATCH) {
    const to = Math.min(from + BATCH, events);
    await withTenant(db, SYSTEM_CONTEXT, (trx) =>
      trx
        .insertInto("analytics_events")
        .values(
          range(from, to).map((i) => ({
            id: seedUuid(`volume-event:${i}`),
            event_name: EVENT_NAMES[i % EVENT_NAMES.length]!,
            schema_version: 1,
            occurred_at: new Date(EVENTS_EPOCH_MS + Math.floor((i * MONTH_MS) / events)),
            // Псевдоним, не id пользователя (ADR-004): события не связаны с учётной записью напрямую.
            pseudonymous_user_id: users > 0 ? seedUuid(`volume-pseudonym:${i % users}`) : null,
            region_id: regionIds[i % regionIds.length]!,
            properties: { synthetic: true },
          })),
        )
        .onConflict((oc) => oc.column("id").doNothing())
        .execute(),
    );
    reportProgress(onProgress, "событий", from, to, events);
  }
}

/** Сообщение, когда партия пересекла границу, кратную PROGRESS_EVERY, и в конце большого объёма. */
function reportProgress(
  onProgress: (message: string) => void,
  what: string,
  from: number,
  to: number,
  total: number,
): void {
  const crossed = Math.floor(to / PROGRESS_EVERY) > Math.floor(from / PROGRESS_EVERY);
  if (total >= PROGRESS_EVERY && (crossed || to === total)) onProgress(`seed: ${what} ${to} из ${total}`);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, k) => from + k);
}

/** Аргументы CLI: `--volume=small|tz`, `--users=N`, `--events=N` (N <= MAX_VOLUME), `--allow-large`. По умолчанию small. */
export function parseVolumeArgs(argv: readonly string[]): VolumeOptions & { allowLarge: boolean } {
  const args = new Map<string, string>();
  let allowLarge = false;
  for (const a of argv) {
    if (a === "--") continue;
    if (a === "--allow-large") {
      allowLarge = true;
      continue;
    }
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (!m)
      throw new Error(
        `seed: неизвестный аргумент ${a} (ожидалось --volume=small|tz, --users=N, --events=N, --allow-large)`,
      );
    if (!["volume", "users", "events"].includes(m[1]!))
      throw new Error(`seed: неизвестный аргумент --${m[1]}`);
    args.set(m[1]!, m[2]!);
  }
  const presetName = args.get("volume") ?? "small";
  if (!Object.hasOwn(VOLUME_PRESETS, presetName))
    throw new Error(`seed: неизвестный --volume=${presetName} (small | tz)`);
  const preset = VOLUME_PRESETS[presetName as keyof typeof VOLUME_PRESETS];
  const count = (name: string, fallback: number): number => {
    const v = args.get(name);
    if (v === undefined) return fallback;
    if (!/^\d+$/.test(v)) throw new Error(`seed: --${name} — неотрицательное целое, получено «${v}»`);
    const n = Number(v);
    if (n > MAX_VOLUME) throw new Error(`seed: --${name}=${v} больше допустимого максимума ${MAX_VOLUME}`);
    return n;
  };
  return { users: count("users", preset.users), events: count("events", preset.events), allowLarge };
}
