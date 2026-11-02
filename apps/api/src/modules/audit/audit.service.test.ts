// Unit (без БД): AuditService пишет запись действия и ПДн-часть в переданную транзакцию, регион — из
// tenant-контекста. Неизменяемость в БД, откат вместе с бизнес-транзакцией и очистка по сроку —
// test/integration/audit.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingDb } from "../../../test/support/recording-db.js";
import { regionContext, SYSTEM_CONTEXT, TenantContextError, withTenant } from "../../db/index.js";
import { AuditService, DEFAULT_AUDIT_PII_RETENTION_DAYS, normalizePii } from "./audit.service.js";

const A = "0190f5c2-7d3e-7000-8000-00000000000a";
const B = "0190f5c2-7d3e-7000-8000-00000000000b";
const USER = "0190f5c2-7d3e-7000-8000-0000000000ee";
const LOG_ID = "0190f5c2-7d3e-7000-8000-000000000100";
const DAY_MS = 24 * 60 * 60 * 1000;

/** БД, которая на INSERT … RETURNING отдаёт вставленную строку (region_id — из параметров запроса). */
function db() {
  return recordingDb({}, (q) => {
    if (q.sql.startsWith('insert into "audit_logs"')) {
      const cols = /\(([^)]*)\) values/
        .exec(q.sql)![1]!
        .split(", ")
        .map((c) => c.replace(/"/g, ""));
      const row = Object.fromEntries(cols.map((c, i) => [c, q.parameters[i]]));
      return [{ region_id: null, ...row, id: LOG_ID, created_at: new Date() }];
    }
    if (q.sql.startsWith('insert into "audit_log_pii"')) return [{ audit_log_id: LOG_ID }];
    return [];
  });
}

describe("AuditService.record", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("контекст региона: запись действия и ПДн в одной транзакции, регион из контекста, срок ПДн 90 дней", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-01T00:00:00Z"), toFake: ["Date"] });
    const { db: kdb, queries } = db();
    const service = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);
    const log = await withTenant(kdb, regionContext(A), (trx) =>
      service.record(trx, {
        actor: { type: "user", userId: USER },
        action: "role.assign",
        entityType: "role_assignment",
        entityId: "ra-1",
        newValues: { role: "REGION_ADMIN" },
        requestId: "req-1",
        roleAssignmentId: "0190f5c2-7d3e-7000-8000-0000000000ab",
        pii: { ip: "203.0.113.7", userAgent: "TelegramBot", sessionId: "s-1" },
      }),
    );
    expect(log.id).toBe(LOG_ID);
    expect(queries.map((q) => q.sql)).toEqual([
      "SELECT set_config('app.region_id', $1, true), set_config('app.actor', $2, true)",
      'insert into "audit_logs" ("actor_type", "actor_user_id", "region_id", "action", "entity_type", "entity_id", "old_values", "new_values", "reason", "request_id", "role_assignment_id") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *',
      'insert into "audit_log_pii" ("audit_log_id", "region_id", "ip", "user_agent", "session_id", "expires_at") values ($1, $2, $3, $4, $5, $6) returning *',
    ]);
    expect(queries[1]!.parameters).toEqual([
      "user",
      USER,
      A,
      "role.assign",
      "role_assignment",
      "ra-1",
      null,
      { role: "REGION_ADMIN" },
      null,
      "req-1",
      "0190f5c2-7d3e-7000-8000-0000000000ab",
    ]);
    expect(queries[2]!.parameters).toEqual([
      LOG_ID,
      A,
      "203.0.113.7",
      "TelegramBot",
      "s-1",
      new Date(Date.now() + 90 * DAY_MS),
    ]);
  });

  it("без ПДн вторая таблица не трогается; SYSTEM — регион из записи или NULL", async () => {
    const { db: kdb, queries } = db();
    const service = new AuditService(30);
    await withTenant(kdb, SYSTEM_CONTEXT, async (trx) => {
      await service.record(trx, { actor: { type: "system" }, action: "job.run", entityType: "job" });
      await service.record(trx, {
        actor: { type: "system" },
        action: "job.run",
        entityType: "job",
        regionId: B,
        pii: { ip: "не ip", userAgent: "  " },
      });
    });
    const inserts = queries.filter((q) => q.sql.startsWith("insert"));
    expect(inserts.map((q) => q.sql.slice(0, 25))).toEqual([
      'insert into "audit_logs" ',
      'insert into "audit_logs" ',
    ]);
    expect(inserts[0]!.parameters.slice(0, 3)).toEqual(["system", null, null]);
    expect(inserts[1]!.parameters.slice(0, 3)).toEqual(["system", null, B]);
  });

  it("контекст региона: другой регион в записи — ошибка до БД", async () => {
    const { db: kdb, queries } = db();
    const service = new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS);
    await expect(
      withTenant(kdb, regionContext(A), (trx) =>
        service.record(trx, { actor: { type: "system" }, action: "x", entityType: "y", regionId: B }),
      ),
    ).rejects.toBeInstanceOf(TenantContextError);
    expect(queries.filter((q) => q.sql.startsWith("insert"))).toEqual([]);
  });

  it("вне транзакции — ошибка: аудит пишется только вместе с изменением", async () => {
    const { db: kdb } = db();
    await expect(
      new AuditService(DEFAULT_AUDIT_PII_RETENTION_DAYS).record(kdb, {
        actor: { type: "system" },
        action: "x",
        entityType: "y",
      }),
    ).rejects.toThrow(/транзакци/);
  });

  it("срок хранения — целое число дней ≥ 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => new AuditService(bad)).toThrow(/Срок хранения/);
  });
});

describe("normalizePii", () => {
  it("пусто или только мусор — нечего записывать", () => {
    expect(normalizePii(undefined)).toBeUndefined();
    expect(normalizePii({})).toBeUndefined();
    expect(normalizePii({ ip: "999.1.1.1", userAgent: " ", sessionId: "" })).toBeUndefined();
  });

  it("zone id IPv6 отбрасывается (inet его не принимает)", () => {
    expect(normalizePii({ ip: "fe80::1%eth0" })).toEqual({
      ip: "fe80::1",
      user_agent: null,
      session_id: null,
    });
    expect(normalizePii({ ip: "%eth0" })).toBeUndefined();
  });

  it("IPv4/IPv6 принимаются, user agent обрезается до 1024 символов, длинный session id отбрасывается", () => {
    expect(normalizePii({ ip: " 2001:db8::1 " })).toEqual({
      ip: "2001:db8::1",
      user_agent: null,
      session_id: null,
    });
    const ua = "ї".repeat(2000);
    expect(normalizePii({ userAgent: ua, sessionId: "x".repeat(256) })).toEqual({
      ip: null,
      user_agent: "ї".repeat(1024),
      session_id: null,
    });
  });
});
