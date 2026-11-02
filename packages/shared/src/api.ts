// Контракт HTTP API (T1-17): конверт ошибки, коды ошибок, пагинация, деньги, даты.
// Изоморфно: только типы и константы, без зависимостей от Node/DOM.

/**
 * Коды ошибок API и их HTTP-статусы. VALIDATION_FAILED — ошибки полей DTO (details.fields),
 * BAD_REQUEST — прочие ошибки запроса (битый JSON, неподдерживаемый 4xx-статус сохраняется как есть).
 * IDEMPOTENCY_* — заголовок Idempotency-Key (T1-14): нет/некорректен, повтор ключа с другим телом,
 * запрос с этим ключом ещё выполняется (повторить позже, Retry-After).
 */
export const ERROR_HTTP_STATUS = {
  VALIDATION_FAILED: 400,
  BAD_REQUEST: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  UNPROCESSABLE: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS) as ErrorCode[];

/** Ключ i18n по умолчанию для кода ошибки (тексты — в packages/i18n, T1-15). */
export const ERROR_MESSAGE_KEYS: Record<ErrorCode, string> = {
  VALIDATION_FAILED: "errors.validation",
  BAD_REQUEST: "errors.badRequest",
  IDEMPOTENCY_KEY_REQUIRED: "errors.idempotencyKeyRequired",
  UNAUTHENTICATED: "errors.unauthenticated",
  FORBIDDEN: "errors.forbidden",
  NOT_FOUND: "errors.notFound",
  CONFLICT: "errors.conflict",
  IDEMPOTENCY_IN_PROGRESS: "errors.idempotencyInProgress",
  UNPROCESSABLE: "errors.unprocessable",
  IDEMPOTENCY_KEY_REUSED: "errors.idempotencyKeyReused",
  RATE_LIMITED: "errors.rateLimited",
  INTERNAL: "errors.internal",
  BAD_GATEWAY: "errors.badGateway",
  SERVICE_UNAVAILABLE: "errors.serviceUnavailable",
  GATEWAY_TIMEOUT: "errors.gatewayTimeout",
};

/** Ошибка валидации одного поля; `field` — путь через точку (`items.0.name`). */
export type FieldError = { field: string; messageKey: string; constraint: string };

/** Единый конверт ошибки любого эндпоинта. */
export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    messageKey: string;
    details?: { fields?: FieldError[] } & Record<string, unknown>;
    correlationId: string;
  };
};

/** Заголовок correlation id: принимается от клиента и всегда возвращается в ответе. */
export const CORRELATION_ID_HEADER = "x-request-id";

/** Страница списка с курсорной пагинацией; `nextCursor: null` — страниц больше нет. */
export type CursorPage<T> = { items: T[]; nextCursor: string | null };

/**
 * Денежная сумма: целое число минимальных единиц (копейки) + код валюты ISO 4217.
 * Пример: 125,50 грн → `{ amountMinor: 12550, currency: "UAH" }`. Дробных сумм в API нет.
 */
export type Money = { amountMinor: number; currency: string };

/** Дата-время в API — строка ISO 8601 в UTC с `Z`: `2026-11-01T09:30:00.000Z`. */
export type IsoDateTime = string;
