// Наблюдаемость backend-процессов (T1-18): JSON-логи без ПДн, трекер ошибок, метрики Prometheus. ADR-0010.
export { MAX_REDACT_LENGTH, REDACTED, isSecretKey, redact, redactString } from "./redact.js";
export { currentLogContext, runWithLogContext, setLogContext, type LogContext } from "./log-context.js";
export { JsonLogger, LOG_LEVELS, type JsonLoggerOptions, type LogLevel } from "./json-logger.js";
export {
  LogErrorTracker,
  SentryErrorTracker,
  createErrorTracker,
  installProcessErrorHandlers,
  SENTRY_MAX_PENDING,
  SENTRY_TIMEOUT_MS,
  parseSentryDsn,
  type ErrorTags,
  type ErrorTracker,
  type FetchLike,
} from "./error-tracker.js";
export {
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
  type Labels,
} from "./metrics.js";
