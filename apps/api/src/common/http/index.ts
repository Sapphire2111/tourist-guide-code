// Общий HTTP-контракт API (T1-17): ошибки, correlation id, валидация, OpenAPI-описания.
export { ApiError } from "./api-error.js";
export {
  actorLogSuffix,
  correlationIdMiddleware,
  type HttpRequest,
  type HttpResponse,
} from "./correlation-id.js";
export { httpMetricsMiddleware, metricsHandler } from "./http-metrics.js";
export { ErrorEnvelopeFilter, toErrorResponse, type ErrorResponse } from "./error-envelope.filter.js";
export { securityHeadersMiddleware } from "./security-headers.js";
export { createValidationPipe, toFieldErrors } from "./validation.js";
export {
  ApiCursorPage,
  ApiErrors,
  CursorQueryDto,
  ErrorEnvelopeDto,
  FieldErrorDto,
  MoneyDto,
  SESSION_SECURITY,
} from "./openapi.js";
export { decodeIdCursor, encodeIdCursor, idPage } from "./id-cursor.js";
export {
  LocalizedDescriptionDto,
  LocalizedNameDto,
  LocalizedTextDto,
  toLocalized,
} from "./localized-text.js";
