// Tenant-контекст запроса (ADR-005): в каком регионе выполняется код. Берётся только на сервере — из
// сессии/назначения роли (T1-12) или контекста задачи воркера, никогда из параметров клиента.
// Два рубежа читают его отсюда:
//   1. TenantGuardPlugin (tenant-guard.plugin.ts) — фильтр `region_id` в запросах Kysely;
//   2. RLS в PostgreSQL (миграция 0003) — переменные `app.region_id` / `app.actor`, которые withTenant()
//      выставляет первой командой транзакции (`set_config(…, true)` = SET LOCAL, сброс при COMMIT/ROLLBACK).
import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type Transaction } from "kysely";
import type { Db } from "./database.js";
import type { Database } from "./schema.js";

/**
 * - `region` — регион-админ, сотрудник, гость в регионе, задача воркера по одному региону: видны только
 *   строки `region_id = regionId`, запись — только в этот регион.
 * - `platform` — PLATFORM-роли (SUPERADMIN): все регионы и строки с `region_id IS NULL`.
 * - `system` — фоновые задачи без региона (кросс-tenant): то же, что platform; действия — в аудит (T1-13).
 */
export type TenantContext =
  | { readonly kind: "region"; readonly regionId: string }
  | { readonly kind: "platform" }
  | { readonly kind: "system" };

export const PLATFORM_CONTEXT: TenantContext = Object.freeze({ kind: "platform" });
export const SYSTEM_CONTEXT: TenantContext = Object.freeze({ kind: "system" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Контекст региона; id проверяется (uuid) и приводится к нижнему регистру — как его отдаёт PostgreSQL. */
export function regionContext(regionId: string): TenantContext {
  if (!UUID.test(regionId)) throw new TenantContextError(`region_id контекста — не uuid: ${regionId}`);
  return Object.freeze({ kind: "region", regionId: regionId.toLowerCase() });
}

/** Ошибка tenant-изоляции: нет контекста, чужой регион в записи, неподдерживаемая форма запроса. */
export class TenantContextError extends Error {
  override readonly name = "TenantContextError";
}

export function sameTenant(a: TenantContext, b: TenantContext): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "region" || a.regionId === (b as { regionId: string }).regionId;
}

type Store = { readonly tenant: TenantContext; readonly trx: Transaction<Database> };

const storage = new AsyncLocalStorage<Store>();

/** Контекст текущего withTenant() или undefined. */
export function currentTenant(): TenantContext | undefined {
  return storage.getStore()?.tenant;
}

/**
 * Исполнитель запросов для репозитория: явно переданная транзакция — как есть, иначе транзакция текущего
 * withTenant() (в ней выставлены переменные RLS), иначе сам db. Репозитории пишут `currentDb(this.db)`.
 */
export function currentDb(db: Db): Db {
  if (db.isTransaction) return db;
  return storage.getStore()?.trx ?? db;
}

/**
 * Вызывает драйвер (tenantGuardedDialect) перед выдачей соединения: внутри withTenant() новое соединение пула
 * было бы без переменных RLS (под ролью app — пусто) и могло бы взаимно заблокироваться с транзакцией запроса
 * при исчерпании пула.
 */
export function rejectConnectionInsideTenant(): void {
  if (storage.getStore())
    throw new TenantContextError(
      "Новое соединение с БД внутри withTenant() (db.transaction(), запрос на корневом db, withSchema…): " +
        "транзакция запроса уже открыта — используйте currentDb(this.db)",
    );
}

/**
 * fn вне tenant-контекста и транзакции запроса: фоновая работа с глобальными таблицами и сетью (обновление погоды из
 * «Мій план»), которая не должна держать транзакцию региона и ходит в БД своими соединениями.
 */
export function outsideTenant<T>(fn: () => T): T {
  return storage.exit(fn);
}

/** Значения переменных сессии для RLS (политики — миграция 0003). */
export function rlsSettings(tenant: TenantContext): { regionId: string; actor: string } {
  return tenant.kind === "region"
    ? { regionId: tenant.regionId, actor: "" }
    : { regionId: "", actor: tenant.kind };
}

/**
 * Выполняет fn в транзакции с tenant-контекстом: выставляет `app.region_id`/`app.actor` на время транзакции
 * (RLS) и контекст для TenantGuardPlugin (AsyncLocalStorage), поэтому репозитории внутри fn видят только
 * свой регион. Ошибка в fn — ROLLBACK.
 *
 * Вложенный вызов с тем же контекстом переиспользует внешнюю транзакцию; с другим — ошибка (сменить регион
 * посреди транзакции нельзя: задача по нескольким регионам вызывает withTenant последовательно).
 * Если db — уже транзакция (вне withTenant), контекст выставляется в ней до её конца.
 */
export async function withTenant<T>(
  db: Db,
  tenant: TenantContext,
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (tenant.kind === "region") regionContext(tenant.regionId); // проверка uuid для объектов не из regionContext()
  const outer = storage.getStore();
  if (outer) {
    if (!sameTenant(outer.tenant, tenant))
      throw new TenantContextError("withTenant внутри withTenant с другим tenant-контекстом");
    return fn(outer.trx);
  }
  const run = async (trx: Transaction<Database>): Promise<T> => {
    const { regionId, actor } = rlsSettings(tenant);
    await sql`SELECT set_config('app.region_id', ${regionId}, true), set_config('app.actor', ${actor}, true)`.execute(
      trx,
    );
    return storage.run({ tenant, trx }, () => fn(trx));
  };
  return db.isTransaction ? run(db as Transaction<Database>) : db.transaction().execute(run);
}
