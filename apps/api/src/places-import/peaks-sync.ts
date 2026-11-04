// CLI peaks:sync (раздел «Вершини»): места вершин из peaks.ts в каталоге региона. Без дублей: место ищется по
// google_place_id из peaks.ts, затем по названию в радиусе MATCH_RADIUS_M от вершины — только природа/пам'ятки/
// активности/вершины, без жилья, еды и сервисов в названии (NOT_PEAK_RE). Найденное по названию НЕ меняется (ни
// категория, ни обложка) — только в отчёт: id вписать в peaks.ts вручную. Недостающие — точечным Text Search (по
// одному запросу, только вставка: найденное Google место, которое уже есть в регионе, не обновляется). Места по id и
// вставленные — в подкатегорию peaks адресно (UPDATE по id); обложка — файл Wikimedia Commons из peaks.ts (с автором и
// лицензией), если обложки нет или она из Google / без автора. Изменения и аудит — одной транзакцией (обложки
// скачиваются до неё).
import { sql, type Expression } from "kysely";
import { point, regionContext, withinMeters, withTenant, type Db, type Geometry } from "../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS } from "../modules/audit/index.js";
import { makeCover, type Cover, type Resize } from "../places-enrich/covers.js";
import type { WikipediaClient } from "../places-enrich/wikipedia.js";
import { IMPORT_EXTRA_CATEGORIES } from "./config.js";
import type { GooglePlacesClient } from "./google-client.js";
import { haversineMeters, type MappedPlace } from "./mapping.js";
import { PEAKS, PEAKS_CATEGORY_CODE, type PeakData } from "./peaks.js";
import { collectTargeted, type TargetedQuery } from "./targeted.js";
import { CATEGORY_NAMES, findRegionId, writePlaces } from "./writer.js";

/** Запасной поиск по названию — только в этих категориях (не отель «Драгобрат», не колиба «Говерла»). */
export const NAME_MATCH_CATEGORIES = ["nature", "sights", "active", PEAKS_CATEGORY_CODE];
/** Жильё, еда, сервисы, музеи, лыжная инфраструктура и туры в названии — не сама вершина. */
export const NOT_PEAK_RE = new RegExp(
  "(^|[^\\p{L}])(" +
    [
      "готел\\p{L}*|hotel\\p{L}*|садиб\\p{L}*|котедж\\p{L}*|cottage\\p{L}*|хостел\\p{L}*|hostel\\p{L}*",
      "апарт\\p{L}*|apart\\p{L}*|резорт\\p{L}*|resort\\p{L}*|курорт\\p{L}*|база|villa|вілла|віла",
      "колиб\\p{L}*|ресторан\\p{L}*|restaurant\\p{L}*|кафе|cafe|бар|bar|піцер\\p{L}*",
      "прокат\\p{L}*|rent\\p{L}*|магазин\\p{L}*|shop\\p{L}*|spa|спа|чан\\p{L}*|музе\\p{L}*|museum",
      "підйомник\\p{L}*|витяг\\p{L}*|lift|трас\\p{L}*|ski|лиж\\p{L}*|тур|тури|tour\\p{L}*",
    ].join("|") +
    ")([^\\p{L}]|$)",
  "iu",
);

/** Название подходит вершине: совпадает с search.match и не жильё/еда/сервис. */
export const peakNameMatches = (peak: PeakData, name: string): boolean =>
  Boolean(peak.search?.match.test(name)) && !NOT_PEAK_RE.test(name);

/** Место «той же вершины» — не дальше, м (точка Google и Wikidata расходятся на сотни метров). */
export const MATCH_RADIUS_M = 1_500;
/** Область поиска Google вокруг вершины, м. */
export const SEARCH_RADIUS_M = 2_000;

export type ExistingPlace = {
  id: string;
  google_place_id: string | null;
  name: string;
  category_code: string;
  status: string;
  cover_source: "google" | "wikimedia" | null;
  cover_author: string | null;
};

export type PeakPlan = {
  peak: PeakData;
  /** Место в регионе (было до прогона); null — нет. */
  place: ExistingPlace | null;
  /** Как найдено: по id из peaks.ts или по названию рядом. */
  matchedBy: "google_place_id" | "name" | null;
};

/** Обложку из Commons ставим: нет обложки, она из Google или без автора («Own work»). */
export function needsCommonsCover(p: ExistingPlace | null, peak: PeakData): boolean {
  if (!peak.commonsFile) return false;
  if (!p?.cover_source) return true;
  if (p.cover_source === "google") return true;
  const a = p.cover_author?.trim() ?? "";
  return !a || /^own work$/i.test(a);
}

/** Text Search для вершин без места (только у которых есть search). */
export function searchQueries(plans: readonly PeakPlan[]): { peak: PeakData; query: TargetedQuery }[] {
  return plans.flatMap(({ peak, place }) =>
    !place && peak.search
      ? [
          {
            peak,
            query: {
              query: peak.search.query,
              category: PEAKS_CATEGORY_CODE,
              near: peak.location,
              radiusM: SEARCH_RADIUS_M,
              take: 1,
            },
          },
        ]
      : [],
  );
}

/**
 * Из найденного Google — только новые места с подходящим названием (match): чужой результат («готель Драгобрат») и
 * уже существующее в регионе место отбрасываются (вставка без обновления).
 */
export function pickNewPeakPlaces(
  found: readonly MappedPlace[],
  queries: readonly { peak: PeakData; query: TargetedQuery }[],
  existingGoogleIds: ReadonlySet<string>,
): { peak: PeakData; place: MappedPlace }[] {
  const out: { peak: PeakData; place: MappedPlace }[] = [];
  const used = new Set<string>();
  for (const { peak } of queries) {
    const hit = found.find(
      (p) =>
        !used.has(p.googlePlaceId) &&
        peakNameMatches(peak, p.name) &&
        haversineMeters(p.at, peak.location) <= SEARCH_RADIUS_M,
    );
    if (!hit || existingGoogleIds.has(hit.googlePlaceId)) continue;
    used.add(hit.googlePlaceId);
    out.push({ peak, place: hit });
  }
  return out;
}

/**
 * Места вершин в регионе: по google_place_id из peaks.ts (или из extraIds — вставленные в этом прогоне), иначе по
 * названию рядом с вершиной (NAME_MATCH_CATEGORIES, peakNameMatches — только для отчёта).
 */
export async function planPeaks(
  db: Db,
  regionId: string,
  extraIds: ReadonlyMap<string, string> = new Map(),
): Promise<PeakPlan[]> {
  const idOf = (p: PeakData) => p.googlePlaceId ?? extraIds.get(p.slug) ?? null;
  return withTenant(db, regionContext(regionId), async (trx) => {
    const base = () =>
      trx
        .selectFrom("places")
        .innerJoin("categories", "categories.id", "places.category_id")
        .leftJoin("place_cover_photos", "place_cover_photos.place_id", "places.id")
        .select([
          "places.id",
          "places.google_place_id",
          sql<string>`places.name_i18n->>'uk'`.as("name"),
          "categories.code as category_code",
          "places.status",
          "place_cover_photos.source as cover_source",
          sql<string | null>`place_cover_photos.author_attributions->0->>'name'`.as("cover_author"),
        ])
        .where("places.region_id", "=", regionId)
        .where("places.status", "!=", "archived");
    const ids = PEAKS.flatMap((p) => idOf(p) ?? []);
    const byId = new Map(
      (ids.length ? await base().where("places.google_place_id", "in", ids).execute() : []).map((r) => [
        r.google_place_id!,
        r as ExistingPlace,
      ]),
    );
    const plans: PeakPlan[] = [];
    for (const peak of PEAKS) {
      const id = idOf(peak);
      const known = id ? byId.get(id) : undefined;
      if (known) {
        plans.push({ peak, place: known, matchedBy: "google_place_id" });
        continue;
      }
      const near = peak.search
        ? (
            (await base()
              .where("categories.code", "in", NAME_MATCH_CATEGORIES)
              .where((eb) =>
                withinMeters(
                  eb.ref("places.location") as Expression<Geometry>,
                  point(peak.location),
                  MATCH_RADIUS_M,
                ),
              )
              .execute()) as ExistingPlace[]
          ).filter((r) => peakNameMatches(peak, r.name))
        : [];
      plans.push({ peak, place: near[0] ?? null, matchedBy: near[0] ? "name" : null });
    }
    return plans;
  });
}

export type SyncStats = {
  regionId: string;
  googleQueries: number;
  inserted: { slug: string; googlePlaceId: string; name: string }[];
  notFound: string[];
  categoryCreated: boolean;
  recategorized: { slug: string; placeId: string; from: string }[];
  /** Найдено только по названию — не изменено; проверить и вписать googlePlaceId в peaks.ts. */
  nameMatched: {
    slug: string;
    placeId: string;
    name: string;
    category: string;
    googlePlaceId: string | null;
  }[];
  covers: { slug: string; status: "written" | "kept" | "none" | "skipped" | "failed"; detail?: string }[];
};

/** Подкатегория peaks под корнем nearby (если её ещё нет — как у импорта: ON CONFLICT DO NOTHING). */
async function ensureCategory(db: Db, regionId: string): Promise<boolean> {
  const def = IMPORT_EXTRA_CATEGORIES.find((c) => c.code === PEAKS_CATEGORY_CODE)!;
  return withTenant(db, regionContext(regionId), async (trx) => {
    const root = await trx
      .selectFrom("categories")
      .select("id")
      .where("region_id", "=", regionId)
      .where("code", "=", def.parent)
      .where("parent_id", "is", null)
      .executeTakeFirst();
    if (!root) throw new Error(`Нет корневой категории ${def.parent} (нужен каталог seed)`);
    const created = await trx
      .insertInto("categories")
      .values({
        region_id: regionId,
        parent_id: root.id,
        code: def.code,
        name_i18n: def.name,
        icon: def.icon,
        sort_order: 5,
      })
      .onConflict((oc) => oc.columns(["region_id", "code"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    return Boolean(created);
  });
}

async function writeCoverById(db: Db, regionId: string, placeId: string, c: Cover): Promise<void> {
  await withTenant(db, regionContext(regionId), async (trx) => {
    const values = {
      bytes: c.bytes,
      mime: c.mime,
      width: c.width,
      height: c.height,
      author_attributions: JSON.stringify(c.authors),
      license: c.license,
      source_url: c.sourceUrl,
      source: c.source,
      photo_name: c.photoName,
      fetched_at: new Date(),
    };
    await trx
      .insertInto("place_cover_photos")
      .values({ region_id: regionId, place_id: placeId, ...values })
      .onConflict((oc) => oc.columns(["region_id", "place_id"]).doUpdateSet(values))
      .execute();
  });
}

export type SyncDeps = {
  db: Db;
  regionCode: string;
  google: GooglePlacesClient;
  wiki: WikipediaClient;
  /** false — только план/отчёт (Google и Commons по кэшу/сети по флагам), без записи в БД. */
  write: boolean;
  /** Искать недостающие вершины в Google. */
  importMissing: boolean;
  covers: boolean;
  resize?: Resize;
  fetch?: typeof fetch;
  log?: (s: string) => void;
};

export async function syncPeaks(deps: SyncDeps): Promise<{ plans: PeakPlan[]; stats: SyncStats }> {
  const log = deps.log ?? (() => {});
  const regionId = await findRegionId(deps.db, deps.regionCode);
  let plans = await planPeaks(deps.db, regionId);
  const stats: SyncStats = {
    regionId,
    googleQueries: 0,
    inserted: [],
    notFound: [],
    categoryCreated: false,
    recategorized: [],
    nameMatched: nameMatchedOf(plans),
    covers: [],
  };

  // 1. Недостающие — Google Text Search (вставка — ниже, в транзакции записи).
  let fresh: { peak: PeakData; place: MappedPlace }[] = [];
  const queries = searchQueries(plans);
  if (deps.importMissing && queries.length) {
    const res = await collectTargeted(
      deps.google,
      queries.map((q) => q.query),
      CATEGORY_NAMES,
      log,
    );
    stats.googleQueries = res.queriesDone;
    const existing = await withTenant(deps.db, regionContext(regionId), async (trx) =>
      (
        await trx
          .selectFrom("places")
          .select("google_place_id")
          .where("region_id", "=", regionId)
          .where("google_place_id", "is not", null)
          .execute()
      ).map((r) => r.google_place_id!),
    );
    fresh = pickNewPeakPlaces(res.places, queries, new Set(existing));
    const freshSlugs = new Set(fresh.map((f) => f.peak.slug));
    stats.notFound = queries.filter((q) => !freshSlugs.has(q.peak.slug)).map((q) => q.peak.slug);
    for (const f of fresh)
      stats.inserted.push({ slug: f.peak.slug, googlePlaceId: f.place.googlePlaceId, name: f.place.name });
  }
  const freshIds = new Map(fresh.map((f) => [f.peak.slug, f.place.googlePlaceId]));
  /** Меняем только место по id из peaks.ts или вставленное сейчас; найденное по названию — нет. */
  const touchable = (p: PeakPlan) => isTouchable(p, freshIds);
  const skipDetail = (p: PeakPlan) => (p.place ? "найдено по названию — не меняем" : "места нет");

  if (!deps.write) {
    for (const p of plans) {
      const needs = touchable(p) && needsCommonsCover(p.place, p.peak);
      stats.covers.push({
        slug: p.peak.slug,
        status: !touchable(p) ? "skipped" : needs ? "none" : "kept",
        detail: !touchable(p) ? skipDetail(p) : needs ? "будет записана" : undefined,
      });
    }
    return { plans, stats };
  }

  // 2. Обложки Commons — скачиваются до транзакции (сеть не держит транзакцию открытой).
  const covers = new Map<string, { cover: Cover; detail: string }>();
  for (const p of plans) {
    if (!deps.covers || !touchable(p)) {
      stats.covers.push({
        slug: p.peak.slug,
        status: "skipped",
        detail: !touchable(p) ? skipDetail(p) : undefined,
      });
      continue;
    }
    if (!needsCommonsCover(p.place, p.peak)) {
      stats.covers.push({
        slug: p.peak.slug,
        status: p.peak.commonsFile ? "kept" : "none",
        detail: p.place?.cover_source ?? "нет файла Commons",
      });
      continue;
    }
    try {
      const image = await deps.wiki.commonsImage(p.peak.commonsFile!, { requireAuthor: true });
      if (!image) {
        stats.covers.push({ slug: p.peak.slug, status: "failed", detail: "Commons: нет автора/лицензии" });
        continue;
      }
      const cover = await makeCover(
        {
          google: null,
          wiki: { lang: "uk", title: p.peak.name.uk, url: image.sourceUrl, extract: "", image },
        },
        { google: deps.google, resize: deps.resize, fetch: deps.fetch, googleStopped: true },
      );
      if (!cover) {
        stats.covers.push({ slug: p.peak.slug, status: "failed", detail: "не скачалась" });
        continue;
      }
      covers.set(p.peak.slug, { cover, detail: `${image.author} · ${image.license}` });
    } catch (err) {
      stats.covers.push({
        slug: p.peak.slug,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Запись — одна транзакция: подкатегория, вставка, перенос в peaks, обложки и аудит (вложенные withTenant с тем
  // же регионом идут в этой же транзакции).
  plans = await withTenant(deps.db, regionContext(regionId), async (trx) => {
    stats.categoryCreated = await ensureCategory(deps.db, regionId);
    if (fresh.length)
      // Только новые места (pinCategory: категория запроса закреплена — общий импорт её не переразметит).
      await writePlaces(
        deps.db,
        deps.regionCode,
        // Название — из peaks.ts (Вікіпедія): у Google бывает латиницей («Hora Kukul»).
        fresh.map((f) => ({ ...f.place, name: f.peak.name.uk })),
        new Date(),
        { pinCategory: true },
      );
    // Вставленные находятся по своему id Google (вписать в peaks.ts по отчёту).
    const after = fresh.length ? await planPeaks(deps.db, regionId, freshIds) : plans;
    const cat = await trx
      .selectFrom("categories")
      .select("id")
      .where("region_id", "=", regionId)
      .where("code", "=", PEAKS_CATEGORY_CODE)
      .executeTakeFirstOrThrow();
    for (const p of after) {
      if (p.matchedBy !== "google_place_id" || !p.place || p.place.category_code === PEAKS_CATEGORY_CODE)
        continue;
      await trx
        .updateTable("places")
        .set({ category_id: cat.id })
        .where("region_id", "=", regionId)
        .where("id", "=", p.place.id)
        .execute();
      stats.recategorized.push({ slug: p.peak.slug, placeId: p.place.id, from: p.place.category_code });
    }
    for (const [slug, { cover, detail }] of covers) {
      const place = after.find((p) => p.peak.slug === slug && p.matchedBy === "google_place_id")?.place;
      if (!place) {
        stats.covers.push({ slug, status: "failed", detail: "места нет после вставки" });
        continue;
      }
      await writeCoverById(deps.db, regionId, place.id, cover);
      stats.covers.push({ slug, status: "written", detail });
    }
    await new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS).record(trx, {
      actor: { type: "system" },
      action: "place.peaks_sync",
      entityType: "region",
      entityId: regionId,
      newValues: {
        categoryCreated: stats.categoryCreated,
        inserted: stats.inserted,
        recategorized: stats.recategorized,
        nameMatched: stats.nameMatched.map((m) => ({ slug: m.slug, placeId: m.placeId })),
        coversWritten: stats.covers.filter((c) => c.status === "written").map((c) => c.slug),
      },
      reason: "peaks:sync",
    });
    return after;
  });
  return { plans, stats };
}

/** Найденные только по названию — в отчёт (не меняются). */
export function nameMatchedOf(plans: readonly PeakPlan[]): SyncStats["nameMatched"] {
  return plans.flatMap((p) =>
    p.place && p.matchedBy === "name"
      ? [
          {
            slug: p.peak.slug,
            placeId: p.place.id,
            name: p.place.name,
            category: p.place.category_code,
            googlePlaceId: p.place.google_place_id,
          },
        ]
      : [],
  );
}

/** Место можно менять (категория, обложка): найдено по id из peaks.ts или вставлено в этом прогоне. */
export const isTouchable = (p: PeakPlan, freshIds: ReadonlyMap<string, string> = new Map()): boolean =>
  p.matchedBy === "google_place_id" || freshIds.has(p.peak.slug);
