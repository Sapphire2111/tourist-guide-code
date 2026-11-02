import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_SCHEMA_VERSION,
  CLIENT_ANALYTICS_EVENT_NAMES,
  analyticsEventSchema,
  analyticsTimeIssue,
  clientAnalyticsBatchSchema,
  clientAnalyticsEventSchema,
} from "./analytics.js";

const U = "0192f0c1-7a2b-7c3d-8e4f-0a1b2c3d4e5f";
const base = {
  eventId: "0192f0c1-7a2b-7c3d-8e4f-000000000001",
  schemaVersion: ANALYTICS_SCHEMA_VERSION,
  occurredAt: "2026-11-02T10:00:00.000Z",
  anonymousId: U,
  regionId: null,
  source: "qr",
};

describe("каталог аналитических событий (T1-25)", () => {
  it("содержит события ТЗ §15.1 от qr_scanned до ambassador_rewarded, имена в snake_case", () => {
    expect(ANALYTICS_EVENT_NAMES).toContain("qr_scanned");
    expect(ANALYTICS_EVENT_NAMES).toContain("app_opened");
    expect(ANALYTICS_EVENT_NAMES).toContain("ambassador_rewarded");
    // Совпадает с CHECK analytics_events_event_name_format (миграция 0002).
    for (const n of ANALYTICS_EVENT_NAMES) expect(n).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });

  it("валидное событие проходит, props типизированы по событию", () => {
    const ok = analyticsEventSchema.safeParse({ ...base, event: "place_viewed", props: { placeId: U } });
    expect(ok.success).toBe(true);
    expect(analyticsEventSchema.safeParse({ ...base, event: "place_viewed", props: {} }).success).toBe(false);
    expect(
      analyticsEventSchema.safeParse({
        ...base,
        event: "qr_scanned",
        props: { qrPointId: U, result: "ok" },
      }).success,
    ).toBe(true);
    // Неизвестный/мусорный параметр QR — без qrPointId (ADR-0016).
    expect(
      analyticsEventSchema.safeParse({ ...base, event: "qr_scanned", props: { result: "invalid" } }).success,
    ).toBe(true);
  });

  it("лишние поля props и конверта отклоняются (защита от ПДн)", () => {
    const withPhone = { ...base, event: "place_viewed", props: { placeId: U, phone: "+380501234567" } };
    expect(analyticsEventSchema.safeParse(withPhone).success).toBe(false);
    const withInitData = { ...base, initData: "query_id=…", event: "app_opened", props: {} };
    expect(analyticsEventSchema.safeParse(withInitData).success).toBe(false);
  });

  it("неизвестное событие, чужая версия схемы, кривое время — отказ", () => {
    expect(analyticsEventSchema.safeParse({ ...base, event: "nope", props: {} }).success).toBe(false);
    expect(
      analyticsEventSchema.safeParse({ ...base, schemaVersion: 2, event: "app_opened", props: {} }).success,
    ).toBe(false);
    expect(
      analyticsEventSchema.safeParse({ ...base, occurredAt: "вчера", event: "app_opened", props: {} })
        .success,
    ).toBe(false);
  });

  it("нужен pseudonymousUserId или anonymousId", () => {
    const r = analyticsEventSchema.safeParse({
      ...base,
      anonymousId: undefined,
      event: "app_opened",
      props: {},
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["anonymousId"]);
    expect(
      analyticsEventSchema.safeParse({
        ...base,
        anonymousId: null,
        pseudonymousUserId: U,
        event: "app_opened",
        props: {},
      }).success,
    ).toBe(true);
  });

  it("клиент может прислать только client-события", () => {
    expect(CLIENT_ANALYTICS_EVENT_NAMES).toEqual([
      "category_opened",
      "search_used",
      "place_viewed",
      "route_clicked",
      "call_clicked",
    ]);
    expect(clientAnalyticsEventSchema.safeParse({ ...base, event: "search_used", props: {} }).success).toBe(
      true,
    );
    // app_opened эмитит сервер при входе (ADR-0015): от клиента — отклоняется.
    expect(clientAnalyticsEventSchema.safeParse({ ...base, event: "app_opened", props: {} }).success).toBe(
      false,
    );
    const forged = { ...base, event: "ambassador_rewarded", props: { ambassadorId: U, rewardId: U } };
    expect(analyticsEventSchema.safeParse(forged).success).toBe(true);
    expect(clientAnalyticsEventSchema.safeParse(forged).success).toBe(false);
  });

  it("клиентский конверт без pseudonymousUserId: поле от клиента — unrecognized_keys", () => {
    const r = clientAnalyticsEventSchema.safeParse({
      ...base,
      pseudonymousUserId: U,
      event: "search_used",
      props: {},
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([
      expect.objectContaining({ code: "unrecognized_keys", keys: ["pseudonymousUserId"], path: [] }),
    ]);
    // Без anonymousId клиенту нечем назвать пользователя.
    const anon = clientAnalyticsEventSchema.safeParse({
      ...base,
      anonymousId: null,
      event: "search_used",
      props: {},
    });
    expect(anon.error?.issues[0]?.path).toEqual(["anonymousId"]);
  });

  it("category_opened и search_used: минимальные props без свободного текста", () => {
    const ok = (event: string, props: object) =>
      clientAnalyticsEventSchema.safeParse({ ...base, event, props }).success;
    expect(ok("category_opened", { categoryId: U })).toBe(true);
    expect(ok("category_opened", {})).toBe(false);
    expect(ok("search_used", {})).toBe(true);
    expect(ok("search_used", { categoryId: U, resultCount: 0 })).toBe(true);
    expect(ok("search_used", { resultCount: -1 })).toBe(false);
    expect(ok("search_used", { resultCount: 1.5 })).toBe(false);
    expect(ok("search_used", { query: "аптека" })).toBe(false);
  });

  it("eventId: nil и max UUID отклоняются", () => {
    const ok = (eventId: string) =>
      analyticsEventSchema.safeParse({ ...base, eventId, event: "app_opened", props: {} }).success;
    expect(ok("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(ok("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(false);
    expect(ok("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF")).toBe(false);
    expect(ok(base.eventId)).toBe(true);
  });

  it("placeId конверта и props.placeId: если заданы оба — должны совпадать", () => {
    const P = "0192f0c1-7a2b-7c3d-8e4f-00000000beef";
    const parse = (placeId: string | null | undefined) =>
      analyticsEventSchema.safeParse({ ...base, placeId, event: "place_viewed", props: { placeId: U } });
    expect(parse(undefined).success).toBe(true);
    expect(parse(null).success).toBe(true);
    expect(parse(U).success).toBe(true);
    expect(parse(U.toUpperCase()).success).toBe(true);
    const r = parse(P);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["placeId"]);
    // У события без placeId в props конверт может нести любое место.
    expect(
      analyticsEventSchema.safeParse({ ...base, placeId: P, event: "app_opened", props: {} }).success,
    ).toBe(true);
  });

  it("пакет: 1…50 событий", () => {
    const e = { ...base, event: "search_used", props: {} };
    expect(clientAnalyticsBatchSchema.safeParse({ events: [e] }).success).toBe(true);
    expect(clientAnalyticsBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(clientAnalyticsBatchSchema.safeParse({ events: Array(51).fill(e) }).success).toBe(false);
  });

  it("время события: не из будущего и не старше 7 дней", () => {
    const now = new Date("2026-11-02T10:00:00Z");
    expect(analyticsTimeIssue("2026-11-02T10:04:00Z", now)).toBeNull();
    expect(analyticsTimeIssue("2026-11-02T10:06:00Z", now)).toMatch(/будущем/);
    expect(analyticsTimeIssue("2026-10-25T09:00:00Z", now)).toMatch(/7 дней/);
  });
});
