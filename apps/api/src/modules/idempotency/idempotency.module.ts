import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { IDEMPOTENCY_STORE, IdempotencyKeysRepository } from "./idempotency-keys.repository.js";
import { IdempotencyInterceptor } from "./idempotency.interceptor.js";

/**
 * Контекст idempotency (T1-14): репозиторий ключей и глобальный IdempotencyInterceptor для `@Idempotent()`.
 * Импортировать в корневой модуль РАНЬШЕ TenancyModule: глобальные интерсепторы выполняются в порядке модулей,
 * а захват ключа должен идти до транзакции запроса (см. IdempotencyInterceptor). Хранилище интерсептора —
 * токен IDEMPOTENCY_STORE (в unit-тестах — `.overrideProvider(IDEMPOTENCY_STORE)`).
 */
@Module({
  providers: [
    IdempotencyKeysRepository,
    { provide: IDEMPOTENCY_STORE, useExisting: IdempotencyKeysRepository },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IdempotencyKeysRepository],
})
export class IdempotencyModule {}
