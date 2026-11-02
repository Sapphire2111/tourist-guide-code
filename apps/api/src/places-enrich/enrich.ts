// Сбор обогащения мест (places:enrich) без БД: Google Place Details по каждому месту (кэш ответов), Вікіпедія для
// пам'яток. Общий для --plan (только оценка), --dry-run и записи. Запросы мимо кэша ограничены лимитами клиентов.
import type { PlaceEnrichmentGoogle, PlaceEnrichmentWiki } from "../db/index.js";
import { RequestLimitError, type GooglePlacesClient } from "../places-import/google-client.js";
import type { MappedPlace } from "../places-import/mapping.js";
import { hasGoogleData, normalizeDetails } from "./details.js";
import { findWikipedia, WIKI_CATEGORIES, WikiLimitError, type WikipediaClient } from "./wikipedia.js";

export type EnrichedPlace = {
  googlePlaceId: string;
  name: string;
  categoryCode: string;
  localityCode: string;
  address: string | null;
  /** null — Details не получены (лимит, план, Google не знает места). */
  google: PlaceEnrichmentGoogle | null;
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
  /** Остановлено лимитом запросов Google / Вікіпедії. */
  googleLimitReached: boolean;
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
  log?: (line: string) => void;
};

export async function enrich(
  places: readonly MappedPlace[],
  google: GooglePlacesClient,
  wikipedia: WikipediaClient | undefined,
  opts: EnrichOptions = {},
): Promise<{ places: EnrichedPlace[]; stats: EnrichStats }> {
  const log = opts.log ?? (() => {});
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
    googleLimitReached: false,
    wikiLimitReached: false,
    skippedByCategory: 0,
  };
  const out: EnrichedPlace[] = [];
  for (const p of places) {
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
    if (!stats.googleLimitReached) {
      try {
        const raw = await google.placeDetails(p.googlePlaceId);
        if (raw) {
          const g = normalizeDetails(raw);
          item.google = g;
          stats.details++;
          if (hasGoogleData(g)) stats.withData++;
          if (g.photos.length) stats.withPhotos++;
          if (g.reviews.length) stats.withReviews++;
          if (g.amenities.length) stats.withAmenities++;
          if (g.summary) stats.withSummary++;
          if (g.rating !== null) stats.withRating++;
        }
      } catch (err) {
        if (!(err instanceof RequestLimitError)) throw err;
        log(err.message);
        stats.googleLimitReached = true;
      }
    }
    if (wikipedia && opts.wiki !== false && WIKI_CATEGORIES.has(p.categoryCode) && !stats.wikiLimitReached) {
      try {
        stats.wikiSearched++;
        item.wiki = await findWikipedia(wikipedia, { name: p.name, location: p.at });
        if (item.wiki) {
          stats.wikiFound++;
          if (item.wiki.image) stats.wikiWithImage++;
        }
      } catch (err) {
        if (!(err instanceof WikiLimitError)) throw err;
        log(err.message);
        stats.wikiLimitReached = true;
        item.wiki = undefined;
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
