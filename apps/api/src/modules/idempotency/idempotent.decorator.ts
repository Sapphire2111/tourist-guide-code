import { applyDecorators, SetMetadata } from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";
import { DEFAULT_IDEMPOTENCY_TTL_SECONDS, MIN_IDEMPOTENCY_TTL_SECONDS } from "./idempotency.js";

export type IdempotentOptions = {
  /** Сколько хранится ключ и ответ (с); по умолчанию 24 ч, минимум 60 с. */
  ttlSeconds?: number;
  /**
   * Разрешить запросы без аутентифицированного актора: все такие клиенты делят одну область ключей ("anon").
   * По умолчанию false — запрос без актора отклоняется (500, ошибка конфигурации эндпоинта).
   */
  allowAnonymous?: boolean;
  /**
   * Ключ необязателен: без заголовка обработчик выполняется как обычно (без защиты от повтора), с ключом — как
   * всегда. Для эндпоинтов, где старые клиенты ключ не шлют. По умолчанию false — без ключа 400.
   */
  optional?: boolean;
};

export const IDEMPOTENT_METADATA = "tg:idempotent";

/**
 * Помечает эндпоинт (обычно финансовый POST, ТЗ §12.2): обязателен заголовок `Idempotency-Key`; повтор с тем же
 * ключом и телом возвращает сохранённый ответ без повторного вызова обработчика. Логика — IdempotencyInterceptor.
 * Ответы-ошибки эндпоинта добавьте в `@ApiErrors(…)`: IDEMPOTENCY_KEY_REQUIRED (400),
 * IDEMPOTENCY_IN_PROGRESS (409), IDEMPOTENCY_KEY_REUSED (422).
 *
 * Внешние вызовы в помеченном обработчике (платёжный провайдер и т. п.) должны передавать провайдеру свой ключ
 * идемпотентности (например, производный от Idempotency-Key): после 5xx ключ становится `failed`, повтор снова
 * вызовет обработчик — без ключа у провайдера внешний эффект повторится.
 */
export function Idempotent(options: IdempotentOptions = {}): MethodDecorator & ClassDecorator {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_IDEMPOTENCY_TTL_SECONDS)
    throw new Error(
      `@Idempotent: ttlSeconds должен быть целым >= ${MIN_IDEMPOTENCY_TTL_SECONDS}, получено ${ttlSeconds}`,
    );
  const allowAnonymous = options.allowAnonymous ?? false;
  const optional = options.optional ?? false;
  return applyDecorators(
    SetMetadata(IDEMPOTENT_METADATA, {
      ttlSeconds,
      allowAnonymous,
      optional,
    } satisfies Required<IdempotentOptions>),
    ApiHeader({
      name: "Idempotency-Key",
      required: !optional,
      description:
        "Уникальный ключ операции (UUID): повтор с тем же ключом и телом вернёт тот же ответ" +
        (optional ? "; без ключа — без защиты от повтора" : ""),
      schema: { type: "string", minLength: 1, maxLength: 255 },
    }),
  );
}
