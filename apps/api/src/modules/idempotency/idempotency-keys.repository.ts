import { Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  currentDb,
  hasValues,
  InjectDb,
  type Db,
  type IdempotencyKey,
  type IdempotencyKeyUpdate,
  type JsonObject,
  type NewIdempotencyKey,
} from "../../db/index.js";

/** Результат захвата ключа: acquired — запись наша (in_progress), иначе — чужая запись (или undefined). */
export type ClaimResult = { acquired: true; row: IdempotencyKey } | { acquired: false; row?: IdempotencyKey };

/** Операции, нужные IdempotencyInterceptor (в unit-тестах подменяется памятью через IDEMPOTENCY_STORE). */
export interface IdempotencyStore {
  claim(input: { scope: string; key: string; requestHash: string; ttlSeconds: number }): Promise<ClaimResult>;
  complete(id: string, responseStatus: number, responseBody: JsonObject): Promise<void>;
  fail(id: string): Promise<void>;
}

/** DI-токен хранилища интерсептора; по умолчанию — IdempotencyKeysRepository. */
export const IDEMPOTENCY_STORE = Symbol("IDEMPOTENCY_STORE");

const CLAIM_ATTEMPTS = 3;

/**
 * Хранилище Idempotency-Key. Повтор, сравнение хэша тела и ответы — IdempotencyInterceptor (T1-14); здесь только
 * операции над строками. Повторный (scope, key) при create — ошибка уникальности (23505).
 * Запросы — через currentDb(): внутри withTenant() это транзакция запроса; своя db.transaction() там запрещена.
 * Интерсептор вызывает claim/complete/fail вне withTenant(): каждый запрос — отдельная автокоммит-команда,
 * поэтому захват виден параллельному запросу сразу (см. README, «Idempotency-Key»).
 */
@Injectable()
export class IdempotencyKeysRepository implements IdempotencyStore {
  constructor(@InjectDb() private readonly db: Db) {}

  create(entry: NewIdempotencyKey): Promise<IdempotencyKey> {
    return currentDb(this.db)
      .insertInto("idempotency_keys")
      .values(entry)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  findById(id: string): Promise<IdempotencyKey | undefined> {
    return currentDb(this.db)
      .selectFrom("idempotency_keys")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
  }

  find(scope: string, key: string): Promise<IdempotencyKey | undefined> {
    return currentDb(this.db)
      .selectFrom("idempotency_keys")
      .selectAll()
      .where("scope", "=", scope)
      .where("key", "=", key)
      .executeTakeFirst();
  }

  /** Пустой patch (нет полей или все undefined) ничего не меняет и возвращает текущую запись. */
  update(id: string, patch: IdempotencyKeyUpdate): Promise<IdempotencyKey | undefined> {
    if (!hasValues(patch)) return this.findById(id);
    return currentDb(this.db)
      .updateTable("idempotency_keys")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Удаляет ключи с expires_at <= now; возвращает число удалённых (для фоновой очистки). Истёкший ключ и без
   * очистки не мешает: claim() удаляет его сам. TODO: периодический вызов — задача воркера; воркер пока
   * не имеет доступа к БД/модулям api (появится вместе с первыми задачами по данным).
   */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const r = await currentDb(this.db)
      .deleteFrom("idempotency_keys")
      .where("expires_at", "<=", now)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  /**
   * Атомарно захватывает (scope, key): INSERT … ON CONFLICT DO NOTHING. Если ключ занят: истёкшая запись
   * удаляется и захват повторяется; `failed` с тем же хэшем тела переводится обратно в in_progress (повтор после
   * 5xx). Иначе возвращается занявшая запись — решение принимает decideExisting(). Конкурентные захваты одного
   * ключа сериализует уникальный индекс и блокировка строки: успешен ровно один.
   */
  async claim(input: {
    scope: string;
    key: string;
    requestHash: string;
    ttlSeconds: number;
  }): Promise<ClaimResult> {
    const db = currentDb(this.db);
    const expiresAt = sql<Date>`now() + make_interval(secs => ${input.ttlSeconds})`;
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      const inserted = await db
        .insertInto("idempotency_keys")
        .values({
          scope: input.scope,
          key: input.key,
          request_hash: input.requestHash,
          expires_at: expiresAt,
        })
        .onConflict((oc) => oc.columns(["scope", "key"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return { acquired: true, row: inserted };

      const expired = await db
        .deleteFrom("idempotency_keys")
        .where("scope", "=", input.scope)
        .where("key", "=", input.key)
        .where("expires_at", "<=", sql<Date>`now()`)
        .executeTakeFirst();
      if (Number(expired.numDeletedRows) > 0) continue;

      const retried = await db
        .updateTable("idempotency_keys")
        .set({ status: "in_progress", response_status: null, response_body: null, expires_at: expiresAt })
        .where("scope", "=", input.scope)
        .where("key", "=", input.key)
        .where("status", "=", "failed")
        .where("request_hash", "=", input.requestHash)
        .returningAll()
        .executeTakeFirst();
      if (retried) return { acquired: true, row: retried };

      const row = await this.find(input.scope, input.key);
      if (row) return { acquired: false, row };
      // Запись удалили между запросами (очистка истёкших) — пробуем снова.
    }
    return { acquired: false };
  }

  /** Сохраняет ответ захваченного ключа (in_progress → completed). */
  async complete(id: string, responseStatus: number, responseBody: JsonObject): Promise<void> {
    await currentDb(this.db)
      .updateTable("idempotency_keys")
      .set({ status: "completed", response_status: responseStatus, response_body: responseBody })
      .where("id", "=", id)
      .where("status", "=", "in_progress")
      .execute();
  }

  /** Отмечает захваченный ключ неуспешным (5xx): повтор с тем же телом снова выполнит обработчик. */
  async fail(id: string): Promise<void> {
    await currentDb(this.db)
      .updateTable("idempotency_keys")
      .set({ status: "failed" })
      .where("id", "=", id)
      .where("status", "=", "in_progress")
      .execute();
  }
}
