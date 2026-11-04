// Сбор обогащения мест (places:enrich) без БД: Google Place Details по каждому месту (кэш ответов), Вікіпедія для
// пам'яток. Общий для --plan (только оценка), --dry-run и записи. Запросы мимо кэша ограничены лимитами клиентов.
import type { PlaceEnrichmentGoogle, PlaceEnrichmentWiki } from "../db/index.js";
import {
  GoogleRateLimitedError,
  MonthlyLimitError,
  NoApiKeyError,
  RequestLimitError,
  type GooglePlacesClient,
} from "../places-import/google-client.js";
import type { GooglePlace, MappedPlace } from "../places-import/mapping.js";
import { fromSearch, hasGoogleData, normalizeDetails } from "./details.js";
import {
  findWikipedia,
  WIKI_CATEGORIES,
  WikiLimitError,
  WikiUnavailableError,
  type WikipediaClient,
} from "./wikipedia.js";
import { findWikipediaStrict, WIKIMEDIA_CATEGORIES } from "./wiki-match.js";

export type EnrichedPlace = {
  googlePlaceId: string;
  name: string;
  categoryCode: string;
  localityCode: string;
  address: string | null;
  /** null — Details не получены (лимит, план, Google не знает места). */
  google: PlaceEnrichmentGoogle | null;
  /**
   * google собран из кэша импорта (--from-import-cache), без Details: беднее сохранённого — запись не затирает им
   * непустые поля и не снимает текст ИИ.
   */
  googleFromImport?: boolean;
  /** undefined — Вікіпедія не искалась (не пам'ятка или лимит); null — искали, уверенного совпадения нет. */
  wiki: PlaceEnrichmentWiki | null | undefined;
};

export type EnrichStats = {
  places: number;
  /** Details получены (из кэша или запросом) / с какими-либо данными для карточки. */
  details: number;
  withData: number;
  withPhotos: number;
  withReviews: number;
  withAmenities: number;
  withSummary: number;
  withRating: number;
  /** Места, для которых искали Вікіпедію / нашли уверенное совпадение / с фото Commons. */
  wikiSearched: number;
  wikiFound: number;
  wikiWithImage: number;
  /** Вікіпедія временно недоступна (429/5xx/сеть) — эти места не искались, повторить прогоном позже. */
  wikiUnavailable: number;
  /** Остановлено лимитом запросов Google / Вікіпедії. */
  googleLimitReached: boolean;
  /** Исчерпан месячный предел Place Details (google_api_usage). */
  monthlyLimitReached: boolean;
  /** Мест, которым Details не достались из-за предела (продолжить в следующем месяце). */
  detailsDeferred: number;
  /** Мест, отложенных из-за поминутной квоты Google (429 после всех повторов) — повторить прогоном позже. */
  rateLimited: number;
  /** Мест с данными из кэша импорта (без платного Details). */
  fromImport: number;
  wikiLimitReached: boolean;
  /** Пропущено по фильтру категорий. */
  skippedByCategory: number;
};

export type EnrichOptions = {
  /** Только эти категории (коды); пусто — все. */
  categories?: ReadonlySet<string>;
  /** Не запрашивать Details для этих категорий (утилитарные: банкоматы, АЗС). */
  skipCategories?: ReadonlySet<string>;
  /** Не больше стольких мест (выборка для проверки). */
  limit?: number;
  /** Только эти места (google_place_id). */
  only?: ReadonlySet<string>;
  wiki?: boolean;
  /** false — без Place Details вовсе (только кэш импорта). */
  details?: boolean;
  /** Категории без Place Details (утилитарные). */
  skipDetails?: ReadonlySet<string>;
  /** Ответы поиска импорта по id — данные без платного Details (--from-import-cache). */
  rawById?: ReadonlyMap<string, GooglePlace>;
  /** Фото с авторами бесплатным запросом «id,photos» (по умолчанию да). */
  freePhotos?: boolean;
  /** Порядок по приоритету: важные категории, затем по числу оценок Google. */
  prioritize?: boolean;
  /**
   * --covers-source wikimedia: строгое сопоставление (wiki-match.ts), только подходящие категории (--limit считает
   * только их), запросы Google запрещает вызывающий.
   */
  wikimediaOnly?: boolean;
  log?: (line: string) => void;
};

/** Категории, которым Place Details (отзывы, удобства) нужнее всего — первыми в месячном пределе. */
export const DETAILS_PRIORITY: ReadonlySet<string> = new Set([
  "restaurants",
  "cafes",
  "kolyby",
  "hotels",
  "sadyby",
  "chany",
  "spa",
  "sights",
  "nature",
  "peaks",
]);
/** Без Place Details: банкоматы, АЗС, электрозарядки — отзывы и удобства туристу не нужны. */
export const DEFAULT_SKIP_DETAILS: ReadonlySet<string> = new Set(["atm", "fuel", "ev-charging"]);

/** Приоритет: важные категории, затем больше оценок Google; при равенстве — по id (стабильно между прогонами). */
export function prioritized(places: readonly MappedPlace[]): MappedPlace[] {
  return [...places].sort(
    (a, b) =>
      Number(DETAILS_PRIORITY.has(b.categoryCode)) - Number(DETAILS_PRIORITY.has(a.categoryCode)) ||
      (b.ratingCount ?? 0) - (a.ratingCount ?? 0) ||
      a.googlePlaceId.localeCompare(b.googlePlaceId),
  );
}

export async function enrich(
  places: readonly MappedPlace[],
  google: GooglePlacesClient,
  wikipedia: WikipediaClient | undefined,
  opts: EnrichOptions = {},
): Promise<{ places: EnrichedPlace[]; stats: EnrichStats }> {
  const log = opts.log ?? (() => {});
  let warnedNoKey = false;
  let warnedNoKeyDetails = false;
  const stats: EnrichStats = {
    places: 0,
    details: 0,
    withData: 0,
    withPhotos: 0,
    withReviews: 0,
    withAmenities: 0,
    withSummary: 0,
    withRating: 0,
    wikiSearched: 0,
    wikiFound: 0,
    wikiWithImage: 0,
    wikiUnavailable: 0,
    googleLimitReached: false,
    monthlyLimitReached: false,
    detailsDeferred: 0,
    rateLimited: 0,
    fromImport: 0,
    wikiLimitReached: false,
    skippedByCategory: 0,
  };
  const out: EnrichedPlace[] = [];
  const wikiCategories = opts.wikimediaOnly ? WIKIMEDIA_CATEGORIES : WIKI_CATEGORIES;
  // Режим Wikimedia: прочие категории не занимают --limit и не попадают в запись.
  const suitable = opts.wikimediaOnly ? places.filter((p) => wikiCategories.has(p.categoryCode)) : places;
  stats.skippedByCategory += places.length - suitable.length;
  let warnedWikiStop = false;
  for (const p of opts.prioritize ? prioritized(suitable) : suitable) {
    if (opts.limit !== undefined && out.length >= opts.limit) break;
    if (opts.only && !opts.only.has(p.googlePlaceId)) continue;
    if (
      (opts.categories?.size && !opts.categories.has(p.categoryCode)) ||
      opts.skipCategories?.has(p.categoryCode)
    ) {
      stats.skippedByCategory++;
      continue;
    }
    stats.places++;
    const item: EnrichedPlace = {
      googlePlaceId: p.googlePlaceId,
      name: p.name,
      categoryCode: p.categoryCode,
      localityCode: p.localityCode,
      address: p.address || null,
      google: null,
      wiki: undefined,
    };
    // Платный Place Details (Atmosphere) — кроме утилитарных категорий; предел (месячный/запросов) — данные из
    // кэша импорта, остальное — в следующем прогоне (ответы кэшируются, повтор продолжает с непройденных).
    let g: PlaceEnrichmentGoogle | null = null;
    let rateLimited = false;
    if (opts.details !== false && !opts.skipDetails?.has(p.categoryCode)) {
      try {
        const raw = await google.placeDetails(p.googlePlaceId);
        if (raw) {
          g = normalizeDetails(raw);
          stats.details++;
        }
      } catch (err) {
        if (err instanceof NoApiKeyError) {
          // Без ключа Details не из кэша не получить — пропуск (данные из кэша импорта, если есть), прогон идёт дальше.
          if (!warnedNoKeyDetails) log("Нет GOOGLE_MAPS_API_KEY: Place Details не из кэша пропущены.");
          warnedNoKeyDetails = true;
          stats.detailsDeferred++;
        } else if (err instanceof GoogleRateLimitedError) {
          log(`Details ${p.googlePlaceId}: ${err.message}`);
          stats.rateLimited++;
          rateLimited = true;
          stats.detailsDeferred++;
        } else if (!(err instanceof RequestLimitError)) throw err;
        else {
          if (!stats.googleLimitReached) log(err.message);
          stats.googleLimitReached = true;
          if (err instanceof MonthlyLimitError) stats.monthlyLimitReached = true;
          stats.detailsDeferred++;
        }
      }
    }
    const fromImport = !g ? opts.rawById?.get(p.googlePlaceId) : undefined;
    if (fromImport) {
      // Бесплатно: тип, описание, рейтинг из кэша поиска + фото с авторами запросом «id,photos» (IDs Only).
      let photos: Record<string, unknown> | null = null;
      if (opts.freePhotos !== false && !rateLimited) {
        try {
          photos = await google.placePhotos(p.googlePlaceId);
        } catch (err) {
          if (err instanceof NoApiKeyError) {
            // Без ключа фото не из кэша не получить — шаг пропускается, прогон идёт дальше.
            if (!warnedNoKey) log("Нет GOOGLE_MAPS_API_KEY: фото мест не из кэша пропущены.");
            warnedNoKey = true;
          } else if (err instanceof GoogleRateLimitedError) {
            log(`Фото ${p.googlePlaceId}: ${err.message}`);
            stats.rateLimited++;
          } else if (!(err instanceof RequestLimitError)) throw err;
          else if (!stats.googleLimitReached) {
            log(err.message);
            stats.googleLimitReached = true;
          }
        }
      }
      g = fromSearch(fromImport, photos);
      item.googleFromImport = true;
      stats.fromImport++;
    }
    if (g) {
      item.google = g;
      if (hasGoogleData(g)) stats.withData++;
      if (g.photos.length) stats.withPhotos++;
      if (g.reviews.length) stats.withReviews++;
      if (g.amenities.length) stats.withAmenities++;
      if (g.summary) stats.withSummary++;
      if (g.rating !== null) stats.withRating++;
    }
    if (wikipedia && opts.wiki !== false && wikiCategories.has(p.categoryCode) && !stats.wikiLimitReached) {
      try {
        stats.wikiSearched++;
        item.wiki = opts.wikimediaOnly
          ? await findWikipediaStrict(wikipedia, {
              name: p.name,
              location: p.at,
              categoryCode: p.categoryCode,
            })
          : await findWikipedia(wikipedia, { name: p.name, location: p.at });
        if (item.wiki) {
          stats.wikiFound++;
          if (item.wiki.image) stats.wikiWithImage++;
        }
      } catch (err) {
        if (err instanceof WikiUnavailableError) {
          stats.wikiSearched--;
          stats.wikiUnavailable++;
          item.wiki = undefined;
          if (wikipedia.stopped && !warnedWikiStop) {
            log(`${wikipedia.stopped} — запросы к Вікіпедії остановлены до конца прогона, дальше только кэш`);
            warnedWikiStop = true;
          }
        } else {
          if (!(err instanceof WikiLimitError)) throw err;
          log(err.message);
          stats.wikiLimitReached = true;
          item.wiki = undefined;
        }
      }
    }
    out.push(item);
  }
  return { places: out, stats };
}

/**
 * Цены Google Maps Platform (Places API (New), прейскурант с 03.2025, USD за 1000 запросов сверх бесплатного
 * месячного объёма). Сверять с https://developers.google.com/maps/billing-and-pricing/pricing перед большим прогоном.
 */
export const GOOGLE_PRICING = {
  /** Place Details Enterprise + Atmosphere (reviews, serves*, parkingOptions…): $25 / 1000, бесплатно 1000 в месяц. */
  detailsAtmosphere: { usdPer1000: 25, freePerMonth: 1000 },
  /** Place Photos: $7 / 1000, бесплатно 1000 в месяц. */
  photos: { usdPer1000: 7, freePerMonth: 1000 },
} as const;

export function googleCostUsd(requests: number, sku: { usdPer1000: number; freePerMonth: number }) {
  return {
    requests,
    usdNoFreeTier: Math.round(requests * sku.usdPer1000 * 10) / 10000,
    usdAfterFreeTier: Math.round(Math.max(0, requests - sku.freePerMonth) * sku.usdPer1000 * 10) / 10000,
  };
}
