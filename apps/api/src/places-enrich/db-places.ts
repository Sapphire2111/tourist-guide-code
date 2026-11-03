// Места для places:enrich --covers-source wikimedia — из БД региона (опубликованные места импорта Google), без кэша
// импорта и без единого запроса к Google. Сохранённые данные Google (place_enrichments.google) идут только в факты ИИ;
// hasAi — у места уже есть текст ИИ: его не трогаем и в пакет не ставим.
import { lonLatOf, regionContext, withTenant, type Db, type PlaceEnrichmentGoogle } from "../db/index.js";
import type { MappedPlace } from "../places-import/mapping.js";

export type DbPlace = MappedPlace & {
  savedGoogle: PlaceEnrichmentGoogle | null;
  hasCover: boolean;
  hasAi: boolean;
};

export async function loadDbPlaces(db: Db, regionId: string): Promise<DbPlace[]> {
  const rows = await withTenant(db, regionContext(regionId), (trx) =>
    trx
      .selectFrom("places")
      .innerJoin("categories", "categories.id", "places.category_id")
      .leftJoin("localities", "localities.id", "places.locality_id")
      .leftJoin("place_enrichments", "place_enrichments.place_id", "places.id")
      .leftJoin("place_cover_photos", "place_cover_photos.place_id", "places.id")
      .select((eb) => [
        "places.google_place_id",
        "places.name_i18n",
        "places.address_i18n",
        "categories.code as category_code",
        "localities.code as locality_code",
        "place_enrichments.google",
        "place_enrichments.ai_summary_uk",
        eb("place_cover_photos.place_id", "is not", null).as("has_cover"),
        lonLatOf(eb.ref("places.location")).as("at"),
      ])
      .where("places.status", "=", "published")
      .where("places.source", "=", "google")
      .where("places.google_place_id", "is not", null)
      .execute(),
  );
  return rows.flatMap((r): DbPlace[] => {
    const name = r.name_i18n?.uk?.trim();
    if (!r.google_place_id || !name || !r.at) return [];
    return [
      {
        googlePlaceId: r.google_place_id,
        categoryCode: r.category_code,
        extraCategoryCodes: [],
        localityCode: r.locality_code ?? "",
        name,
        description: "",
        address: r.address_i18n?.uk ?? "",
        at: r.at,
        phone: null,
        website: null,
        week: null,
        photos: [],
        rating: r.google?.rating ?? null,
        ratingCount: r.google?.ratingCount ?? null,
        savedGoogle: r.google ?? null,
        hasCover: Boolean(r.has_cover),
        hasAi: Boolean(r.ai_summary_uk),
      },
    ];
  });
}
