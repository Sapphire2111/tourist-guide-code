import { describe, expect, it } from "vitest";
import { ANALYTICS_SCHEMA_VERSION, type AnalyticsEvent } from "@tg/shared";
import { toAnalyticsEventRow } from "./analytics.js";

const U = "0192f0c1-7a2b-7c3d-8e4f-0a1b2c3d4e5f";
const P = "0192f0c1-7a2b-7c3d-8e4f-00000000beef";
const base = {
  eventId: "0192f0c1-7a2b-7c3d-8e4f-000000000001",
  schemaVersion: ANALYTICS_SCHEMA_VERSION,
  occurredAt: "2026-11-02T10:00:00.000Z",
  anonymousId: U,
  regionId: null,
  source: "qr",
} as const;

describe("toAnalyticsEventRow", () => {
  it("place_id: из конверта, иначе из props.placeId, иначе null", () => {
    const viewed = (placeId?: string | null) =>
      toAnalyticsEventRow({
        ...base,
        placeId,
        event: "place_viewed",
        props: { placeId: P },
      } as AnalyticsEvent);
    expect(viewed().place_id).toBe(P);
    expect(viewed(null).place_id).toBe(P);
    expect(viewed(P).place_id).toBe(P);
    expect(toAnalyticsEventRow({ ...base, event: "app_opened", props: {} }).place_id).toBeNull();
    expect(toAnalyticsEventRow({ ...base, placeId: P, event: "app_opened", props: {} }).place_id).toBe(P);
  });

  it("поля конверта — в snake_case колонки, необязательные — null", () => {
    expect(toAnalyticsEventRow({ ...base, event: "app_opened", props: { platform: "ios" } })).toEqual({
      id: base.eventId,
      event_name: "app_opened",
      schema_version: 1,
      occurred_at: base.occurredAt,
      pseudonymous_user_id: null,
      anonymous_id: U,
      session_id: null,
      region_id: null,
      source: "qr",
      entry_context_id: null,
      place_id: null,
      properties: { platform: "ios" },
    });
  });
});
