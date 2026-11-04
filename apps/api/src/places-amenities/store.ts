// БД для places:amenities: места «Де жити» (раздел главной stay и его подкатегории: hotels, sadyby), их теги
// удобств и прошлые прогоны; план изменений (чистая функция) и запись в одной транзакции с аудитом place.amenities.
// Защита ручного: места, где теги правили люди (tagsTouched — как у импорта), не трогаются; удаляются только теги,
// поставленные самим places:amenities по отзывам (source reviews), и только если новое извлечение их не подтвердило.
import { sql } from "kysely";
import { regionContext, withTenant, type Db, type PlaceEnrichmentGoogle } from "../db/index.js";
import type { PlaceTagSource } from "../db/schema.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../modules/audit/index.js";
import { tagsTouched } from "../places-import/writer.js";
import { AMENITY_CODES, AMENITY_TAG, AMENITY_TAG_DEFS, type AmenityCode, type Finding } from "./amenities.js";

export const AMENITIES_ACTION = "place.amenities";

export type LodgingPlace = {
  id: string;
  name: string;
  category: string;
  google: Pick<PlaceEnrichmentGoogle, "summary" | "reviews" | "amenities"> | null;
  /** Теги правили люди — место пропускается. */
  touched: boolean;
  /** Текущие теги удобств места: код удобства → источник. */
  tags: Map<AmenityCode, PlaceTagSource>;
  /** Хэш входа последнего применённого извлечения (аудит place.amenities); null — не было. */
  appliedHash: string | null;
};

export type LodgingState = {
  regionId: string;
  places: LodgingPlace[];
  /** Миграция 0029 (place_tags.source) применена — без неё возможен только --dry-run. */
  hasSourceColumn: boolean;
};

const TAG_TO_AMENITY = new Map(AMENITY_CODES.map((c) => [AMENITY_TAG[c], c] as const));

export async function loadLodging(db: Db, regionCode: string): Promise<LodgingState> {
  const region = await db
    .selectFrom("regions")
    .select("id")
    .where("code", "=", regionCode)
    .executeTakeFirst();
  if (!region) throw new Error(`Регион ${regionCode} не найден`);
  // Столбец 0029 — по каталогу БД (introspection Kysely: pg_catalog, не tenant-таблицы).
  const hasSourceColumn = (await db.introspection.getTables()).some(
    (t) => t.name === "place_tags" && t.columns.some((c) => c.name === "source"),
  );
  return withTenant(db, regionContext(region.id), async (trx) => {
    const rows = await trx
      .selectFrom("places")
      .innerJoin("categories as c", "c.id", "places.category_id")
      .leftJoin("categories as parent", "parent.id", "c.parent_id")
      .leftJoin("place_enrichments as e", "e.place_id", "places.id")
      .select([
        "places.id",
        sql<string>`places.name_i18n ->> 'uk'`.as("name"),
        "c.code as category",
        "e.google",
        (eb) => tagsTouched(eb).as("touched"),
      ])
      .where("places.status", "=", "published")
      .where((eb) => eb.or([eb("c.home_section", "=", "stay"), eb("parent.home_section", "=", "stay")]))
      .orderBy("places.id")
      .execute();
    const ids = rows.map((r) => r.id);
    const tagRows = ids.length
      ? await trx
          .selectFrom("place_tags as pt")
          .innerJoin("tags as t", "t.id", "pt.tag_id")
          .select([
            "pt.place_id",
            "t.code",
            hasSourceColumn
              ? sql<PlaceTagSource>`pt.source`.as("source")
              : sql<PlaceTagSource>`'manual'`.as("source"),
          ])
          .where("t.code", "in", [...TAG_TO_AMENITY.keys()])
          .execute()
      : [];
    const audits = await trx
      .selectFrom("audit_logs")
      .select(["entity_id", "new_values"])
      .where("action", "=", AMENITIES_ACTION)
      .where("entity_type", "=", "place")
      .orderBy("created_at")
      .execute();
    const applied = new Map<string, string>();
    for (const a of audits) {
      const hash = a.new_values?.inputHash;
      if (a.entity_id && typeof hash === "string") applied.set(a.entity_id, hash);
    }
    const tags = new Map<string, Map<AmenityCode, PlaceTagSource>>();
    for (const t of tagRows) {
      const code = TAG_TO_AMENITY.get(t.code);
      if (!code) continue;
      if (!tags.has(t.place_id)) tags.set(t.place_id, new Map());
      tags.get(t.place_id)!.set(code, t.source);
    }
    return {
      regionId: region.id,
      hasSourceColumn,
      places: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        google: r.google,
        touched: Boolean(r.touched),
        tags: tags.get(r.id) ?? new Map(),
        appliedHash: applied.get(r.id) ?? null,
      })),
    };
  });
}

/** Что известно о месте после прогона: структурированные удобства и (если извлекали) находки по отзывам. */
export type AmenityResult = {
  placeId: string;
  structured: readonly AmenityCode[];
  /** null — по отзывам не извлекали в этот раз (теги reviews не трогаются). */
  reviews: readonly Finding[] | null;
  /** Хэш входа извлечения (null — без извлечения). */
  hash: string | null;
};

export type PlaceChange = {
  placeId: string;
  name: string;
  add: { code: AmenityCode; source: "import" | "reviews"; evidence?: string }[];
  /** Тег reviews подтверждён структурированными данными Google — источник становится import. */
  upgrade: AmenityCode[];
  /** Теги reviews, которые новое извлечение не подтвердило. */
  remove: AmenityCode[];
  /** Записать аудит даже без изменений: новое извлечение (место считается обработанным при продолжении). */
  hash: string | null;
  evidence: Partial<Record<AmenityCode, string>>;
};

/** План изменений тегов (без БД). Места с ручными тегами — в skippedTouched. */
export function planChanges(
  places: readonly LodgingPlace[],
  results: readonly AmenityResult[],
): { changes: PlaceChange[]; skippedTouched: string[] } {
  const byId = new Map(places.map((p) => [p.id, p]));
  const changes: PlaceChange[] = [];
  const skippedTouched: string[] = [];
  for (const r of results) {
    const p = byId.get(r.placeId);
    if (!p) continue;
    if (p.touched) {
      skippedTouched.push(p.id);
      continue;
    }
    const desired = new Map<AmenityCode, "import" | "reviews">();
    const evidence: Partial<Record<AmenityCode, string>> = {};
    for (const f of r.reviews ?? []) {
      desired.set(f.code, "reviews");
      evidence[f.code] = f.evidence;
    }
    for (const c of r.structured) desired.set(c, "import");
    const change: PlaceChange = {
      placeId: p.id,
      name: p.name,
      add: [],
      upgrade: [],
      remove: [],
      hash: r.hash && r.hash !== p.appliedHash ? r.hash : null,
      evidence,
    };
    for (const code of AMENITY_CODES) {
      const want = desired.get(code);
      const have = p.tags.get(code);
      if (want && !have)
        change.add.push({ code, source: want, ...(evidence[code] ? { evidence: evidence[code] } : {}) });
      else if (want === "import" && have === "reviews") change.upgrade.push(code);
      else if (!want && have === "reviews" && r.reviews !== null) change.remove.push(code);
    }
    if (change.add.length || change.upgrade.length || change.remove.length || change.hash)
      changes.push(change);
  }
  return { changes, skippedTouched };
}

export type ApplyStats = {
  tagsCreated: string[];
  added: number;
  upgraded: number;
  removed: number;
  audited: number;
  /** Места, где за время прогона люди поправили теги (перепроверка в транзакции). */
  skippedTouched: number;
};

/** Запись плана в одной транзакции (tenant-контекст региона): теги каталога, связи, аудит каждого места. */
export async function applyChanges(
  db: Db,
  regionId: string,
  changes: readonly PlaceChange[],
  meta: { model: string },
): Promise<ApplyStats> {
  const audit = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);
  const stats: ApplyStats = {
    tagsCreated: [],
    added: 0,
    upgraded: 0,
    removed: 0,
    audited: 0,
    skippedTouched: 0,
  };
  await withTenant(db, regionContext(regionId), async (trx) => {
    const created = await trx
      .insertInto("tags")
      .values(
        AMENITY_TAG_DEFS.map((t) => ({
          region_id: regionId,
          code: t.code,
          name_i18n: t.name,
          tag_group: t.group,
          sort_order: t.sortOrder,
        })),
      )
      .onConflict((oc) => oc.columns(["region_id", "code"]).doNothing())
      .returning("code")
      .execute();
    stats.tagsCreated = created.map((c) => c.code);
    const tagId = new Map(
      (
        await trx
          .selectFrom("tags")
          .select(["id", "code"])
          .where(
            "code",
            "in",
            AMENITY_CODES.map((c) => AMENITY_TAG[c]),
          )
          .execute()
      ).map((t) => [t.code, t.id] as const),
    );
    const ids = changes.map((c) => c.placeId);
    // Перепроверка ручной правки внутри транзакции: пока шёл прогон, в админке могли поправить теги.
    const touched = new Set(
      ids.length
        ? (
            await trx
              .selectFrom("places")
              .select("places.id")
              .where("places.id", "in", ids)
              .where((eb) => tagsTouched(eb))
              .execute()
          ).map((r) => r.id)
        : [],
    );
    for (const c of changes) {
      if (touched.has(c.placeId)) {
        stats.skippedTouched++;
        continue;
      }
      const tid = (code: AmenityCode) => tagId.get(AMENITY_TAG[code])!;
      const added: Record<string, string> = {};
      if (c.add.length) {
        const rows = await trx
          .insertInto("place_tags")
          .values(
            c.add.map((a) => ({
              region_id: regionId,
              place_id: c.placeId,
              tag_id: tid(a.code),
              source: a.source,
            })),
          )
          .onConflict((oc) => oc.columns(["place_id", "tag_id"]).doNothing())
          .returning("tag_id")
          .execute();
        const written = new Set(rows.map((r) => r.tag_id));
        for (const a of c.add) if (written.has(tid(a.code))) added[a.code] = a.source;
      }
      let upgraded: AmenityCode[] = [];
      if (c.upgrade.length) {
        const rows = await trx
          .updateTable("place_tags")
          .set({ source: "import" })
          .where("place_id", "=", c.placeId)
          .where("tag_id", "in", c.upgrade.map(tid))
          .where("source", "=", "reviews")
          .returning("tag_id")
          .execute();
        upgraded = c.upgrade.filter((code) => rows.some((r) => r.tag_id === tid(code)));
      }
      let removed: AmenityCode[] = [];
      if (c.remove.length) {
        const rows = await trx
          .deleteFrom("place_tags")
          .where("place_id", "=", c.placeId)
          .where("tag_id", "in", c.remove.map(tid))
          .where("source", "=", "reviews")
          .returning("tag_id")
          .execute();
        removed = c.remove.filter((code) => rows.some((r) => r.tag_id === tid(code)));
      }
      const n = Object.keys(added).length;
      stats.added += n;
      stats.upgraded += upgraded.length;
      stats.removed += removed.length;
      if (!n && !upgraded.length && !removed.length && !c.hash) continue;
      await audit.record(trx as unknown as Db, {
        actor: { type: "system" },
        action: AMENITIES_ACTION,
        entityType: "place",
        entityId: c.placeId,
        newValues: {
          added,
          upgraded,
          removed,
          evidence: c.evidence,
          ...(c.hash ? { inputHash: c.hash } : {}),
          model: meta.model,
        },
        reason: "удобства «Де жити»: структуровані дані й відгуки Google (places:amenities)",
      });
      stats.audited++;
    }
  });
  return stats;
}
