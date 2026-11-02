// Выгрузка из Google и разбор: Text Search по каждому пункту и запросу (с пагинацией), дедуп по id места, маппинг и
// статистика. Без БД — общий для --dry-run и записи.
import { IMPORT_LOCALITIES, IMPORT_QUERIES, type ImportLocality } from "./config.js";
import { RequestLimitError, type GooglePlacesClient } from "./google-client.js";
import { boundingBox, mapPlace, type GooglePlace, type MappedPlace, type SkipReason } from "./mapping.js";

/** Страниц на запрос: Text Search отдаёт до 20 мест на страницу и не больше 60 на запрос. */
export const MAX_PAGES = 3;

export type CollectStats = {
  /** Мест Google получено (до дедупа) и уникальных. */
  fetched: number;
  unique: number;
  imported: number;
  skipped: Record<SkipReason, number>;
  byLocality: Record<string, number>;
  byCategory: Record<string, number>;
  /** Типы Google мест без категории: тип (primaryType или первый тип) → сколько. */
  unmappedTypes: Record<string, number>;
  /** Примеры пропущенных без категории: название и типы. */
  unmappedExamples: string[];
  withPhone: number;
  withWebsite: number;
  withSchedule: number;
  scheduleDropped: number;
  withPhotos: number;
  /** Выгрузка остановлена лимитом запросов (данные неполные). */
  limitReached: boolean;
  queriesDone: number;
  queriesTotal: number;
};

export type CollectResult = { places: MappedPlace[]; stats: CollectStats };

const inc = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};

export async function collect(
  client: GooglePlacesClient,
  opts: {
    localities?: readonly ImportLocality[];
    queries?: readonly string[];
    categoryNames?: Readonly<Record<string, string>>;
    log?: (line: string) => void;
  } = {},
): Promise<CollectResult> {
  const localities = opts.localities ?? IMPORT_LOCALITIES;
  const queries = opts.queries ?? IMPORT_QUERIES;
  const log = opts.log ?? (() => {});
  const raw = new Map<string, GooglePlace>();
  let fetched = 0;
  let queriesDone = 0;
  let limitReached = false;

  outer: for (const locality of localities) {
    const box = boundingBox(locality.at, locality.radiusM);
    for (const textQuery of queries) {
      let pageToken: string | undefined;
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await client.searchText({
            textQuery,
            languageCode: "uk",
            regionCode: "UA",
            pageSize: 20,
            ...(pageToken ? { pageToken } : {}),
            locationRestriction: {
              rectangle: {
                low: { latitude: box.low.lat, longitude: box.low.lon },
                high: { latitude: box.high.lat, longitude: box.high.lon },
              },
            },
          });
          for (const p of res.places ?? []) {
            fetched++;
            if (p.id && !raw.has(p.id)) raw.set(p.id, p);
          }
          pageToken = res.nextPageToken;
          if (!pageToken) break;
        }
      } catch (err) {
        if (!(err instanceof RequestLimitError)) throw err;
        log(err.message);
        limitReached = true;
        break outer;
      }
      queriesDone++;
    }
    log(`${locality.code}: запросов выполнено, уникальных мест всего ${raw.size}`);
  }

  const stats: CollectStats = {
    fetched,
    unique: raw.size,
    imported: 0,
    skipped: { closed_permanently: 0, no_location: 0, outside_radius: 0, no_category: 0, no_name: 0 },
    byLocality: {},
    byCategory: {},
    unmappedTypes: {},
    unmappedExamples: [],
    withPhone: 0,
    withWebsite: 0,
    withSchedule: 0,
    scheduleDropped: 0,
    withPhotos: 0,
    limitReached,
    queriesDone,
    queriesTotal: localities.length * queries.length,
  };
  const places: MappedPlace[] = [];
  for (const p of raw.values()) {
    const r = mapPlace(p, localities, opts.categoryNames);
    if (!r.ok) {
      stats.skipped[r.reason]++;
      if (r.reason === "no_category") {
        inc(stats.unmappedTypes, p.primaryType ?? p.types?.[0] ?? "(нет типа)");
        if (stats.unmappedExamples.length < 30)
          stats.unmappedExamples.push(
            `${p.displayName?.text ?? p.id} [${(p.types ?? []).slice(0, 3).join(", ")}]`,
          );
      }
      continue;
    }
    const m = r.place;
    places.push(m);
    inc(stats.byLocality, m.localityCode);
    inc(stats.byCategory, m.categoryCode);
    if (m.phone) stats.withPhone++;
    if (m.website) stats.withWebsite++;
    if (m.week === null) stats.scheduleDropped++;
    else if (m.week.length) stats.withSchedule++;
    if (m.photos.length) stats.withPhotos++;
  }
  stats.imported = places.length;
  places.sort((a, b) => a.googlePlaceId.localeCompare(b.googlePlaceId));
  return { places, stats };
}
