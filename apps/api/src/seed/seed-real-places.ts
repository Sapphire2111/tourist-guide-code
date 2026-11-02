// Режим «реальные места» (`db:seed -- --real-places`, решение владельца 02.11.2026: туристу — только настоящие места
// из Google, вымышленные демо-места вперемешку с реальными не показываем). Если в регионе A есть места source='google':
// «Про заклад», QR demoHotel01/demoRoom204a и демо-сотрудник переезжают на реальный отель, 6 сценариев «Мій план»
// пересобираются из реальных мест, опубликованные демо-места seedCatalog уходят в архив. Без google-мест — ничего.
// Идемпотентно: повторный запуск ничего не меняет. Фактов о реальном заведении не выдумываем — тексты «Демо: …».
import {
  SYSTEM_CONTEXT,
  withTenant,
  type Db,
  type HostSectionRecord,
  type HostServiceRecord,
  type LocalizedText,
} from "../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../modules/audit/index.js";
import { seedUuid } from "./ids.js";
import { SEED_PLACES } from "./seed-catalog.js";
import {
  assignStaff,
  SEED_HOTEL_PLACE_KEY,
  SEED_HOTEL_QR_CODE,
  SEED_ROOM_QR,
  SEED_SCENARIOS,
} from "./seed-host.js";
import type { SeedRegionKey } from "./seed.js";

/** Реальный отель для демо-QR: «Hotel Sofia, готель Софія», Яремче (Google place id). */
export const SEED_REAL_HOTEL_GOOGLE_ID = "ChIJT2oBgzAkN0cRus2eLvgbd14";
/** Запасной выбор отеля: первый по имени опубликованный google-отель этого населённого пункта. */
export const SEED_REAL_HOTEL_FALLBACK = { category: "hotels", locality: "yaremche" } as const;
/** Населённый пункт по умолчанию для пунктов сценариев (после населённого пункта демо-места). */
const DEFAULT_LOCALITY = "yaremche";

export type RealPlace = {
  id: string;
  name: string;
  category: string;
  locality: string | null;
  googlePlaceId: string;
};

const demoPlaceId = (key: string) => seedUuid(`catalog:a:place:${key}`);
const byName = (x: RealPlace, y: RealPlace) =>
  x.name.localeCompare(y.name, "uk") || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/** Отель для демо-QR среди опубликованных google-мест (детерминированно). */
export function pickRealHotel(places: readonly RealPlace[]): RealPlace | null {
  const exact = places.find((p) => p.googlePlaceId === SEED_REAL_HOTEL_GOOGLE_ID);
  if (exact) return exact;
  const { category, locality } = SEED_REAL_HOTEL_FALLBACK;
  return (
    [...places].filter((p) => p.category === category && p.locality === locality).sort(byName)[0] ?? null
  );
}

export type RealScenarioItem = {
  day: number;
  position: number;
  placeId: string;
  time: string | null;
  duration: number | null;
  note: LocalizedText | null;
  alternatives: string[];
};

/**
 * Пункты сценария из реальных мест: демо-место пункта заменяется реальным той же категории (сначала его населённый
 * пункт, затем Яремче, затем остальные; по имени и id), без повторов внутри сценария. Категории без реальных мест
 * (такси, ринки…) — пункт пропускается; альтернативы — следующие кандидаты той же категории.
 */
export function buildRealScenarioItems(
  scenario: (typeof SEED_SCENARIOS)[number],
  places: readonly RealPlace[],
): RealScenarioItem[] {
  const demo = new Map(SEED_PLACES.map((p) => [p.key, p]));
  const used = new Set<string>();
  const ranked = (key: string) => {
    const d = demo.get(key);
    if (!d) return [];
    const rank = (p: RealPlace) => (p.locality === d.locality ? 0 : p.locality === DEFAULT_LOCALITY ? 1 : 2);
    return places.filter((p) => p.category === d.category).sort((x, y) => rank(x) - rank(y) || byName(x, y));
  };
  const pos = new Map<number, number>();
  const items: RealScenarioItem[] = [];
  for (const it of scenario.items) {
    const main = ranked(it.place).find((p) => !used.has(p.id));
    if (!main) continue;
    used.add(main.id);
    const alternatives: string[] = [];
    for (const key of it.alternatives ?? []) {
      const alt = ranked(key).find((p) => !used.has(p.id) && !alternatives.includes(p.id));
      if (alt) alternatives.push(alt.id);
    }
    const position = pos.get(it.day) ?? 0;
    pos.set(it.day, position + 1);
    items.push({
      day: it.day,
      position,
      placeId: main.id,
      time: it.time ?? null,
      duration: it.duration ?? null,
      note: it.note ?? null,
      alternatives,
    });
  }
  return items;
}

/** Нейтральные описания сценариев: без названий конкретных мест (пункты — реальные, подбираются автоматически). */
const REAL_DESCRIPTIONS: Record<string, LocalizedText> = {
  "one-day-yaremche": { uk: "Демо: кава, природа і вечеря — головне за день." },
  "with-kids": { uk: "Демо: неспішний день — природа, музей і обід." },
  "rainy-day": { uk: "Демо: варіанти під дахом — музей, кава, чан." },
  "no-car": { uk: "Демо: прогулянка без авто в межах Яремче." },
  romantic: { uk: "Демо: прогулянка, чан і вечеря." },
  "two-days-active": { uk: "Демо: два дні активного відпочинку з відновленням у чані." },
};

const REAL_SECTIONS: HostSectionRecord[] = [
  {
    kind: "contacts",
    title: { uk: "Демо: контакти", en: "Demo: contacts" },
    content: {
      uk: "Демонстраційний розділ. Актуальну інформацію уточнюйте безпосередньо в закладі.",
      en: "Demo section. Please check current information with the venue directly.",
    },
    sortOrder: 0,
  },
];

const REAL_SERVICES: HostServiceRecord[] = [
  { code: "cleaning", title: { uk: "Демо: прибирання номера", en: "Demo: room cleaning" } },
  { code: "towels", title: { uk: "Демо: рушники", en: "Demo: towels" } },
  { code: "taxi", title: { uk: "Демо: таксі", en: "Demo: taxi" } },
].map((s, i) => ({ ...s, description: null, slaMinutes: 60, enabled: true, sortOrder: i * 10 }));

export type SeedRealPlacesResult = {
  skipped: boolean;
  hotel: { id: string; name: string } | null;
  qrRepointed: number;
  hostModuleCreated: boolean;
  staffAssigned: boolean;
  scenariosRebuilt: number;
  placesArchived: number;
};

export async function seedRealPlaces(
  db: Db,
  regions: Record<SeedRegionKey, string>,
): Promise<SeedRealPlacesResult> {
  const a = regions.a;
  const demoIds = SEED_PLACES.map((p) => demoPlaceId(p.key));
  const demoSet = new Set(demoIds);
  const audit = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);
  const result = await withTenant(db, SYSTEM_CONTEXT, async (trx) => {
    const rows = await trx
      .selectFrom("places as p")
      .innerJoin("categories as c", "c.id", "p.category_id")
      .leftJoin("localities as l", "l.id", "p.locality_id")
      .select(["p.id", "p.name_i18n", "p.google_place_id", "c.code as category", "l.code as locality"])
      .where("p.region_id", "=", a)
      .where("p.source", "=", "google")
      .where("p.status", "=", "published")
      .execute();
    const places: RealPlace[] = rows.map((r) => ({
      id: r.id,
      name: (r.name_i18n as LocalizedText).uk,
      category: r.category,
      locality: r.locality,
      googlePlaceId: r.google_place_id!,
    }));
    const out: SeedRealPlacesResult = {
      skipped: places.length === 0,
      hotel: null,
      qrRepointed: 0,
      hostModuleCreated: false,
      staffAssigned: false,
      scenariosRebuilt: 0,
      placesArchived: 0,
    };
    if (out.skipped) return out;

    const hotel = pickRealHotel(places);
    if (hotel) {
      out.hotel = { id: hotel.id, name: hotel.name };
      // QR — те же коды: перепривязываем с демо-отеля (или пустые); перепривязку админкой на другое место не трогаем.
      for (const qr of [
        { code: SEED_HOTEL_QR_CODE, label: `${hotel.name} (демо-QR)` },
        { code: SEED_ROOM_QR.code, label: `${hotel.name} — номер ${SEED_ROOM_QR.room} (демо-QR)` },
      ]) {
        const r = await trx
          .updateTable("qr_points")
          .set({ place_id: hotel.id, label: qr.label, venue_name_i18n: { uk: hotel.name } })
          .where("code", "=", qr.code)
          .where((eb) =>
            eb.or([eb("place_id", "is", null), eb("place_id", "=", demoPlaceId(SEED_HOTEL_PLACE_KEY))]),
          )
          .executeTakeFirst();
        out.qrRepointed += Number(r.numUpdatedRows);
      }
      const inserted = await trx
        .insertInto("host_modules")
        .values({
          id: seedUuid("host-module:a:real-hotel"),
          region_id: a,
          place_id: hotel.id,
          wifi_ssid: "DEMO-SSID",
          wifi_password: "demo-placeholder",
          reception_phone: null,
          hours_from: null,
          hours_to: null,
          sections: JSON.stringify(REAL_SECTIONS),
          services: JSON.stringify(REAL_SERVICES),
        })
        .onConflict((oc) => oc.column("place_id").doNothing())
        .returning("id")
        .executeTakeFirst();
      out.hostModuleCreated = Boolean(inserted);
    }

    // Сценарии: пересобираем, пока они пустые или ссылаются на демо-места (после — правки админки не трогаем).
    for (const [i, s] of SEED_SCENARIOS.entries()) {
      const id = seedUuid(`scenario:a:${s.code}`);
      const current = await trx
        .selectFrom("scenario_items")
        .select(["place_id", "alternatives"])
        .where("scenario_id", "=", id)
        .execute();
      const exists = await trx.selectFrom("scenarios").select("id").where("id", "=", id).executeTakeFirst();
      const stale =
        current.length === 0 ||
        current.some((c) => demoSet.has(c.place_id) || c.alternatives.some((x) => demoSet.has(x)));
      if (exists && !stale) continue;
      const items = buildRealScenarioItems(s, places);
      if (items.length === 0) continue;
      if (exists) {
        await trx.deleteFrom("scenario_items").where("scenario_id", "=", id).execute();
        await trx
          .updateTable("scenarios")
          .set({ description_i18n: REAL_DESCRIPTIONS[s.code] ?? s.description, status: "published" })
          .where("id", "=", id)
          .execute();
      } else
        await trx
          .insertInto("scenarios")
          .values({
            id,
            region_id: a,
            code: s.code,
            title_i18n: s.title,
            description_i18n: REAL_DESCRIPTIONS[s.code] ?? s.description,
            days: s.days,
            tags: [...s.tags],
            status: "published",
            sort_order: i * 10,
          })
          .execute();
      await trx
        .insertInto("scenario_items")
        .values(
          items.map((it) => ({
            region_id: a,
            scenario_id: id,
            day_no: it.day,
            position: it.position,
            place_id: it.placeId,
            time_hint: it.time,
            duration_min: it.duration,
            note_i18n: it.note,
            alternatives: it.alternatives,
          })),
        )
        .execute();
      out.scenariosRebuilt++;
    }

    // Демо-места seed (только их id и source='manual') — в архив. Черновики (ни разу не опубликованы) остаются
    // черновиками: places_published_once не пускает их в archived, а туристу они и так не видны.
    const archived = await trx
      .updateTable("places")
      .set({ status: "archived" })
      .where("region_id", "=", a)
      .where("id", "in", demoIds)
      .where("source", "=", "manual")
      .where("status", "in", ["published", "suspended"])
      .returning(["id"])
      .execute();
    for (const p of archived)
      await audit.record(trx, {
        actor: { type: "system" },
        action: "place.archive",
        entityType: "place",
        entityId: p.id,
        regionId: a,
        reason: "seed --real-places: демо-місце замінено реальними місцями",
        newValues: { status: "archived" },
      });
    out.placesArchived = archived.length;
    return out;
  });
  if (result.hotel) result.staffAssigned = await assignStaff(db, result.hotel.id);
  return result;
}
