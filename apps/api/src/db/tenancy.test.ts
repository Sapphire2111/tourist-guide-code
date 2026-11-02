// Unit (без БД): классификация таблиц полна и согласована с миграциями.
// Полнота относительно интерфейса Database проверяется компилятором (`satisfies` в tenancy.ts):
// таблица в schema.ts без классификации или лишняя запись — ошибка typecheck. Здесь — сверка с SQL.
import { describe, expect, expectTypeOf, it } from "vitest";
import { loadMigrations } from "./migrate.js";
import type { Database } from "./schema.js";
import { TABLE_TENANCY, tenantTableNames, type TableTenancy } from "./tenancy.js";

/** CREATE TABLE <имя> во всех миграциях и комментарий-блок непосредственно над каждой. */
async function createdTables(): Promise<Map<string, string>> {
  const tables = new Map<string, string>();
  for (const m of await loadMigrations()) {
    const lines = m.sql.split("\n");
    lines.forEach((line, i) => {
      const match = /^CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/i.exec(line);
      if (!match) return;
      const comments: string[] = [];
      for (let j = i - 1; j >= 0 && lines[j]!.startsWith("--"); j--) comments.unshift(lines[j]!);
      tables.set(match[1]!, comments.join("\n"));
    });
  }
  return tables;
}

describe("классификация таблиц (tenancy.ts)", () => {
  it("каждая таблица Database классифицирована (тип) и каждая классификация — таблица Database", () => {
    expectTypeOf<keyof typeof TABLE_TENANCY>().toEqualTypeOf<keyof Database>();
    expectTypeOf(TABLE_TENANCY).toExtend<Record<keyof Database, TableTenancy>>();
  });

  it("таблицы из CREATE TABLE в миграциях совпадают с классифицированными", async () => {
    const tables = await createdTables();
    expect([...tables.keys()].sort()).toEqual(Object.keys(TABLE_TENANCY).sort());
  });

  it("пометка в миграции совпадает с классификацией (ADR-006: -- global / -- tenant-optional)", async () => {
    for (const [table, comment] of await createdTables()) {
      const kind = TABLE_TENANCY[table as keyof typeof TABLE_TENANCY];
      // app_meta (0001, применена до соглашения) помечена словом «глобальная».
      if (kind === "global") expect(comment, table).toMatch(/-- global\b|глобальн/);
      else expect(comment, table).toContain(`-- ${kind}`);
    }
  });

  it("на каждой tenant/tenant-optional таблице включён RLS миграцией (app_enable_tenant_rls)", async () => {
    const sql = (await loadMigrations()).map((m) => m.sql).join("\n");
    const enabled = new Set([...sql.matchAll(/app_enable_tenant_rls\('([a-z_]+)'\)/g)].map((m) => m[1]));
    expect([...enabled].sort()).toEqual([...tenantTableNames()].sort());
  });

  it("глобальные: regions, users, idempotency_keys, sessions, app_meta, Telegram и профиль; tenant-optional: журналы, назначения, risk_flags, qr_scan_events, attribution_touches; tenant: media_assets, qr_points, entry_contexts, emergency_contacts, promotions, каталог (0012), favorites (0014), блок 5 (0015); глобальные admin_credentials, admin_login_failures", () => {
    expect([...tenantTableNames()].sort()).toEqual([
      "analytics_events",
      "attribution_touches",
      "audit_log_pii",
      "audit_logs",
      "categories",
      "emergency_contacts",
      "entry_contexts",
      "favorites",
      "host_modules",
      "localities",
      "media_assets",
      "moderation_cases",
      "notifications",
      "offers",
      "organizations",
      "place_badge_events",
      "place_enrichments",
      "place_media",
      "place_schedule_exceptions",
      "place_schedules",
      "place_tags",
      "places",
      "promotions",
      "qr_points",
      "qr_scan_events",
      "risk_flags",
      "role_assignments",
      "scenario_items",
      "scenarios",
      "service_request_events",
      "service_requests",
      "staff_invites",
      "tags",
      "user_plans",
    ]);
    expect(
      Object.keys(TABLE_TENANCY)
        .filter((t) => !tenantTableNames().has(t))
        .sort(),
    ).toEqual([
      "admin_credentials",
      "admin_login_failures",
      "app_meta",
      "consents",
      "feature_flag_gate_marks",
      "feature_flags",
      "google_api_usage",
      "google_photo_uris",
      "idempotency_keys",
      "messaging_consents",
      "partner_templates",
      "privacy_requests",
      "regions",
      "sessions",
      "telegram_accounts",
      "users",
    ]);
  });
});
