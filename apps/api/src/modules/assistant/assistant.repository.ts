import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  regionContext,
  withTenant,
  type Db,
  type LocalizedText,
  type LonLat,
  lonLatOf,
  type PlaceEnrichmentGoogle,
  type PlaceEnrichmentWiki,
} from "../../db/index.js";

export type PlaceEnrichmentFacts = {
  google: PlaceEnrichmentGoogle | null;
  wiki: PlaceEnrichmentWiki | null;
  /** ИИ-текст карточки (places:enrich --ai). */
  ai: string | null;
};

export type AssistantLocality = { id: string; code: string; name_i18n: LocalizedText; location: LonLat };

/** Обогащение мест для ассистента: цена, удобства, описания — в контексте региона (RLS), одним запросом. */
@Injectable()
export class AssistantRepository {
  constructor(@InjectDb() private readonly db: Db) {}

  async enrichments(regionId: string, ids: readonly string[]): Promise<Map<string, PlaceEnrichmentFacts>> {
    if (!ids.length) return new Map();
    const rows = await withTenant(this.db, regionContext(regionId), () =>
      currentDb(this.db)
        .selectFrom("place_enrichments")
        .select(["place_id", "google", "wiki", "ai_summary_uk"])
        .where("place_id", "in", ids)
        .execute(),
    );
    return new Map(rows.map((r) => [r.place_id, { google: r.google, wiki: r.wiki, ai: r.ai_summary_uk }]));
  }

  /** Активные населённые пункты региона (для поля locality инструмента и выбора туриста). */
  localities(regionId: string): Promise<AssistantLocality[]> {
    return withTenant(
      this.db,
      regionContext(regionId),
      async () =>
        (await currentDb(this.db)
          .selectFrom("localities")
          .select(["id", "code", "name_i18n"])
          .select((eb) => lonLatOf(eb.ref("location")).as("location"))
          .where("active", "=", true)
          .orderBy("sort_order")
          .orderBy("code")
          .execute()) as AssistantLocality[],
    );
  }

  /**
   * Населённый пункт мест (places.locality_id). Временная фильтрация в ассистенте — до общего параметра
   * localityIds в GET /places/search (ветка локаций), затем фильтр уйдёт в поиск каталога.
   */
  async placeLocalities(regionId: string, ids: readonly string[]): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = await withTenant(this.db, regionContext(regionId), () =>
      currentDb(this.db).selectFrom("places").select(["id", "locality_id"]).where("id", "in", ids).execute(),
    );
    return new Map(rows.map((r) => [r.id, r.locality_id]));
  }
}
