// Выгрузка из Google и разбор: Text Search по каждому пункту и запросу (с пагинацией), дедуп по id места, маппинг и
// статистика. Без БД — общий для --dry-run и записи.
import {
  IMPORT_LOCALITIES,
  IMPORT_QUERIES,
  SEARCH_ZONES,
  type ImportLocality,
  type SearchZone,
} from "./config.js";
import {
  GoogleApiError,
  GoogleRateLimitedError,
  PlannedRequest,
  RequestLimitError,
  type GooglePlacesClient,
  type SearchTextRequest,
} from "./google-client.js";
import {
  boundingBox,
  GOOGLE_PLACE_ID,
  mapPlace,
  localityOf,
  type GooglePlace,
  type MappedPlace,
  type SkipReason,
} from "./mapping.js";

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
  /** Часы у Google есть, но не разобраны (пересечения, вне диапазона) — график не пишется. */
  scheduleDropped: number;
  /** Страницы с pageToken, отклонённые Google (400: токен устарел) — пропущены, кэш предыдущей страницы сброшен. */
  pagesFailed: number;
  withPhotos: number;
  /** Выгрузка остановлена лимитом запросов (данные неполные). */
  limitReached: boolean;
  queriesDone: number;
  queriesTotal: number;
};

export type CollectResult = {
  places: MappedPlace[];
  stats: CollectStats;
  /** Закрытые навсегда (в радиусе пунктов): уже импортированные такие места снимаются с публикации. */
  closedIds: string[];
  /**
   * id мест в радиусе, которые по текущим правилам не наши (без категории: метки «только название пункта»,
   * поштомати, табори…) — уже импортированные такие места запись архивирует, если админка их не трогала.
   */
  rejectedIds: string[];
  /** Все id, которые Google вернул за прогон (для отчёта «пропали из выдачи»). */
  seenIds: string[];
  /** Ответы Google по id (рейтинг, описание, тип, имена фото) — places:enrich --from-import-cache. */
  rawById: ReadonlyMap<string, GooglePlace>;
};

const inc = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};

export async function collect(
  client: GooglePlacesClient,
  opts: {
    localities?: readonly ImportLocality[];
    /** Дополнительные зоны поиска (по умолчанию SEARCH_ZONES; при заданных localities — без зон). */
    zones?: readonly SearchZone[];
    /** Искать только в зонах (круги пунктов не запрашиваются): дозагрузка новых зон. */
    zonesOnly?: boolean;
    queries?: readonly string[];
    categoryNames?: Readonly<Record<string, string>>;
    log?: (line: string) => void;
  } = {},
): Promise<CollectResult> {
  const localities = opts.localities ?? IMPORT_LOCALITIES;
  const zones = opts.zones ?? (opts.localities ? [] : SEARCH_ZONES);
  const queries = opts.queries ?? IMPORT_QUERIES;
  const log = opts.log ?? (() => {});
  const raw = new Map<string, GooglePlace>();
  let fetched = 0;
  let queriesDone = 0;
  let limitReached = false;
  let pagesFailed = 0;
  /** Области поиска: круги пунктов, затем зоны. */
  const areas: readonly { code: string; at: ImportLocality["at"]; radiusM: number }[] = [
    ...(opts.zonesOnly ? [] : localities),
    ...zones,
  ];

  outer: for (const locality of areas) {
    const box = boundingBox(locality.at, locality.radiusM);
    for (const textQuery of queries) {
      let pageToken: string | undefined;
      /** Запросы цепочки страниц этого запроса: при устаревшем токене кэш сбрасывается целиком. */
      const chain: SearchTextRequest[] = [];
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const request: SearchTextRequest = {
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
          };
          let res;
          try {
            res = await client.searchText(request);
          } catch (err) {
            // Оценка (planOnly): ответа нет в кэше — запрос учтён клиентом, дальше страниц не узнать.
            if (err instanceof PlannedRequest) break;
            // Токен следующей страницы из кэша устарел: страница пропускается, кэш предыдущей сбрасывается —
            // следующий прогон запросит её заново со свежим токеном.
            if (!(err instanceof GoogleApiError && err.status === 400 && pageToken && chain.length))
              throw err;
            log(`${locality.code} «${textQuery}»: страница ${page + 1} отклонена Google (400), пропущена`);
            pagesFailed++;
            for (const r of chain) await client.forgetSearch(r);
            break;
          }
          chain.push(request);
          for (const p of res.places ?? []) {
            fetched++;
            if (p.id && !raw.has(p.id)) raw.set(p.id, p);
          }
          pageToken = res.nextPageToken;
          if (!pageToken) break;
        }
      } catch (err) {
        if (!(err instanceof RequestLimitError || err instanceof GoogleRateLimitedError)) throw err;
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
    skipped: {
      closed_permanently: 0,
      invalid_id: 0,
      no_location: 0,
      outside_radius: 0,
      no_category: 0,
      no_name: 0,
    },
    byLocality: {},
    byCategory: {},
    unmappedTypes: {},
    unmappedExamples: [],
    withPhone: 0,
    withWebsite: 0,
    withSchedule: 0,
    scheduleDropped: 0,
    pagesFailed,
    withPhotos: 0,
    limitReached,
    queriesDone,
    queriesTotal: areas.length * queries.length,
  };
  const places: MappedPlace[] = [];
  const closedIds: string[] = [];
  const rejectedIds: string[] = [];
  for (const p of raw.values()) {
    const r = mapPlace(p, localities, opts.categoryNames, undefined, zones);
    if (!r.ok) {
      stats.skipped[r.reason]++;
      const lat = p.location?.latitude;
      const lon = p.location?.longitude;
      if (
        r.reason === "closed_permanently" &&
        GOOGLE_PLACE_ID.test(p.id) &&
        typeof lat === "number" &&
        typeof lon === "number" &&
        localityOf({ lon, lat }, localities, zones)
      )
        closedIds.push(p.id);
      if (r.reason === "no_category") {
        rejectedIds.push(p.id);
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
    if (m.week) stats.withSchedule++;
    else if (raw.get(m.googlePlaceId)?.regularOpeningHours?.periods?.length) stats.scheduleDropped++;
    if (m.photos.length) stats.withPhotos++;
  }
  stats.imported = places.length;
  places.sort((a, b) => a.googlePlaceId.localeCompare(b.googlePlaceId));
  return { places, stats, closedIds, rejectedIds, seenIds: [...raw.keys()], rawById: raw };
}
