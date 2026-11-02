// Разбор ответа Google Place Details (New) в нормализованное обогащение места (place_enrichments.google): без сети и
// БД. Берётся только то, что Google действительно вернул: нет поля — null/[]; удобство — только при значении true.
// Ссылки — только https (в href/src карточки не попадут javascript:/data:), фото авторов — только хосты Google.
import type {
  GoogleAuthor,
  PlaceAmenity,
  PlaceEnrichmentGoogle,
  PlaceEnrichmentPhoto,
  PlaceEnrichmentReview,
} from "../db/index.js";
import { isAllowedPhotoUrl } from "../places-import/google-client.js";

/** Фото и отзывов в карточке — не больше (галерея 2–5 фото, 3–5 отзывов). */
export const MAX_PHOTOS = 5;
export const MAX_REVIEWS = 5;
const MAX_REVIEW_CHARS = 1200;
const MAX_TEXT_CHARS = 600;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, max = MAX_TEXT_CHARS): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** Многострочный текст отзыва: абзацы сохраняются, лишние пробелы убираются. */
const reviewText = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (!t) return null;
  return t.length > MAX_REVIEW_CHARS ? `${t.slice(0, MAX_REVIEW_CHARS - 1).trimEnd()}…` : t;
};

export function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Фото автора (аватар) — только https на хостах Google; «//lh3…» без схемы — тоже. */
function authorPhoto(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const url = v.startsWith("//") ? `https:${v}` : v;
  return isAllowedPhotoUrl(url) ? url : null;
}

const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;

function author(v: unknown): GoogleAuthor | null {
  if (!isObject(v)) return null;
  const name = str(v.displayName, 100);
  if (!name) return null;
  return { name, uri: httpsUrl(v.uri), photoUri: authorPhoto(v.photoUri) };
}

const PRICE_LEVELS: Readonly<Record<string, number>> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

/** Булево поле Google → удобство. Порядок — порядок чипов в карточке. */
const BOOL_AMENITIES: readonly (readonly [string, PlaceAmenity])[] = [
  ["servesBreakfast", "breakfast"],
  ["servesBrunch", "brunch"],
  ["servesLunch", "lunch"],
  ["servesDinner", "dinner"],
  ["servesCoffee", "coffee"],
  ["servesDessert", "dessert"],
  ["servesBeer", "beer"],
  ["servesWine", "wine"],
  ["servesCocktails", "cocktails"],
  ["servesVegetarianFood", "vegetarian"],
  ["dineIn", "dine_in"],
  ["takeout", "takeout"],
  ["delivery", "delivery"],
  ["curbsidePickup", "curbside_pickup"],
  ["reservable", "reservable"],
  ["outdoorSeating", "outdoor_seating"],
  ["liveMusic", "live_music"],
  ["menuForChildren", "kids_menu"],
  ["goodForChildren", "good_for_children"],
  ["goodForGroups", "good_for_groups"],
  ["goodForWatchingSports", "watching_sports"],
  ["allowsDogs", "dogs_allowed"],
  ["restroom", "restroom"],
];

export function amenitiesOf(d: Record<string, unknown>): PlaceAmenity[] {
  const out: PlaceAmenity[] = [];
  for (const [field, code] of BOOL_AMENITIES) if (d[field] === true) out.push(code);
  const parking = isObject(d.parkingOptions) ? d.parkingOptions : {};
  if (
    parking.freeParkingLot === true ||
    parking.freeStreetParking === true ||
    parking.freeGarageParking === true
  )
    out.push("parking_free");
  if (
    parking.paidParkingLot === true ||
    parking.paidStreetParking === true ||
    parking.paidGarageParking === true ||
    parking.valetParking === true
  )
    out.push("parking_paid");
  const access = isObject(d.accessibilityOptions) ? d.accessibilityOptions : {};
  if (access.wheelchairAccessibleEntrance === true) out.push("wheelchair_entrance");
  if (access.wheelchairAccessibleParking === true) out.push("wheelchair_parking");
  if (access.wheelchairAccessibleRestroom === true) out.push("wheelchair_restroom");
  if (access.wheelchairAccessibleSeating === true) out.push("wheelchair_seating");
  const pay = isObject(d.paymentOptions) ? d.paymentOptions : {};
  if (pay.acceptsCreditCards === true || pay.acceptsDebitCards === true) out.push("cards");
  if (pay.acceptsNfc === true) out.push("nfc");
  if (pay.acceptsCashOnly === true) out.push("cash_only");
  return out;
}

const PHOTO_NAME = /^places\/[A-Za-z0-9_-]{1,255}\/photos\/[A-Za-z0-9_-]{1,1024}$/;

function photos(v: unknown): PlaceEnrichmentPhoto[] {
  if (!Array.isArray(v)) return [];
  const out: PlaceEnrichmentPhoto[] = [];
  for (const p of v) {
    if (out.length >= MAX_PHOTOS) break;
    if (!isObject(p) || typeof p.name !== "string" || !PHOTO_NAME.test(p.name)) continue;
    const authors = Array.isArray(p.authorAttributions)
      ? p.authorAttributions.map(author).filter((a): a is GoogleAuthor => a !== null)
      : [];
    out.push({
      name: p.name,
      width: num(p.widthPx, 1, 100_000),
      height: num(p.heightPx, 1, 100_000),
      authors,
    });
  }
  return out;
}

function reviews(v: unknown): PlaceEnrichmentReview[] {
  if (!Array.isArray(v)) return [];
  const out: PlaceEnrichmentReview[] = [];
  for (const r of v) {
    if (out.length >= MAX_REVIEWS) break;
    if (!isObject(r)) continue;
    const a = author(r.authorAttribution);
    const textObj = isObject(r.text) ? r.text : isObject(r.originalText) ? r.originalText : null;
    const text = textObj ? reviewText(textObj.text) : null;
    // Без автора или текста отзыв не показывается: атрибуция обязательна, пустая оценка без текста — не гид.
    if (!a || !text) continue;
    const publish = typeof r.publishTime === "string" && !Number.isNaN(Date.parse(r.publishTime));
    out.push({
      author: a,
      rating: num(r.rating, 1, 5),
      text,
      language:
        textObj && typeof textObj.languageCode === "string" ? textObj.languageCode.slice(0, 12) : null,
      publishTime: publish ? new Date(r.publishTime as string).toISOString() : null,
      relativeTime: str(r.relativePublishTimeDescription, 60),
      uri: httpsUrl(r.googleMapsUri),
    });
  }
  return out;
}

/** Ответ Place Details → обогащение; данных нет вовсе — всё равно объект с null/[] (карточка блоки не покажет). */
export function normalizeDetails(d: Record<string, unknown>): PlaceEnrichmentGoogle {
  const typeLabel = isObject(d.primaryTypeDisplayName) ? str(d.primaryTypeDisplayName.text, 80) : null;
  const summary = isObject(d.editorialSummary) ? str(d.editorialSummary.text) : null;
  const rating = num(d.rating, 1, 5);
  const ratingCount = num(d.userRatingCount, 0, 100_000_000);
  return {
    typeLabel,
    summary,
    priceLevel: typeof d.priceLevel === "string" ? (PRICE_LEVELS[d.priceLevel] ?? null) : null,
    // Рейтинг без числа оценок (и наоборот) не показывается — неполные данные.
    rating: rating !== null && ratingCount ? rating : null,
    ratingCount: rating !== null && ratingCount ? Math.round(ratingCount) : null,
    mapsUri: httpsUrl(d.googleMapsUri),
    amenities: amenitiesOf(d),
    reviews: reviews(d.reviews),
    photos: photos(d.photos),
  };
}

/** Есть ли в обогащении хоть что-то для карточки. */
export function hasGoogleData(g: PlaceEnrichmentGoogle): boolean {
  return Boolean(
    g.typeLabel ||
    g.summary ||
    g.priceLevel !== null ||
    g.rating !== null ||
    g.amenities.length ||
    g.reviews.length ||
    g.photos.length,
  );
}
