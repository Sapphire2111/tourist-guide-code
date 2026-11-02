import { analyticsPropsPlaceId, type AnalyticsEvent } from "@tg/shared";

/**
 * Строка analytics_events в виде аргумента функции БД analytics_record_event(jsonb) (миграция api 0007):
 * snake_case, как колонки. Общая для worker (задача analytics.record) и api (прямая запись на staging).
 */
export interface AnalyticsEventRow {
  id: string;
  event_name: string;
  schema_version: number;
  occurred_at: string;
  pseudonymous_user_id: string | null;
  anonymous_id: string | null;
  session_id: string | null;
  region_id: string | null;
  source: string;
  entry_context_id: string | null;
  place_id: string | null;
  properties: Record<string, unknown>;
}

/**
 * Событие (уже проверенное по analyticsEventSchema) → строка журнала; eventId становится id строки.
 * place_id — из конверта, иначе из props.placeId (событие места без placeId в конверте; совпадение обоих, если
 * заданы, проверяет схема).
 */
export function toAnalyticsEventRow(e: AnalyticsEvent): AnalyticsEventRow {
  return {
    id: e.eventId,
    event_name: e.event,
    schema_version: e.schemaVersion,
    occurred_at: e.occurredAt,
    pseudonymous_user_id: e.pseudonymousUserId ?? null,
    anonymous_id: e.anonymousId ?? null,
    session_id: e.sessionId ?? null,
    region_id: e.regionId,
    source: e.source,
    entry_context_id: e.entryContextId ?? null,
    place_id: e.placeId ?? analyticsPropsPlaceId(e.props) ?? null,
    properties: e.props,
  };
}
