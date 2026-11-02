// Unit: фабрики дают записи, проходящие ограничения миграции 0002 (проверка на БД — integration).
import { describe, expect, it } from "vitest";
import { buildAnalyticsEvent, buildAuditLog, buildIdempotencyKey, buildRegion, buildUser } from "./index.js";

// Копии CHECK из apps/api/migrations/0002_base_entities.sql.
const REGION_CODE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;

describe("фабрики базовых сущностей", () => {
  it("buildRegion: уникальный код по формату, name_i18n с непустым uk, переопределение полей", () => {
    const a = buildRegion();
    const b = buildRegion();
    expect(a.code).toMatch(REGION_CODE);
    expect(a.code).not.toBe(b.code);
    expect(a.name_i18n.uk.trim()).not.toBe("");
    for (const lang of Object.keys(a.name_i18n)) expect(lang).toMatch(LANGUAGE_CODE);

    const c = buildRegion({ code: "lviv", status: "draft" });
    expect(c).toMatchObject({ code: "lviv", status: "draft" });
  });

  it("buildUser: язык uk и статус active по умолчанию", () => {
    expect(buildUser()).toEqual({ status: "active", language: "uk" });
    expect(buildUser({ language: "en" })).toEqual({ status: "active", language: "en" });
  });

  it("buildAuditLog: актор SYSTEM по умолчанию, user — если задан actor_user_id", () => {
    const sys = buildAuditLog();
    expect(sys.actor_type).toBe("system");
    expect(sys.actor_user_id).toBeUndefined();

    const userId = "0190f5c2-7d3e-7000-8000-000000000001";
    expect(buildAuditLog({ actor_user_id: userId })).toMatchObject({
      actor_type: "user",
      actor_user_id: userId,
    });
    // Явный actor_type не подменяется (для тестов отказа CHECK).
    expect(buildAuditLog({ actor_type: "system", actor_user_id: userId }).actor_type).toBe("system");
  });

  it("buildIdempotencyKey: уникальный ключ, sha256-хэш, expires_at в будущем; хэш следует за ключом", () => {
    const a = buildIdempotencyKey();
    const b = buildIdempotencyKey();
    expect(a.key).not.toBe(b.key);
    expect(a.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(a.expires_at).getTime()).toBeGreaterThan(Date.now());

    const same1 = buildIdempotencyKey({ key: "k-1" });
    const same2 = buildIdempotencyKey({ key: "k-1" });
    expect(same1.key).toBe("k-1");
    expect(same1.request_hash).toBe(same2.request_hash);
    expect(buildIdempotencyKey({ scope: "user:x:POST /a" }).scope).toBe("user:x:POST /a");
  });

  it("buildAnalyticsEvent: имя по формату, версия схемы 1, пустые свойства", () => {
    const e = buildAnalyticsEvent();
    expect(e.event_name).toMatch(EVENT_NAME);
    expect(e).toMatchObject({ schema_version: 1, properties: {} });
    expect(buildAnalyticsEvent({ event_name: "qr_scanned" }).event_name).toBe("qr_scanned");
  });
});
