import { Injectable } from "@nestjs/common";
import {
  currentDb,
  InjectDb,
  regionContext,
  withTenant,
  type Db,
  type PlaceEnrichmentGoogle,
  type PlaceEnrichmentWiki,
} from "../../db/index.js";

export type PlaceEnrichmentFacts = {
  google: PlaceEnrichmentGoogle | null;
  wiki: PlaceEnrichmentWiki | null;
  /** ИИ-текст карточки (places:enrich --ai). */
  ai: string | null;
};

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
}
