// Фабрики тестовых записей базовых сущностей (T1-09).
// build* — валидный объект для вставки (без БД), с переопределением полей; create* — вставка через репозиторий.
// Уникальные поля (regions.code, idempotency_keys.key) получают случайный суффикс: фабрики можно вызывать
// многократно в одной БД. Принимают Db или транзакцию (Transaction<Database> — тоже Db).
import { createHash, randomUUID } from "node:crypto";
import type {
  AnalyticsEvent,
  AuditLog,
  Db,
  IdempotencyKey,
  NewAnalyticsEvent,
  NewAuditLog,
  NewIdempotencyKey,
  NewRegion,
  NewUser,
  Region,
  User,
} from "../../src/db/index.js";
import { AnalyticsEventsRepository } from "../../src/modules/analytics/index.js";
import { AuditLogRepository } from "../../src/modules/audit/index.js";
import { IdempotencyKeysRepository } from "../../src/modules/idempotency/index.js";
import { RegionsRepository } from "../../src/modules/regions/index.js";
import { UsersRepository } from "../../src/modules/users/index.js";

/** Короткий случайный суффикс в нижнем регистре (подходит для regions.code). */
export function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildRegion(overrides: Partial<NewRegion> = {}): NewRegion {
  const suffix = uniqueSuffix();
  return {
    code: `test-${suffix}`,
    name_i18n: { uk: `Тестовий регіон ${suffix}`, en: `Test region ${suffix}` },
    status: "active",
    ...overrides,
  };
}

export function buildUser(overrides: Partial<NewUser> = {}): NewUser {
  return { status: "active", language: "uk", ...overrides };
}

/**
 * Запись аудита. По умолчанию актор — SYSTEM; если передан actor_user_id без actor_type, актор — user
 * (CHECK audit_logs_actor_consistent требует согласованности).
 */
export function buildAuditLog(overrides: Partial<NewAuditLog> = {}): NewAuditLog {
  const actorType = overrides.actor_type ?? (overrides.actor_user_id ? "user" : "system");
  return {
    action: "test.action",
    entity_type: "test_entity",
    entity_id: randomUUID(),
    new_values: { field: "value" },
    ...overrides,
    actor_type: actorType,
  };
}

export function buildIdempotencyKey(overrides: Partial<NewIdempotencyKey> = {}): NewIdempotencyKey {
  const key = overrides.key ?? randomUUID();
  return {
    scope: `user:${randomUUID()}:POST /test`,
    request_hash: sha256Hex(`body:${key}`),
    expires_at: new Date(Date.now() + DAY_MS),
    ...overrides,
    key,
  };
}

export function buildAnalyticsEvent(overrides: Partial<NewAnalyticsEvent> = {}): NewAnalyticsEvent {
  return {
    event_name: "app_opened",
    schema_version: 1,
    occurred_at: new Date(),
    properties: {},
    ...overrides,
  };
}

export function createRegion(db: Db, overrides: Partial<NewRegion> = {}): Promise<Region> {
  return new RegionsRepository(db).create(buildRegion(overrides));
}

export function createUser(db: Db, overrides: Partial<NewUser> = {}): Promise<User> {
  return new UsersRepository(db).create(buildUser(overrides));
}

export function createAuditLog(db: Db, overrides: Partial<NewAuditLog> = {}): Promise<AuditLog> {
  return new AuditLogRepository(db).append(buildAuditLog(overrides));
}

export function createIdempotencyKey(
  db: Db,
  overrides: Partial<NewIdempotencyKey> = {},
): Promise<IdempotencyKey> {
  return new IdempotencyKeysRepository(db).create(buildIdempotencyKey(overrides));
}

export function createAnalyticsEvent(
  db: Db,
  overrides: Partial<NewAnalyticsEvent> = {},
): Promise<AnalyticsEvent> {
  return new AnalyticsEventsRepository(db).insert(buildAnalyticsEvent(overrides));
}
